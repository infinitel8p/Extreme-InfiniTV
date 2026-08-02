// Cross-platform background catalog-download job runner (desktop + Android).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::future::join_all;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

const PROGRESS_EVENT: &str = "xt:warmup-progress";
const KIND_DONE_EVENT: &str = "xt:warmup-kind-done";
const KIND_ERROR_EVENT: &str = "xt:warmup-kind-error";
const JOB_DONE_EVENT: &str = "xt:warmup-done";
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(150);
const MAX_REDIRECT_HOPS: usize = 5;

// ---------------------------------------------------------------------------
// Job spec (frontend -> Rust)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WarmupKind {
    Live,
    Vod,
    Series,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarmupJobSpec {
    playlist_id: String,
    force: bool,
    timeout_ms: u64,
    kinds: Vec<WarmupKindSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarmupKindSpec {
    kind: WarmupKind,
    steps: Vec<WarmupStepSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarmupStepSpec {
    name: String,
    emit_bytes: bool,
    candidates: Vec<WarmupRequestSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarmupRequestSpec {
    url: String,
    authorization: Option<String>,
    user_agent: Option<String>,
    mirror_index: u32,
}

// ---------------------------------------------------------------------------
// Status / result types (Rust -> frontend)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedFile {
    step: String,
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WarmupKindStatus {
    kind: WarmupKind,
    state: String,
    bytes: u64,
    total_bytes: u64,
    winning_mirror_index: Option<u32>,
    staged_files: Vec<StagedFile>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WarmupStatus {
    job_id: String,
    playlist_id: String,
    force: bool,
    state: String,
    kinds: Vec<WarmupKindStatus>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WarmupStartResult {
    job_id: String,
    joined: bool,
    status: WarmupStatus,
}

// ---------------------------------------------------------------------------
// Event emitter abstraction (testable without a Tauri AppHandle)
// ---------------------------------------------------------------------------

pub trait WarmupEvents: Send + Sync + 'static {
    fn progress(&self, payload: Value);
    fn kind_done(&self, payload: Value);
    fn kind_error(&self, payload: Value);
    fn job_done(&self, payload: Value);
}

impl WarmupEvents for AppHandle {
    fn progress(&self, payload: Value) {
        let _ = self.emit(PROGRESS_EVENT, payload);
    }
    fn kind_done(&self, payload: Value) {
        let _ = self.emit(KIND_DONE_EVENT, payload);
    }
    fn kind_error(&self, payload: Value) {
        let _ = self.emit(KIND_ERROR_EVENT, payload);
    }
    fn job_done(&self, payload: Value) {
        let _ = self.emit(JOB_DONE_EVENT, payload);
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct KindState {
    kind: WarmupKind,
    state: String,
    bytes: u64,
    total_bytes: u64,
    winning_mirror_index: Option<u32>,
    staged_files: Vec<StagedFile>,
    error: Option<String>,
}

impl KindState {
    fn pending(kind: WarmupKind) -> Self {
        Self {
            kind,
            state: "pending".to_string(),
            bytes: 0,
            total_bytes: 0,
            winning_mirror_index: None,
            staged_files: Vec::new(),
            error: None,
        }
    }
}

struct WarmupJob {
    job_id: String,
    playlist_id: String,
    force: bool,
    cancelled: Arc<AtomicBool>,
    staging_dir: PathBuf,
    state: Mutex<String>,
    kinds: Vec<Mutex<KindState>>,
}

#[derive(Default)]
pub struct WarmupState {
    job: Mutex<Option<Arc<WarmupJob>>>,
}

pub struct CurrentJobSnapshot {
    playlist_id: String,
    running: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum StartAction {
    Join,
    Replace,
}

// Pure so the slot decision is unit-testable without a Tauri runtime.
fn decide_start_action(
    current: Option<&CurrentJobSnapshot>,
    spec_playlist_id: &str,
    spec_force: bool,
) -> StartAction {
    match current {
        Some(snapshot)
            if snapshot.running && snapshot.playlist_id == spec_playlist_id && !spec_force =>
        {
            StartAction::Join
        }
        _ => StartAction::Replace,
    }
}

fn is_running(job: &WarmupJob) -> bool {
    *job.state.lock().unwrap_or_else(|poison| poison.into_inner()) == "running"
}

fn job_status(job: &WarmupJob) -> WarmupStatus {
    let state = job
        .state
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone();
    let kinds = job
        .kinds
        .iter()
        .map(|kind_mutex| {
            let kind_state = kind_mutex.lock().unwrap_or_else(|poison| poison.into_inner());
            WarmupKindStatus {
                kind: kind_state.kind,
                state: kind_state.state.clone(),
                bytes: kind_state.bytes,
                total_bytes: kind_state.total_bytes,
                winning_mirror_index: kind_state.winning_mirror_index,
                staged_files: kind_state.staged_files.clone(),
                error: kind_state.error.clone(),
            }
        })
        .collect();
    WarmupStatus {
        job_id: job.job_id.clone(),
        playlist_id: job.playlist_id.clone(),
        force: job.force,
        state,
        kinds,
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn warmup_start(
    app: AppHandle,
    state: State<'_, WarmupState>,
    spec: WarmupJobSpec,
) -> Result<WarmupStartResult, String> {
    let staging_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("OTHER:{error}"))?
        .join("warmup");

    let mut job_guard = state.job.lock().unwrap_or_else(|poison| poison.into_inner());
    let snapshot = job_guard.as_ref().map(|job| CurrentJobSnapshot {
        playlist_id: job.playlist_id.clone(),
        running: is_running(job),
    });

    match decide_start_action(snapshot.as_ref(), &spec.playlist_id, spec.force) {
        StartAction::Join => {
            let job = job_guard.as_ref().expect("join implies an existing job").clone();
            drop(job_guard);
            return Ok(WarmupStartResult {
                job_id: job.job_id.clone(),
                joined: true,
                status: job_status(&job),
            });
        }
        StartAction::Replace => {}
    }

    let previous_job_id = job_guard.as_ref().map(|job| job.job_id.clone());
    if let Some(previous_job) = job_guard.as_ref() {
        previous_job.cancelled.store(true, Ordering::SeqCst);
    }

    let job_id = generate_job_id();
    let staging_dir = staging_root.join(&job_id);
    let keep_ids: Vec<&str> = match &previous_job_id {
        Some(previous) => vec![previous.as_str(), job_id.as_str()],
        None => vec![job_id.as_str()],
    };
    // A finished-but-unacked job survives one more generation, then gets reaped here.
    sweep_foreign_staging_dirs(&staging_root, &keep_ids);
    std::fs::create_dir_all(&staging_dir).map_err(|error| format!("OTHER:{error}"))?;

    let kinds_state: Vec<Mutex<KindState>> = spec
        .kinds
        .iter()
        .map(|kind_spec| Mutex::new(KindState::pending(kind_spec.kind)))
        .collect();

    let job = Arc::new(WarmupJob {
        job_id: job_id.clone(),
        playlist_id: spec.playlist_id.clone(),
        force: spec.force,
        cancelled: Arc::new(AtomicBool::new(false)),
        staging_dir,
        state: Mutex::new("running".to_string()),
        kinds: kinds_state,
    });
    *job_guard = Some(job.clone());
    drop(job_guard);

    let events: Arc<dyn WarmupEvents> = Arc::new(app);
    tauri::async_runtime::spawn(run_job(job.clone(), spec, events));

    Ok(WarmupStartResult {
        job_id,
        joined: false,
        status: job_status(&job),
    })
}

fn current_status(state: &WarmupState) -> Option<WarmupStatus> {
    let job_guard = state.job.lock().unwrap_or_else(|poison| poison.into_inner());
    job_guard.as_ref().map(|job| job_status(job))
}

#[tauri::command]
pub fn warmup_status(state: State<'_, WarmupState>) -> Result<Option<WarmupStatus>, String> {
    Ok(current_status(&state))
}

fn cancel_job(state: &WarmupState, job_id: Option<&str>) -> Result<(), String> {
    let job_guard = state.job.lock().unwrap_or_else(|poison| poison.into_inner());
    match job_guard.as_ref() {
        Some(job) => {
            if let Some(expected_id) = job_id {
                if expected_id != job.job_id {
                    return Err("NOT_FOUND:job".to_string());
                }
            }
            job.cancelled.store(true, Ordering::SeqCst);
            Ok(())
        }
        None => {
            if job_id.is_some() {
                Err("NOT_FOUND:job".to_string())
            } else {
                Ok(())
            }
        }
    }
}

#[tauri::command]
pub fn warmup_cancel(state: State<'_, WarmupState>, job_id: Option<String>) -> Result<(), String> {
    cancel_job(&state, job_id.as_deref())
}

fn ack_kind(state: &WarmupState, job_id: &str, kind: WarmupKind) -> Result<(), String> {
    let job_guard = state.job.lock().unwrap_or_else(|poison| poison.into_inner());
    let Some(job) = job_guard.as_ref() else {
        return Err("NOT_FOUND:job".to_string());
    };
    if job.job_id != job_id {
        return Err("NOT_FOUND:job".to_string());
    }
    let Some(kind_mutex) = job.kinds.iter().find(|kind_lock| {
        kind_lock.lock().unwrap_or_else(|poison| poison.into_inner()).kind == kind
    }) else {
        return Err("NOT_FOUND:kind".to_string());
    };
    let mut kind_state = kind_mutex.lock().unwrap_or_else(|poison| poison.into_inner());
    delete_staged_files(&kind_state.staged_files);
    kind_state.staged_files.clear();
    kind_state.state = "ingested".to_string();
    Ok(())
}

#[tauri::command]
pub fn warmup_ack(state: State<'_, WarmupState>, job_id: String, kind: WarmupKind) -> Result<(), String> {
    ack_kind(&state, &job_id, kind)
}

fn staged_path(
    state: &WarmupState,
    job_id: &str,
    kind: WarmupKind,
    step: &str,
) -> Result<String, String> {
    let job_guard = state.job.lock().unwrap_or_else(|poison| poison.into_inner());
    let Some(job) = job_guard.as_ref() else {
        return Err("NOT_FOUND:job".to_string());
    };
    if job.job_id != job_id {
        return Err("NOT_FOUND:job".to_string());
    }
    let Some(kind_mutex) = job.kinds.iter().find(|kind_lock| {
        kind_lock
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .kind
            == kind
    }) else {
        return Err("NOT_FOUND:kind".to_string());
    };
    let kind_state = kind_mutex.lock().unwrap_or_else(|poison| poison.into_inner());
    kind_state
        .staged_files
        .iter()
        .find(|file| file.step == step)
        .map(|file| file.path.clone())
        .ok_or_else(|| "NOT_FOUND:step".to_string())
}

// Keeps staged reads off plugin-fs, whose scope check stalls the Android main thread.
#[tauri::command]
pub fn warmup_read_staged(
    state: State<'_, WarmupState>,
    job_id: String,
    kind: WarmupKind,
    step: String,
) -> Result<String, String> {
    let path = staged_path(&state, &job_id, kind, &step)?;
    std::fs::read_to_string(&path).map_err(|error| format!("OTHER:{error}"))
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

pub fn sweep_stale_staging(app: &AppHandle) {
    let Ok(app_data_dir) = app.path().app_data_dir() else {
        return;
    };
    let warmup_dir = app_data_dir.join("warmup");
    if let Err(error) = std::fs::remove_dir_all(&warmup_dir) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log::warn!("[warmup] failed to sweep stale staging dir: {error}");
        }
    }
}

fn sweep_foreign_staging_dirs(staging_root: &Path, keep_ids: &[&str]) {
    let Ok(entries) = std::fs::read_dir(staging_root) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if keep_ids.contains(&name) {
            continue;
        }
        if let Err(error) = std::fs::remove_dir_all(&path) {
            log::warn!("[warmup] failed to sweep stale staging subdir: {error}");
        }
    }
}

fn generate_job_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn staged_file_name(kind: WarmupKind, step_name: &str) -> String {
    let kind_str = match kind {
        WarmupKind::Live => "live",
        WarmupKind::Vod => "vod",
        WarmupKind::Series => "series",
    };
    let sanitized_step: String = step_name
        .chars()
        .map(|character| {
            let lower = character.to_ascii_lowercase();
            if lower.is_ascii_alphanumeric() || lower == '-' {
                lower
            } else {
                '-'
            }
        })
        .collect();
    format!("{kind_str}-{sanitized_step}.dat")
}

fn delete_staged_files(files: &[StagedFile]) {
    for file in files {
        if let Err(error) = std::fs::remove_file(&file.path) {
            log::warn!("[warmup] failed to remove staged file: {error}");
        }
    }
}

// ---------------------------------------------------------------------------
// HTTP (redirect handling duplicated from audio_proxy.rs: desktop-only, can't import)
// ---------------------------------------------------------------------------

fn build_http_client(timeout_ms: u64) -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_millis(timeout_ms))
        .read_timeout(Duration::from_millis(timeout_ms))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn is_same_origin(original_url: &str, candidate_url: &str) -> bool {
    let Ok(original) = reqwest::Url::parse(original_url) else {
        return false;
    };
    let Ok(candidate) = reqwest::Url::parse(candidate_url) else {
        return false;
    };
    original.scheme() == candidate.scheme()
        && original.host_str() == candidate.host_str()
        && original.port_or_known_default() == candidate.port_or_known_default()
}

async fn fetch_following_redirects(
    client: &reqwest::Client,
    url: &str,
    user_agent: Option<&str>,
    authorization: Option<&str>,
) -> reqwest::Result<reqwest::Response> {
    let mut current_url = url.to_string();
    let mut hops = 0;
    loop {
        let mut request = client.get(&current_url);
        if let Some(user_agent) = user_agent {
            request = request.header(reqwest::header::USER_AGENT, user_agent);
        }
        if let Some(authorization) = authorization {
            if is_same_origin(url, &current_url) {
                request = request.header(reqwest::header::AUTHORIZATION, authorization);
            }
        }
        let response = request.send().await?;
        if !response.status().is_redirection() || hops >= MAX_REDIRECT_HOPS {
            return Ok(response);
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let Some(location) = location else {
            return Ok(response);
        };
        let next_url = reqwest::Url::parse(&current_url).and_then(|base| base.join(&location));
        match next_url {
            Ok(resolved) => {
                current_url = resolved.into();
                hops += 1;
            }
            Err(_) => return Ok(response),
        }
    }
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

async fn run_job(job: Arc<WarmupJob>, spec: WarmupJobSpec, events: Arc<dyn WarmupEvents>) {
    let client = build_http_client(spec.timeout_ms);
    let kind_futures = spec.kinds.into_iter().enumerate().map(|(kind_index, kind_spec)| {
        run_kind(job.clone(), kind_spec, kind_index, client.clone(), events.clone())
    });
    join_all(kind_futures).await;

    if job.cancelled.load(Ordering::SeqCst) {
        {
            let mut job_state = job.state.lock().unwrap_or_else(|poison| poison.into_inner());
            *job_state = "cancelled".to_string();
        }
        let _ = std::fs::remove_dir_all(&job.staging_dir);
        return;
    }

    {
        let mut job_state = job.state.lock().unwrap_or_else(|poison| poison.into_inner());
        *job_state = "done".to_string();
    }
    events.job_done(build_job_done_payload(&job.job_id, &job.playlist_id));
}

async fn run_kind(
    job: Arc<WarmupJob>,
    kind_spec: WarmupKindSpec,
    kind_index: usize,
    client: reqwest::Client,
    events: Arc<dyn WarmupEvents>,
) {
    set_kind_state(&job, kind_index, "downloading");

    let max_slots = kind_spec.steps.iter().map(|step| step.candidates.len()).max().unwrap_or(0);
    let mut last_error: Option<String> = None;
    let mut winner: Option<(u32, Vec<StagedFile>)> = None;

    'slot: for slot in 0..max_slots {
        if job.cancelled.load(Ordering::SeqCst) {
            return;
        }
        let mut staged_this_slot: Vec<StagedFile> = Vec::new();
        let mut mirror_index_this_slot: Option<u32> = None;
        for step in &kind_spec.steps {
            let Some(candidate) = step.candidates.get(slot) else {
                // A step out of candidates at this slot means the whole set is exhausted.
                break 'slot;
            };
            if mirror_index_this_slot.is_none() {
                mirror_index_this_slot = Some(candidate.mirror_index);
            }
            match download_step(&job, kind_spec.kind, kind_index, step, candidate, &client, &events).await {
                Ok(staged_file) => staged_this_slot.push(staged_file),
                Err(error) => {
                    delete_staged_files(&staged_this_slot);
                    if job.cancelled.load(Ordering::SeqCst) {
                        return;
                    }
                    last_error = Some(error);
                    continue 'slot;
                }
            }
        }
        winner = Some((mirror_index_this_slot.unwrap_or(0), staged_this_slot));
        break;
    }

    if job.cancelled.load(Ordering::SeqCst) {
        return;
    }

    match winner {
        Some((mirror_index, staged_files)) => {
            let payload = build_kind_done_payload(
                &job.job_id,
                &job.playlist_id,
                kind_spec.kind,
                mirror_index,
                &staged_files,
            );
            set_kind_done(&job, kind_index, mirror_index, staged_files);
            events.kind_done(payload);
        }
        None => {
            let error_message = last_error.unwrap_or_else(|| "OTHER:no candidates available".to_string());
            set_kind_error(&job, kind_index, error_message.clone());
            events.kind_error(build_kind_error_payload(
                &job.job_id,
                &job.playlist_id,
                kind_spec.kind,
                &error_message,
            ));
        }
    }
}

async fn download_step(
    job: &Arc<WarmupJob>,
    kind: WarmupKind,
    kind_index: usize,
    step: &WarmupStepSpec,
    candidate: &WarmupRequestSpec,
    client: &reqwest::Client,
    events: &Arc<dyn WarmupEvents>,
) -> Result<StagedFile, String> {
    let response = fetch_following_redirects(
        client,
        &candidate.url,
        candidate.user_agent.as_deref(),
        candidate.authorization.as_deref(),
    )
    .await
    .map_err(|error| format!("OTHER:{}", error.without_url()))?;

    if !response.status().is_success() {
        return Err(format!("OTHER:upstream status {}", response.status().as_u16()));
    }

    let file_name = staged_file_name(kind, &step.name);
    let file_path = job.staging_dir.join(&file_name);
    let file = std::fs::File::create(&file_path).map_err(|error| format!("OTHER:{error}"))?;
    let mut writer = std::io::BufWriter::new(file);

    let stream_result = stream_step_body(job, kind, kind_index, step, &mut writer, response, events).await;

    match stream_result {
        Ok(bytes_written) => {
            if let Err(error) = writer.flush() {
                let _ = std::fs::remove_file(&file_path);
                return Err(format!("OTHER:{error}"));
            }
            if bytes_written == 0 {
                let _ = std::fs::remove_file(&file_path);
                return Err("OTHER:upstream sent no data".to_string());
            }
            Ok(StagedFile {
                step: step.name.clone(),
                path: file_path.to_string_lossy().into_owned(),
            })
        }
        Err(error) => {
            let _ = std::fs::remove_file(&file_path);
            Err(error)
        }
    }
}

async fn stream_step_body(
    job: &Arc<WarmupJob>,
    kind: WarmupKind,
    kind_index: usize,
    step: &WarmupStepSpec,
    writer: &mut std::io::BufWriter<std::fs::File>,
    response: reqwest::Response,
    events: &Arc<dyn WarmupEvents>,
) -> Result<u64, String> {
    let total_bytes = response.content_length().unwrap_or(0);
    let mut bytes_written: u64 = 0;
    let mut last_emit = Instant::now();
    let mut byte_stream = response.bytes_stream();
    while let Some(chunk) = byte_stream.next().await {
        if job.cancelled.load(Ordering::SeqCst) {
            return Err("OTHER:cancelled".to_string());
        }
        let chunk = chunk.map_err(|error| format!("OTHER:{}", error.without_url()))?;
        writer.write_all(&chunk).map_err(|error| format!("OTHER:{error}"))?;
        bytes_written += chunk.len() as u64;

        if step.emit_bytes {
            update_kind_bytes(job, kind_index, bytes_written, total_bytes);
            let now = Instant::now();
            if should_emit_progress(last_emit, now) {
                events.progress(build_progress_payload(
                    &job.job_id,
                    &job.playlist_id,
                    kind,
                    bytes_written,
                    total_bytes,
                ));
                last_emit = now;
            }
        }
    }
    Ok(bytes_written)
}

fn should_emit_progress(last_emit: Instant, now: Instant) -> bool {
    now.duration_since(last_emit) >= PROGRESS_EMIT_INTERVAL
}

fn set_kind_state(job: &WarmupJob, kind_index: usize, state: &str) {
    let mut kind_state = job.kinds[kind_index].lock().unwrap_or_else(|poison| poison.into_inner());
    kind_state.state = state.to_string();
}

fn update_kind_bytes(job: &WarmupJob, kind_index: usize, bytes: u64, total_bytes: u64) {
    let mut kind_state = job.kinds[kind_index].lock().unwrap_or_else(|poison| poison.into_inner());
    kind_state.bytes = bytes;
    kind_state.total_bytes = total_bytes;
}

fn set_kind_done(job: &WarmupJob, kind_index: usize, mirror_index: u32, staged_files: Vec<StagedFile>) {
    let mut kind_state = job.kinds[kind_index].lock().unwrap_or_else(|poison| poison.into_inner());
    kind_state.state = "done".to_string();
    kind_state.winning_mirror_index = Some(mirror_index);
    kind_state.staged_files = staged_files;
}

fn set_kind_error(job: &WarmupJob, kind_index: usize, error: String) {
    let mut kind_state = job.kinds[kind_index].lock().unwrap_or_else(|poison| poison.into_inner());
    kind_state.state = "error".to_string();
    kind_state.error = Some(error);
}

// ---------------------------------------------------------------------------
// Event payload builders (pure, unit-tested)
// ---------------------------------------------------------------------------

fn build_progress_payload(job_id: &str, playlist_id: &str, kind: WarmupKind, bytes: u64, total_bytes: u64) -> Value {
    json!({
        "jobId": job_id,
        "playlistId": playlist_id,
        "kind": kind,
        "bytes": bytes,
        "totalBytes": total_bytes,
    })
}

fn build_kind_done_payload(
    job_id: &str,
    playlist_id: &str,
    kind: WarmupKind,
    winning_mirror_index: u32,
    staged_files: &[StagedFile],
) -> Value {
    json!({
        "jobId": job_id,
        "playlistId": playlist_id,
        "kind": kind,
        "winningMirrorIndex": winning_mirror_index,
        "stagedFiles": staged_files,
    })
}

fn build_kind_error_payload(job_id: &str, playlist_id: &str, kind: WarmupKind, error: &str) -> Value {
    json!({
        "jobId": job_id,
        "playlistId": playlist_id,
        "kind": kind,
        "error": error,
    })
}

fn build_job_done_payload(job_id: &str, playlist_id: &str) -> Value {
    json!({
        "jobId": job_id,
        "playlistId": playlist_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_deserializes_camel_case_payload() {
        let payload = json!({
            "playlistId": "pl-1",
            "force": false,
            "timeoutMs": 8000,
            "kinds": [
                {
                    "kind": "live",
                    "steps": [
                        {
                            "name": "catalog",
                            "emitBytes": true,
                            "candidates": [
                                { "url": "https://a.test/player_api.php", "authorization": "Basic xyz", "userAgent": "Xtream/1", "mirrorIndex": 0 },
                                { "url": "https://b.test/player_api.php", "authorization": null, "userAgent": null, "mirrorIndex": 1 }
                            ]
                        },
                        {
                            "name": "streams",
                            "emitBytes": false,
                            "candidates": [
                                { "url": "https://a.test/streams.php", "authorization": null, "userAgent": null, "mirrorIndex": 0 },
                                { "url": "https://b.test/streams.php", "authorization": null, "userAgent": null, "mirrorIndex": 1 }
                            ]
                        }
                    ]
                },
                {
                    "kind": "vod",
                    "steps": [
                        {
                            "name": "catalog",
                            "emitBytes": true,
                            "candidates": [
                                { "url": "https://a.test/vod.php", "authorization": null, "userAgent": null, "mirrorIndex": 0 }
                            ]
                        }
                    ]
                }
            ]
        });

        let spec: WarmupJobSpec = serde_json::from_value(payload).expect("spec must deserialize");
        assert_eq!(spec.playlist_id, "pl-1");
        assert_eq!(spec.timeout_ms, 8000);
        assert_eq!(spec.kinds.len(), 2);
        assert_eq!(spec.kinds[0].kind, WarmupKind::Live);
        assert_eq!(spec.kinds[0].steps.len(), 2);
        assert_eq!(spec.kinds[0].steps[0].candidates.len(), 2);
        assert_eq!(spec.kinds[0].steps[0].candidates[0].mirror_index, 0);
        assert_eq!(spec.kinds[1].kind, WarmupKind::Vod);
    }

    #[test]
    fn spec_rejects_unknown_kind() {
        let payload = json!({
            "playlistId": "pl-1",
            "force": false,
            "timeoutMs": 8000,
            "kinds": [
                { "kind": "m3u", "steps": [] }
            ]
        });
        let result: Result<WarmupJobSpec, _> = serde_json::from_value(payload);
        assert!(result.is_err());
    }

    #[test]
    fn decide_start_action_joins_running_same_playlist_without_force() {
        let current = CurrentJobSnapshot { playlist_id: "pl-1".to_string(), running: true };
        assert_eq!(decide_start_action(Some(&current), "pl-1", false), StartAction::Join);
    }

    #[test]
    fn decide_start_action_replaces_on_force() {
        let current = CurrentJobSnapshot { playlist_id: "pl-1".to_string(), running: true };
        assert_eq!(decide_start_action(Some(&current), "pl-1", true), StartAction::Replace);
    }

    #[test]
    fn decide_start_action_replaces_for_different_playlist() {
        let current = CurrentJobSnapshot { playlist_id: "pl-1".to_string(), running: true };
        assert_eq!(decide_start_action(Some(&current), "pl-2", false), StartAction::Replace);
    }

    #[test]
    fn decide_start_action_replaces_terminal_job() {
        let current = CurrentJobSnapshot { playlist_id: "pl-1".to_string(), running: false };
        assert_eq!(decide_start_action(Some(&current), "pl-1", false), StartAction::Replace);
    }

    #[test]
    fn decide_start_action_replaces_empty_slot() {
        assert_eq!(decide_start_action(None, "pl-1", false), StartAction::Replace);
    }

    #[test]
    fn is_same_origin_keeps_authorization_on_a_same_origin_redirect() {
        assert!(is_same_origin(
            "https://provider.test/live/user/pass/1.ts",
            "https://provider.test/edge/live/user/pass/1.ts"
        ));
    }

    #[test]
    fn is_same_origin_drops_authorization_for_a_different_host() {
        assert!(!is_same_origin("https://provider.test/live/1.ts", "https://attacker.test/live/1.ts"));
    }

    #[test]
    fn is_same_origin_drops_authorization_for_a_different_port() {
        assert!(!is_same_origin(
            "http://provider.test:8080/live/1.ts",
            "http://provider.test:8081/live/1.ts"
        ));
    }

    #[test]
    fn is_same_origin_drops_authorization_for_a_different_scheme() {
        assert!(!is_same_origin("https://provider.test/live/1.ts", "http://provider.test/live/1.ts"));
    }

    #[test]
    fn is_same_origin_drops_authorization_when_http_upgrades_to_https_on_the_same_host() {
        assert!(!is_same_origin("http://provider.test/live/1.ts", "https://provider.test/live/1.ts"));
    }

    #[test]
    fn is_same_origin_normalizes_explicit_default_ports() {
        assert!(is_same_origin("https://provider.test/live/1.ts", "https://provider.test:443/live/1.ts"));
        assert!(is_same_origin("http://provider.test:80/live/1.ts", "http://provider.test/live/1.ts"));
    }

    #[test]
    fn is_same_origin_drops_authorization_for_an_unparseable_url() {
        assert!(!is_same_origin("https://provider.test/live/1.ts", "not a url"));
    }

    #[test]
    fn staged_file_name_is_stable_and_sanitized() {
        assert_eq!(staged_file_name(WarmupKind::Live, "catalog"), "live-catalog.dat");
        assert_eq!(staged_file_name(WarmupKind::Vod, "Player API!"), "vod-player-api-.dat");
    }

    #[test]
    fn should_emit_progress_throttles_within_interval() {
        let base = Instant::now();
        assert!(!should_emit_progress(base, base));
        assert!(!should_emit_progress(base, base + Duration::from_millis(50)));
        assert!(should_emit_progress(base, base + Duration::from_millis(200)));
    }

    #[test]
    fn build_progress_payload_uses_camel_case_keys() {
        let payload = build_progress_payload("job-1", "pl-1", WarmupKind::Vod, 100, 200);
        assert_eq!(payload["jobId"], "job-1");
        assert_eq!(payload["playlistId"], "pl-1");
        assert_eq!(payload["kind"], "vod");
        assert_eq!(payload["bytes"], 100);
        assert_eq!(payload["totalBytes"], 200);
    }

    #[test]
    fn build_kind_done_payload_uses_camel_case_keys() {
        let staged_files = vec![StagedFile { step: "catalog".to_string(), path: "/tmp/vod-catalog.dat".to_string() }];
        let payload = build_kind_done_payload("job-1", "pl-1", WarmupKind::Series, 2, &staged_files);
        assert_eq!(payload["jobId"], "job-1");
        assert_eq!(payload["playlistId"], "pl-1");
        assert_eq!(payload["kind"], "series");
        assert_eq!(payload["winningMirrorIndex"], 2);
        assert_eq!(payload["stagedFiles"][0]["step"], "catalog");
        assert_eq!(payload["stagedFiles"][0]["path"], "/tmp/vod-catalog.dat");
    }

    #[test]
    fn build_kind_error_payload_uses_camel_case_keys() {
        let payload = build_kind_error_payload("job-1", "pl-1", WarmupKind::Live, "OTHER:boom");
        assert_eq!(payload["jobId"], "job-1");
        assert_eq!(payload["playlistId"], "pl-1");
        assert_eq!(payload["kind"], "live");
        assert_eq!(payload["error"], "OTHER:boom");
    }

    #[test]
    fn build_job_done_payload_uses_camel_case_keys() {
        let payload = build_job_done_payload("job-1", "pl-1");
        assert_eq!(payload["jobId"], "job-1");
        assert_eq!(payload["playlistId"], "pl-1");
    }

    #[test]
    fn delete_staged_files_removes_every_listed_file() {
        let dir = std::env::temp_dir().join(format!("xt-warmup-test-{}", generate_job_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file_a = dir.join("a.dat");
        let file_b = dir.join("b.dat");
        std::fs::write(&file_a, b"a").unwrap();
        std::fs::write(&file_b, b"b").unwrap();
        let staged = vec![
            StagedFile { step: "a".to_string(), path: file_a.to_string_lossy().into_owned() },
            StagedFile { step: "b".to_string(), path: file_b.to_string_lossy().into_owned() },
        ];

        delete_staged_files(&staged);

        assert!(!file_a.exists());
        assert!(!file_b.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ack_kind_deletes_staged_files_and_marks_the_kind_ingested() {
        let dir = std::env::temp_dir().join(format!("xt-warmup-ack-{}", generate_job_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let staged_path = dir.join("vod-catalog.dat");
        std::fs::write(&staged_path, b"data").unwrap();

        let mut kind_state = KindState::pending(WarmupKind::Vod);
        kind_state.state = "done".to_string();
        kind_state.staged_files =
            vec![StagedFile { step: "catalog".to_string(), path: staged_path.to_string_lossy().into_owned() }];

        let job = Arc::new(WarmupJob {
            job_id: "job-1".to_string(),
            playlist_id: "pl-1".to_string(),
            force: false,
            cancelled: Arc::new(AtomicBool::new(false)),
            staging_dir: dir.clone(),
            state: Mutex::new("done".to_string()),
            kinds: vec![Mutex::new(kind_state)],
        });
        let state = WarmupState { job: Mutex::new(Some(job)) };

        ack_kind(&state, "job-1", WarmupKind::Vod).expect("ack must succeed");

        assert!(!staged_path.exists());
        let status = current_status(&state).expect("status must exist");
        assert_eq!(status.kinds[0].state, "ingested");
        assert!(status.kinds[0].staged_files.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ack_kind_rejects_a_mismatched_job_id() {
        let job = Arc::new(WarmupJob {
            job_id: "job-1".to_string(),
            playlist_id: "pl-1".to_string(),
            force: false,
            cancelled: Arc::new(AtomicBool::new(false)),
            staging_dir: std::env::temp_dir(),
            state: Mutex::new("done".to_string()),
            kinds: vec![Mutex::new(KindState::pending(WarmupKind::Live))],
        });
        let state = WarmupState { job: Mutex::new(Some(job)) };

        let result = ack_kind(&state, "job-2", WarmupKind::Live);
        assert_eq!(result, Err("NOT_FOUND:job".to_string()));
    }

    #[test]
    fn ack_kind_rejects_an_unknown_kind() {
        let job = Arc::new(WarmupJob {
            job_id: "job-1".to_string(),
            playlist_id: "pl-1".to_string(),
            force: false,
            cancelled: Arc::new(AtomicBool::new(false)),
            staging_dir: std::env::temp_dir(),
            state: Mutex::new("done".to_string()),
            kinds: vec![Mutex::new(KindState::pending(WarmupKind::Live))],
        });
        let state = WarmupState { job: Mutex::new(Some(job)) };

        let result = ack_kind(&state, "job-1", WarmupKind::Vod);
        assert_eq!(result, Err("NOT_FOUND:kind".to_string()));
    }

    #[test]
    fn cancel_job_without_id_cancels_whatever_is_running() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let job = Arc::new(WarmupJob {
            job_id: "job-1".to_string(),
            playlist_id: "pl-1".to_string(),
            force: false,
            cancelled: cancelled.clone(),
            staging_dir: std::env::temp_dir(),
            state: Mutex::new("running".to_string()),
            kinds: Vec::new(),
        });
        let state = WarmupState { job: Mutex::new(Some(job)) };

        cancel_job(&state, None).expect("cancel must succeed");
        assert!(cancelled.load(Ordering::SeqCst));
    }

    #[test]
    fn cancel_job_with_a_mismatched_id_fails() {
        let job = Arc::new(WarmupJob {
            job_id: "job-1".to_string(),
            playlist_id: "pl-1".to_string(),
            force: false,
            cancelled: Arc::new(AtomicBool::new(false)),
            staging_dir: std::env::temp_dir(),
            state: Mutex::new("running".to_string()),
            kinds: Vec::new(),
        });
        let state = WarmupState { job: Mutex::new(Some(job)) };

        let result = cancel_job(&state, Some("job-2"));
        assert_eq!(result, Err("NOT_FOUND:job".to_string()));
    }

    #[test]
    fn cancel_job_with_an_id_but_empty_slot_fails() {
        let state = WarmupState::default();
        let result = cancel_job(&state, Some("job-1"));
        assert_eq!(result, Err("NOT_FOUND:job".to_string()));
    }

    #[test]
    fn cancel_job_without_id_and_empty_slot_is_a_no_op() {
        let state = WarmupState::default();
        assert!(cancel_job(&state, None).is_ok());
    }
}
