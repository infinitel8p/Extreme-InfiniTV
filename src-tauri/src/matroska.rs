// Pure Matroska/WebM push-parser: head parse from a byte prefix, cue scanning from arbitrary chunks.

use std::collections::HashMap;

// ---------------------------------------------------------------------------
// EBML primitives
// ---------------------------------------------------------------------------

/// A first byte of 0x00 is structurally invalid, not "need more bytes": resyncing callers must not retry it.
enum VintRead {
    Value(u64, usize),
    NeedMore,
    Invalid,
}

fn read_vint(bytes: &[u8], strip_marker: bool) -> VintRead {
    let Some(&first) = bytes.first() else {
        return VintRead::NeedMore;
    };
    if first == 0 {
        return VintRead::Invalid;
    }
    let width = first.leading_zeros() as usize + 1;
    if bytes.len() < width {
        return VintRead::NeedMore;
    }
    let mut value = if strip_marker {
        let marker_bit = 0x80u8 >> (width - 1);
        (first & !marker_bit) as u64
    } else {
        first as u64
    };
    for &byte in &bytes[1..width] {
        value = (value << 8) | byte as u64;
    }
    VintRead::Value(value, width)
}

/// Reads a vint, stripping the marker bit. Returns `(value, width)`.
fn read_vint_raw(bytes: &[u8]) -> Option<(u64, usize)> {
    match read_vint(bytes, true) {
        VintRead::Value(value, width) => Some((value, width)),
        VintRead::NeedMore | VintRead::Invalid => None,
    }
}

/// Reads an element ID, keeping the marker bit (IDs are compared as raw bytes).
fn read_element_id(bytes: &[u8]) -> Option<(u64, usize)> {
    match read_vint(bytes, false) {
        VintRead::Value(value, width) => Some((value, width)),
        VintRead::NeedMore | VintRead::Invalid => None,
    }
}

/// Reads an element size. `None` inner value means "unknown size" (all value bits set).
fn read_vint_size(bytes: &[u8]) -> Option<(Option<u64>, usize)> {
    let (value, width) = read_vint_raw(bytes)?;
    let all_ones = value == (1u64 << (7 * width)) - 1;
    Some((if all_ones { None } else { Some(value) }, width))
}

fn read_uint(bytes: &[u8]) -> u64 {
    let mut value: u64 = 0;
    for &byte in bytes {
        value = (value << 8) | byte as u64;
    }
    value
}

const ID_EBML: u64 = 0x1A45DFA3;
const ID_SEGMENT: u64 = 0x18538067;
#[allow(dead_code)]
const ID_SEEK_HEAD: u64 = 0x114D9B74;
const ID_VOID: u64 = 0xEC;
const ID_INFO: u64 = 0x1549A966;
const ID_TIMESTAMP_SCALE: u64 = 0x2AD7B1;
const ID_TRACKS: u64 = 0x1654AE6B;
const ID_TRACK_ENTRY: u64 = 0xAE;
const ID_TRACK_NUMBER: u64 = 0xD7;
const ID_TRACK_TYPE: u64 = 0x83;
const ID_CODEC_ID: u64 = 0x86;
const ID_LANGUAGE: u64 = 0x22B59C;
const ID_LANGUAGE_BCP47: u64 = 0x22B59D;
const ID_NAME: u64 = 0x536E;
const ID_FLAG_DEFAULT: u64 = 0x88;
const ID_CLUSTER: u64 = 0x1F43B675;
const ID_CLUSTER_TIMESTAMP: u64 = 0xE7;
const ID_SIMPLE_BLOCK: u64 = 0xA3;
const ID_BLOCK_GROUP: u64 = 0xA0;
const ID_BLOCK: u64 = 0xA1;
const ID_BLOCK_DURATION: u64 = 0x9B;
#[allow(dead_code)]
const ID_CUES: u64 = 0x1C53BB6B;
const ID_CRC32: u64 = 0xBF;
const ID_SILENT_TRACKS: u64 = 0x5854;

#[cfg(test)]
const TRACK_TYPE_SUBTITLE: u8 = 0x11;
const CLUSTER_ID_BYTES: [u8; 4] = [0x1F, 0x43, 0xB6, 0x75];
const MAX_CLUSTER_SIZE: u64 = 256 * 1024 * 1024;
const MAX_BLOCK_GROUP_SIZE: u64 = 256 * 1024;
const MAX_SIMPLE_BLOCK_SIZE: u64 = 256 * 1024;
// A real Matroska timestamp is a 1-8 byte uint; this only guards against a malformed/hostile size.
const MAX_TIMESTAMP_SIZE: u64 = 16;
const BLOCK_GROUP_PROBE_CAP: usize = 32;
const MAX_TRACK_TEXT_LEN: usize = 200;
const DEFAULT_CUE_DURATION_MS: u64 = 3000;

fn ticks_to_ms(ticks: u64, timestamp_scale_ns: u64) -> u64 {
    ((ticks as u128) * (timestamp_scale_ns as u128) / 1_000_000u128) as u64
}

// ---------------------------------------------------------------------------
// Head parse (EBML header + Segment Info/Tracks)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct MkvTrack {
    pub number: u64,
    pub track_type: u8,
    pub codec: String,
    pub language: Option<String>,
    pub name: Option<String>,
    pub default: bool,
}

#[derive(Debug, Clone)]
pub struct HeadInfo {
    pub timestamp_scale_ns: u64,
    pub tracks: Vec<MkvTrack>,
}

/// File-controlled track metadata reaches the frontend as-is, so sanitize it inside the parser.
fn sanitize_track_text(text: String) -> String {
    text.chars()
        .filter(|ch| !ch.is_control())
        .take(MAX_TRACK_TEXT_LEN)
        .collect()
}

fn latin1_string(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes)
        .trim_end_matches('\0')
        .to_string();
    sanitize_track_text(text)
}

fn parse_info(bytes: &[u8]) -> Option<u64> {
    let mut pos = 0;
    let mut scale = None;
    while pos < bytes.len() {
        let (id, id_width) = read_element_id(&bytes[pos..])?;
        pos += id_width;
        let (size_opt, size_width) = read_vint_size(&bytes[pos..])?;
        pos += size_width;
        let size = size_opt.unwrap_or_else(|| (bytes.len() - pos) as u64) as usize;
        let end = (pos + size).min(bytes.len());
        if id == ID_TIMESTAMP_SCALE {
            scale = Some(read_uint(&bytes[pos..end]));
        }
        pos = end;
    }
    scale
}

fn parse_track_entry(bytes: &[u8]) -> Option<MkvTrack> {
    let mut number = None;
    let mut track_type = None;
    let mut codec = None;
    let mut language = None;
    let mut language_bcp47 = None;
    let mut name = None;
    let mut flag_default = None;

    let mut pos = 0;
    while pos < bytes.len() {
        let Some((id, id_width)) = read_element_id(&bytes[pos..]) else {
            break;
        };
        pos += id_width;
        let Some((size_opt, size_width)) = read_vint_size(&bytes[pos..]) else {
            break;
        };
        pos += size_width;
        let size = size_opt.unwrap_or_else(|| (bytes.len() - pos) as u64) as usize;
        let end = (pos + size).min(bytes.len());
        let field = &bytes[pos..end];
        match id {
            ID_TRACK_NUMBER => number = Some(read_uint(field)),
            ID_TRACK_TYPE => track_type = Some(read_uint(field) as u8),
            ID_CODEC_ID => codec = Some(latin1_string(field)),
            ID_LANGUAGE => language = Some(latin1_string(field)),
            ID_LANGUAGE_BCP47 => language_bcp47 = Some(latin1_string(field)),
            ID_NAME => name = Some(sanitize_track_text(String::from_utf8_lossy(field).into_owned())),
            ID_FLAG_DEFAULT => flag_default = Some(read_uint(field) != 0),
            _ => {}
        }
        pos = end;
    }

    Some(MkvTrack {
        number: number?,
        track_type: track_type?,
        codec: codec.unwrap_or_default(),
        language: language_bcp47.or(language),
        name,
        // FlagDefault's EBML default is 1 when absent.
        default: flag_default.unwrap_or(true),
    })
}

fn parse_tracks(bytes: &[u8]) -> Vec<MkvTrack> {
    let mut tracks = Vec::new();
    let mut pos = 0;
    while pos < bytes.len() {
        let Some((id, id_width)) = read_element_id(&bytes[pos..]) else {
            break;
        };
        pos += id_width;
        let Some((size_opt, size_width)) = read_vint_size(&bytes[pos..]) else {
            break;
        };
        pos += size_width;
        let size = size_opt.unwrap_or_else(|| (bytes.len() - pos) as u64) as usize;
        let end = (pos + size).min(bytes.len());
        if id == ID_TRACK_ENTRY {
            if let Some(track) = parse_track_entry(&bytes[pos..end]) {
                tracks.push(track);
            }
        }
        pos = end;
    }
    tracks
}

/// Walks EBML header -> Segment -> top-level children up to the first Cluster; `None` means retry with more bytes.
pub fn parse_head(bytes: &[u8]) -> Option<HeadInfo> {
    let mut pos = 0;
    let (ebml_id, ebml_id_width) = read_element_id(&bytes[pos..])?;
    if ebml_id != ID_EBML {
        return None;
    }
    pos += ebml_id_width;
    let (ebml_size, ebml_size_width) = read_vint_size(&bytes[pos..])?;
    pos += ebml_size_width;
    pos += ebml_size.unwrap_or(0) as usize;
    if pos > bytes.len() {
        return None;
    }

    let (segment_id, segment_id_width) = read_element_id(&bytes[pos..])?;
    if segment_id != ID_SEGMENT {
        return None;
    }
    pos += segment_id_width;
    let (_segment_size, segment_size_width) = read_vint_size(&bytes[pos..])?;
    pos += segment_size_width;

    let mut timestamp_scale_ns = 1_000_000u64;
    let mut tracks: Vec<MkvTrack> = Vec::new();
    let mut found_tracks = false;

    while pos < bytes.len() {
        let Some((child_id, child_id_width)) = read_element_id(&bytes[pos..]) else {
            break;
        };
        if child_id == ID_CLUSTER {
            break;
        }
        pos += child_id_width;
        let Some((child_size_opt, child_size_width)) = read_vint_size(&bytes[pos..]) else {
            break;
        };
        pos += child_size_width;
        let child_size = child_size_opt.unwrap_or_else(|| (bytes.len() - pos) as u64) as usize;
        let end = (pos + child_size).min(bytes.len());

        match child_id {
            ID_INFO => {
                if let Some(scale) = parse_info(&bytes[pos..end]) {
                    timestamp_scale_ns = scale;
                }
            }
            ID_TRACKS => {
                tracks = parse_tracks(&bytes[pos..end]);
                found_tracks = true;
            }
            _ => {}
        }
        pos = end;
        if child_size_opt.is_none() {
            break;
        }
    }

    if !found_tracks {
        return None;
    }

    Some(HeadInfo {
        timestamp_scale_ns,
        tracks,
    })
}

// ---------------------------------------------------------------------------
// Cluster scanner (push parser fed arbitrary chunks from an arbitrary offset)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubtitleCodec {
    Srt,
    Ass,
}

#[derive(Debug, Clone)]
pub struct ScannedCue {
    pub track_number: u64,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

enum Collect {
    SimpleBlockPayload {
        track: u64,
        codec: SubtitleCodec,
        start_ticks: u64,
        needed: u64,
        buffer: Vec<u8>,
    },
    BlockGroupBody {
        needed: u64,
        buffer: Vec<u8>,
    },
}

enum ScanOutcome {
    Found,
    NeedMore,
}

enum BlockGroupProbe {
    SkipEarly,
    FullCollect,
    NeedMore,
}

fn is_recognized_cluster_child(id: u64) -> bool {
    matches!(
        id,
        ID_CLUSTER_TIMESTAMP | ID_SIMPLE_BLOCK | ID_BLOCK_GROUP | ID_VOID | ID_CRC32
            | ID_SILENT_TRACKS
    )
}

/// Block inner header layout: track vint + i16 relative timestamp + 1 flags byte.
fn parse_block_header(bytes: &[u8]) -> Option<(u64, i16, u8, usize)> {
    let (track, track_width) = read_vint_raw(bytes)?;
    if bytes.len() < track_width + 3 {
        return None;
    }
    let rel = i16::from_be_bytes([bytes[track_width], bytes[track_width + 1]]);
    let flags = bytes[track_width + 2];
    Some((track, rel, flags, track_width + 3))
}

fn peek_element_header(buf: &[u8]) -> Option<(u64, usize, Option<u64>)> {
    let (id, id_width) = read_element_id(buf)?;
    let (size, size_width) = read_vint_size(&buf[id_width..])?;
    Some((id, id_width + size_width, size))
}

fn decode_srt(payload: &[u8]) -> String {
    let text = String::from_utf8_lossy(payload);
    text.replace("\r\n", "\n").replace('\r', "\n").trim_end().to_string()
}

/// Split on the first 8 commas only: the trailing ASS Text field may contain commas itself.
fn decode_ass(payload: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(payload);
    let bytes = text.as_bytes();
    let mut idx = 0;
    let mut commas = 0;
    while idx < bytes.len() && commas < 8 {
        if bytes[idx] == b',' {
            commas += 1;
        }
        idx += 1;
    }
    if commas < 8 {
        return None;
    }

    let mut cleaned = String::with_capacity(text.len() - idx);
    let mut in_override = false;
    for ch in text[idx..].chars() {
        match ch {
            '{' => in_override = true,
            '}' => in_override = false,
            _ if in_override => {}
            _ => cleaned.push(ch),
        }
    }
    let cleaned = cleaned
        .replace("\\N", "\n")
        .replace("\\h", "\u{00A0}")
        .replace("\\n", " ");
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn decode_subtitle(codec: SubtitleCodec, payload: &[u8]) -> Option<String> {
    match codec {
        SubtitleCodec::Srt => {
            let text = decode_srt(payload);
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
        SubtitleCodec::Ass => decode_ass(payload),
    }
}

fn parse_block_group_body(
    body: &[u8],
    cluster_timestamp: u64,
    timestamp_scale_ns: u64,
    subtitle_tracks: &HashMap<u64, SubtitleCodec>,
) -> Option<ScannedCue> {
    let mut pos = 0;
    let mut block: Option<(u64, i64, u8, Vec<u8>)> = None;
    let mut duration_ticks: Option<u64> = None;

    while pos < body.len() {
        let (id, id_width) = read_element_id(&body[pos..])?;
        pos += id_width;
        let (size_opt, size_width) = read_vint_size(&body[pos..])?;
        pos += size_width;
        let size = size_opt.unwrap_or_else(|| (body.len() - pos) as u64) as usize;
        let end = (pos + size).min(body.len());
        match id {
            ID_BLOCK => {
                if let Some((track, rel, flags, sub_header_len)) =
                    parse_block_header(&body[pos..end])
                {
                    let payload = body[pos + sub_header_len..end].to_vec();
                    block = Some((track, cluster_timestamp as i64 + rel as i64, flags, payload));
                }
            }
            ID_BLOCK_DURATION => {
                duration_ticks = Some(read_uint(&body[pos..end]));
            }
            _ => {}
        }
        pos = end;
    }

    let (track, start_ticks, flags, payload) = block?;
    if flags & 0x06 != 0 {
        return None;
    }
    let codec = *subtitle_tracks.get(&track)?;
    let text = decode_subtitle(codec, &payload)?;
    let start_ms = ticks_to_ms(start_ticks.max(0) as u64, timestamp_scale_ns);
    let duration_ms = duration_ticks
        .map(|ticks| ticks_to_ms(ticks, timestamp_scale_ns))
        .unwrap_or(DEFAULT_CUE_DURATION_MS);
    Some(ScannedCue {
        track_number: track,
        start_ms,
        end_ms: start_ms + duration_ms,
        text,
    })
}

pub struct ClusterScanner {
    timestamp_scale_ns: u64,
    subtitle_tracks: HashMap<u64, SubtitleCodec>,
    buf: Vec<u8>,
    scanning: bool,
    /// Inside a cluster, `None` means the cluster declared an unknown size.
    cluster_remaining: Option<u64>,
    cluster_timestamp: u64,
    skip_remaining: u64,
    collect: Option<Collect>,
}

impl ClusterScanner {
    pub fn new(timestamp_scale_ns: u64, subtitle_tracks: HashMap<u64, SubtitleCodec>) -> Self {
        Self {
            timestamp_scale_ns: if timestamp_scale_ns == 0 {
                1_000_000
            } else {
                timestamp_scale_ns
            },
            subtitle_tracks,
            buf: Vec::new(),
            scanning: true,
            cluster_remaining: None,
            cluster_timestamp: 0,
            skip_remaining: 0,
            collect: None,
        }
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Vec<ScannedCue> {
        let mut cues = Vec::new();
        if self.skip_remaining > 0 {
            let take = self.skip_remaining.min(chunk.len() as u64) as usize;
            self.consume_cluster_bytes(take as u64);
            self.skip_remaining -= take as u64;
            if take == chunk.len() {
                return cues;
            }
            self.buf.extend_from_slice(&chunk[take..]);
        } else {
            self.buf.extend_from_slice(chunk);
        }
        self.process_buffer(&mut cues);
        cues
    }

    fn consume_cluster_bytes(&mut self, n: u64) {
        if let Some(remaining) = &mut self.cluster_remaining {
            *remaining = remaining.saturating_sub(n);
        }
    }

    fn drain_consumed(&mut self, n: usize) {
        self.buf.drain(0..n);
        self.consume_cluster_bytes(n as u64);
    }

    /// Defers the unbuffered remainder to `skip_remaining` so a huge payload is never buffered in full.
    fn begin_skip(&mut self, total: u64) {
        let take = total.min(self.buf.len() as u64) as usize;
        if take > 0 {
            self.buf.drain(0..take);
            self.consume_cluster_bytes(take as u64);
        }
        self.skip_remaining = total - take as u64;
    }

    /// Some encoders wrap video in BlockGroups; peek the track number before buffering the body.
    fn probe_block_group_track(&self, body_start: usize, child_size: u64) -> BlockGroupProbe {
        let probe_cap = (child_size as usize).min(BLOCK_GROUP_PROBE_CAP);
        if self.buf.len() < body_start + probe_cap {
            return BlockGroupProbe::NeedMore;
        }
        let probe = &self.buf[body_start..body_start + probe_cap];
        let Some((child_id, child_header_len, Some(_))) = peek_element_header(probe) else {
            return BlockGroupProbe::FullCollect;
        };
        if child_id != ID_BLOCK {
            return BlockGroupProbe::FullCollect;
        }
        let Some((track, ..)) = parse_block_header(&probe[child_header_len..]) else {
            return BlockGroupProbe::FullCollect;
        };
        if self.subtitle_tracks.contains_key(&track) {
            BlockGroupProbe::FullCollect
        } else {
            BlockGroupProbe::SkipEarly
        }
    }

    fn scan_for_cluster(&mut self) -> ScanOutcome {
        loop {
            if self.buf.len() < 4 {
                return ScanOutcome::NeedMore;
            }
            let mut hit = None;
            for i in 0..=self.buf.len() - 4 {
                if self.buf[i..i + 4] == CLUSTER_ID_BYTES {
                    hit = Some(i);
                    break;
                }
            }
            let Some(i) = hit else {
                let keep_from = self.buf.len() - 3;
                self.buf.drain(0..keep_from);
                return ScanOutcome::NeedMore;
            };

            let after_id = i + 4;
            let (size_opt, size_width) = match read_vint(&self.buf[after_id..], true) {
                VintRead::Value(value, width) => {
                    let all_ones = value == (1u64 << (7 * width)) - 1;
                    (if all_ones { None } else { Some(value) }, width)
                }
                VintRead::NeedMore => {
                    self.buf.drain(0..i);
                    return ScanOutcome::NeedMore;
                }
                VintRead::Invalid => {
                    // No amount of extra data fixes an invalid vint, so drop the candidate.
                    self.buf.drain(0..i + 1);
                    continue;
                }
            };
            let size_ok = match size_opt {
                None => true,
                Some(value) => value <= MAX_CLUSTER_SIZE,
            };
            if !size_ok {
                self.buf.drain(0..i + 1);
                continue;
            }

            let after_size = after_id + size_width;
            let child_id = match read_vint(&self.buf[after_size..], false) {
                VintRead::Value(value, _) => value,
                VintRead::NeedMore => {
                    self.buf.drain(0..i);
                    return ScanOutcome::NeedMore;
                }
                VintRead::Invalid => {
                    self.buf.drain(0..i + 1);
                    continue;
                }
            };
            if !is_recognized_cluster_child(child_id) {
                self.buf.drain(0..i + 1);
                continue;
            }

            self.buf.drain(0..after_size);
            self.cluster_remaining = size_opt;
            self.cluster_timestamp = 0;
            self.scanning = false;
            return ScanOutcome::Found;
        }
    }

    fn advance_collect(&mut self, mut collect: Collect, cues: &mut Vec<ScannedCue>) -> Option<Collect> {
        let (needed, buffer) = match &mut collect {
            Collect::SimpleBlockPayload { needed, buffer, .. } => (*needed, buffer),
            Collect::BlockGroupBody { needed, buffer } => (*needed, buffer),
        };
        let want = (needed as usize).saturating_sub(buffer.len());
        let take = want.min(self.buf.len());
        if take > 0 {
            buffer.extend_from_slice(&self.buf[0..take]);
            self.buf.drain(0..take);
            self.consume_cluster_bytes(take as u64);
        }
        if buffer.len() < needed as usize {
            return Some(collect);
        }

        match collect {
            Collect::SimpleBlockPayload {
                track,
                codec,
                start_ticks,
                buffer,
                ..
            } => {
                if let Some(text) = decode_subtitle(codec, &buffer) {
                    let start_ms = ticks_to_ms(start_ticks, self.timestamp_scale_ns);
                    cues.push(ScannedCue {
                        track_number: track,
                        start_ms,
                        end_ms: start_ms + DEFAULT_CUE_DURATION_MS,
                        text,
                    });
                }
            }
            Collect::BlockGroupBody { buffer, .. } => {
                if let Some(cue) = parse_block_group_body(
                    &buffer,
                    self.cluster_timestamp,
                    self.timestamp_scale_ns,
                    &self.subtitle_tracks,
                ) {
                    cues.push(cue);
                }
            }
        }
        None
    }

    fn process_buffer(&mut self, cues: &mut Vec<ScannedCue>) {
        loop {
            if self.skip_remaining > 0 {
                let take = self.skip_remaining.min(self.buf.len() as u64) as usize;
                if take > 0 {
                    self.buf.drain(0..take);
                }
                self.consume_cluster_bytes(take as u64);
                self.skip_remaining -= take as u64;
                if self.skip_remaining > 0 {
                    return;
                }
                continue;
            }

            if let Some(collect) = self.collect.take() {
                match self.advance_collect(collect, cues) {
                    Some(pending) => {
                        self.collect = Some(pending);
                        return;
                    }
                    None => continue,
                }
            }

            if self.scanning {
                match self.scan_for_cluster() {
                    ScanOutcome::Found => continue,
                    ScanOutcome::NeedMore => return,
                }
            }

            if let Some(0) = self.cluster_remaining {
                self.scanning = true;
                continue;
            }

            let Some((child_id, header_len, child_size)) = peek_element_header(&self.buf) else {
                return;
            };

            if self.cluster_remaining.is_none() && !is_recognized_cluster_child(child_id) {
                // Unknown-size cluster ended; let Scan re-discover this exact position.
                self.scanning = true;
                continue;
            }

            let Some(child_size) = child_size else {
                // A recognized child with unknown size isn't valid Matroska; bail rather than stall.
                self.buf.drain(0..header_len);
                self.consume_cluster_bytes(header_len as u64);
                self.scanning = true;
                continue;
            };

            match child_id {
                ID_CLUSTER_TIMESTAMP => {
                    if child_size > MAX_TIMESTAMP_SIZE {
                        self.drain_consumed(header_len);
                        self.begin_skip(child_size);
                        continue;
                    }
                    if self.buf.len() < header_len + child_size as usize {
                        return;
                    }
                    let ticks = read_uint(&self.buf[header_len..header_len + child_size as usize]);
                    self.drain_consumed(header_len + child_size as usize);
                    self.cluster_timestamp = ticks;
                }
                ID_SIMPLE_BLOCK => {
                    let probe_cap = (child_size as usize).min(11);
                    if self.buf.len() < header_len + probe_cap {
                        return;
                    }
                    match parse_block_header(&self.buf[header_len..header_len + probe_cap]) {
                        Some((track, rel, flags, sub_header_len)) => {
                            self.drain_consumed(header_len + sub_header_len);
                            let payload_len =
                                (child_size as usize).saturating_sub(sub_header_len) as u64;
                            let laced = flags & 0x06 != 0;
                            match self.subtitle_tracks.get(&track).copied() {
                                Some(codec) if !laced && payload_len <= MAX_SIMPLE_BLOCK_SIZE => {
                                    let start_ticks =
                                        (self.cluster_timestamp as i64 + rel as i64).max(0) as u64;
                                    self.collect = Some(Collect::SimpleBlockPayload {
                                        track,
                                        codec,
                                        start_ticks,
                                        needed: payload_len,
                                        buffer: Vec::new(),
                                    });
                                }
                                _ => self.begin_skip(payload_len),
                            }
                        }
                        None => {
                            self.drain_consumed(header_len);
                            self.begin_skip(child_size);
                        }
                    }
                }
                ID_BLOCK_GROUP => match self.probe_block_group_track(header_len, child_size) {
                    BlockGroupProbe::NeedMore => return,
                    BlockGroupProbe::SkipEarly => {
                        self.drain_consumed(header_len);
                        self.begin_skip(child_size);
                    }
                    BlockGroupProbe::FullCollect => {
                        self.drain_consumed(header_len);
                        if child_size <= MAX_BLOCK_GROUP_SIZE {
                            self.collect = Some(Collect::BlockGroupBody {
                                needed: child_size,
                                buffer: Vec::new(),
                            });
                        } else {
                            self.begin_skip(child_size);
                        }
                    }
                },
                _ => {
                    self.drain_consumed(header_len);
                    self.begin_skip(child_size);
                }
            }
        }
    }
}

#[cfg(test)]
impl ClusterScanner {
    pub(crate) fn debug_buf_len(&self) -> usize {
        self.buf.len()
    }
}

/// Fixture builders shared with `vod_proxy`'s tests.
#[cfg(test)]
pub(crate) mod test_fixtures {
    use super::*;

    pub(crate) fn encode_id(id: u64) -> Vec<u8> {
        let bits = 64 - id.leading_zeros();
        let width = (((bits + 7) / 8).max(1)) as usize;
        id.to_be_bytes()[8 - width..].to_vec()
    }

    pub(crate) fn encode_size_min(value: u64) -> Vec<u8> {
        let mut width = 1usize;
        while value >= (1u64 << (7 * width)) - 1 {
            width += 1;
        }
        let marker = 0x80u8 >> (width - 1);
        let mut bytes = vec![0u8; width];
        let mut remaining = value;
        for i in (0..width).rev() {
            bytes[i] = (remaining & 0xFF) as u8;
            remaining >>= 8;
        }
        bytes[0] |= marker;
        bytes
    }

    pub(crate) fn encode_size_unknown(width: usize) -> Vec<u8> {
        let value = (1u64 << (7 * width)) - 1;
        let marker = 0x80u8 >> (width - 1);
        let mut bytes = vec![0u8; width];
        let mut remaining = value;
        for i in (0..width).rev() {
            bytes[i] = (remaining & 0xFF) as u8;
            remaining >>= 8;
        }
        bytes[0] |= marker;
        bytes
    }

    pub(crate) fn encode_uint(value: u64, width: usize) -> Vec<u8> {
        let bytes = value.to_be_bytes();
        bytes[8 - width..].to_vec()
    }

    pub(crate) fn elem(id: u64, content: &[u8]) -> Vec<u8> {
        let mut out = encode_id(id);
        out.extend(encode_size_min(content.len() as u64));
        out.extend_from_slice(content);
        out
    }

    pub(crate) fn concat(parts: &[Vec<u8>]) -> Vec<u8> {
        parts.iter().flat_map(|part| part.iter().copied()).collect()
    }

    pub(crate) fn block_header(track: u64, rel: i16, flags: u8) -> Vec<u8> {
        let mut out = encode_size_min(track);
        out.extend_from_slice(&rel.to_be_bytes());
        out.push(flags);
        out
    }

    pub(crate) fn simple_block(track: u64, rel: i16, flags: u8, payload: &[u8]) -> Vec<u8> {
        let mut content = block_header(track, rel, flags);
        content.extend_from_slice(payload);
        elem(ID_SIMPLE_BLOCK, &content)
    }

    pub(crate) fn block_group(
        track: u64,
        rel: i16,
        flags: u8,
        payload: &[u8],
        duration_ticks: Option<u64>,
    ) -> Vec<u8> {
        let mut content = block_header(track, rel, flags);
        content.extend_from_slice(payload);
        let block = elem(ID_BLOCK, &content);
        let mut group_body = block;
        if let Some(ticks) = duration_ticks {
            group_body.extend(elem(ID_BLOCK_DURATION, &encode_uint(ticks, 3)));
        }
        elem(ID_BLOCK_GROUP, &group_body)
    }

    pub(crate) fn cluster(timestamp: u64, children: &[Vec<u8>]) -> Vec<u8> {
        let mut body = elem(ID_CLUSTER_TIMESTAMP, &encode_uint(timestamp, 3));
        body.extend(concat(children));
        elem(ID_CLUSTER, &body)
    }

    pub(crate) fn subtitle_map(entries: &[(u64, SubtitleCodec)]) -> HashMap<u64, SubtitleCodec> {
        entries.iter().copied().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::test_fixtures::*;
    use super::*;

    // -- varint tests -------------------------------------------------------

    #[test]
    fn read_element_id_widths() {
        assert_eq!(read_element_id(&[0xAE]).unwrap(), (0xAE, 1));
        assert_eq!(read_element_id(&[0x53, 0x6E]).unwrap(), (0x536E, 2));
        assert_eq!(read_element_id(&[0x2A, 0xD7, 0xB1]).unwrap(), (0x2AD7B1, 3));
        assert_eq!(
            read_element_id(&[0x1A, 0x45, 0xDF, 0xA3]).unwrap(),
            (0x1A45DFA3, 4)
        );
    }

    #[test]
    fn read_vint_size_marker_stripped() {
        // Single-byte size 5 -> 0x80 | 5 = 0x85.
        assert_eq!(read_vint_size(&[0x85]).unwrap(), (Some(5), 1));
        // Two-byte size 300 -> marker 0x40 | high bits.
        let bytes = encode_size_min(300);
        assert_eq!(bytes.len(), 2);
        assert_eq!(read_vint_size(&bytes).unwrap(), (Some(300), 2));
    }

    #[test]
    fn read_vint_size_unknown() {
        assert_eq!(read_vint_size(&[0xFF]).unwrap(), (None, 1));
    }

    #[test]
    fn read_vint_needs_more_bytes() {
        assert!(read_element_id(&[0x53]).is_none());
        assert!(read_vint_size(&[]).is_none());
    }

    // -- parse_head -----------------------------------------------------

    #[test]
    fn parse_head_extracts_scale_and_tracks() {
        let ebml = elem(ID_EBML, b"");
        let info = elem(ID_INFO, &elem(ID_TIMESTAMP_SCALE, &encode_uint(1_000_000, 3)));
        let video_track = elem(
            ID_TRACK_ENTRY,
            &concat(&[
                elem(ID_TRACK_NUMBER, &encode_uint(1, 1)),
                elem(ID_TRACK_TYPE, &encode_uint(1, 1)),
            ]),
        );
        let sub_en = elem(
            ID_TRACK_ENTRY,
            &concat(&[
                elem(ID_TRACK_NUMBER, &encode_uint(2, 1)),
                elem(ID_TRACK_TYPE, &encode_uint(0x11, 1)),
                elem(ID_CODEC_ID, b"S_TEXT/UTF8"),
                elem(ID_LANGUAGE, b"eng"),
                elem(ID_NAME, b"English"),
            ]),
        );
        let sub_fr = elem(
            ID_TRACK_ENTRY,
            &concat(&[
                elem(ID_TRACK_NUMBER, &encode_uint(3, 1)),
                elem(ID_TRACK_TYPE, &encode_uint(0x11, 1)),
                elem(ID_CODEC_ID, b"S_TEXT/ASS"),
                elem(ID_LANGUAGE_BCP47, b"fr"),
                elem(ID_FLAG_DEFAULT, &encode_uint(0, 1)),
            ]),
        );
        let tracks = elem(ID_TRACKS, &concat(&[video_track, sub_en, sub_fr]));
        let segment = elem(ID_SEGMENT, &concat(&[info, tracks]));
        let stream = concat(&[ebml, segment]);

        let head = parse_head(&stream).expect("head must parse");
        assert_eq!(head.timestamp_scale_ns, 1_000_000);
        assert_eq!(head.tracks.len(), 3);

        assert_eq!(head.tracks[0].number, 1);
        assert_eq!(head.tracks[0].track_type, 1);
        assert!(head.tracks[0].default, "FlagDefault absent must default to true");

        assert_eq!(head.tracks[1].number, 2);
        assert_eq!(head.tracks[1].track_type, TRACK_TYPE_SUBTITLE);
        assert_eq!(head.tracks[1].codec, "S_TEXT/UTF8");
        assert_eq!(head.tracks[1].language.as_deref(), Some("eng"));
        assert_eq!(head.tracks[1].name.as_deref(), Some("English"));
        assert!(head.tracks[1].default, "FlagDefault absent must default to true");

        assert_eq!(head.tracks[2].number, 3);
        assert_eq!(head.tracks[2].track_type, TRACK_TYPE_SUBTITLE);
        assert_eq!(head.tracks[2].codec, "S_TEXT/ASS");
        assert_eq!(head.tracks[2].language.as_deref(), Some("fr"));
        assert_eq!(head.tracks[2].name, None);
        assert!(!head.tracks[2].default, "explicit FlagDefault(0) must parse as false");
    }

    #[test]
    fn parse_head_returns_none_without_ebml_magic() {
        assert!(parse_head(&[0, 1, 2, 3]).is_none());
    }

    #[test]
    fn parse_head_returns_none_when_tracks_missing() {
        let ebml = elem(ID_EBML, b"");
        let segment = elem(ID_SEGMENT, b"");
        let stream = concat(&[ebml, segment]);
        assert!(parse_head(&stream).is_none());
    }

    // -- ClusterScanner ---------------------------------------------------

    #[test]
    fn scanner_extracts_srt_and_ass_cues_and_ignores_video_and_laced() {
        let video_payload = vec![0xABu8; 4096];
        let ass_text = "0,0,Default,,0,0,0,,{\\i1}Styled{\\i0} text\\Nsecond line";

        let clusters = cluster(
            1000,
            &[
                simple_block(1, 0, 0, &video_payload),
                simple_block(2, 100, 0, b"Simple cue"),
                simple_block(2, 200, 0x02, b"Laced, must be ignored"),
                block_group(2, 500, 0, b"Hello World", Some(2000)),
                block_group(3, 700, 0, ass_text.as_bytes(), None),
            ],
        );

        let tracks = subtitle_map(&[(2, SubtitleCodec::Srt), (3, SubtitleCodec::Ass)]);
        let mut scanner = ClusterScanner::new(1_000_000, tracks);
        let cues = scanner.feed(&clusters);

        assert_eq!(cues.len(), 3, "video block and laced block must be skipped");

        let simple_cue = &cues[0];
        assert_eq!(simple_cue.track_number, 2);
        assert_eq!(simple_cue.start_ms, 1100);
        assert_eq!(simple_cue.end_ms, 1100 + 3000);
        assert_eq!(simple_cue.text, "Simple cue");

        let srt_cue = &cues[1];
        assert_eq!(srt_cue.track_number, 2);
        assert_eq!(srt_cue.start_ms, 1500);
        assert_eq!(srt_cue.end_ms, 3500);
        assert_eq!(srt_cue.text, "Hello World");

        let ass_cue = &cues[2];
        assert_eq!(ass_cue.track_number, 3);
        assert_eq!(ass_cue.start_ms, 1700);
        assert_eq!(ass_cue.end_ms, 1700 + 3000);
        assert_eq!(ass_cue.text, "Styled text\nsecond line");
    }

    #[test]
    fn scanner_resyncs_past_false_cluster_hit_and_is_chunk_boundary_safe() {
        let mut garbage = vec![0x11u8; 20];
        // A false Cluster-ID hit whose size parses but whose child id isn't recognized.
        garbage.extend_from_slice(&CLUSTER_ID_BYTES);
        garbage.extend(encode_size_min(50));
        garbage.extend_from_slice(&[0x12, 0x34, 0x56, 0x78]);

        let real_cluster = cluster(2500, &[block_group(9, 10, 0, b"Resync worked", None)]);
        let mut stream = garbage;
        stream.extend_from_slice(&real_cluster);

        let tracks = subtitle_map(&[(9, SubtitleCodec::Srt)]);

        let mut whole_scanner = ClusterScanner::new(1_000_000, tracks.clone());
        let whole_cues = whole_scanner.feed(&stream);
        assert_eq!(whole_cues.len(), 1);
        assert_eq!(whole_cues[0].text, "Resync worked");
        assert_eq!(whole_cues[0].start_ms, 2510);

        let mut chunked_scanner = ClusterScanner::new(1_000_000, tracks);
        let mut chunked_cues = Vec::new();
        for chunk in stream.chunks(7) {
            chunked_cues.extend(chunked_scanner.feed(chunk));
        }
        assert_eq!(chunked_cues.len(), 1);
        assert_eq!(chunked_cues[0].text, "Resync worked");
        assert_eq!(chunked_cues[0].start_ms, 2510);
    }

    #[test]
    fn scanner_treats_zero_byte_after_false_hit_as_invalid_not_needmore() {
        // A trailing 0x00 used to read as "wait for more data" forever, losing the real cluster.
        let mut garbage = vec![0x22u8; 16];
        garbage.extend_from_slice(&CLUSTER_ID_BYTES);
        garbage.push(0x00);

        let real_cluster = cluster(4000, &[block_group(7, 20, 0, b"Recovered after invalid byte", None)]);
        let mut stream = garbage;
        stream.extend_from_slice(&real_cluster);
        stream.extend(vec![0x33u8; 200 * 1024]);

        let tracks = subtitle_map(&[(7, SubtitleCodec::Srt)]);
        let mut scanner = ClusterScanner::new(1_000_000, tracks);

        let mut cues = Vec::new();
        for chunk in stream.chunks(37) {
            cues.extend(scanner.feed(chunk));
            assert!(
                scanner.debug_buf_len() < 64 * 1024,
                "internal buffer must stay small instead of growing with the trailing padding"
            );
        }

        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "Recovered after invalid byte");
        assert_eq!(cues[0].start_ms, 4020);
    }

    #[test]
    fn scanner_skips_video_track_wrapped_in_block_group_early() {
        let video_payload = vec![0xCDu8; 4096];
        let clusters = cluster(
            3000,
            &[
                block_group(1, 0, 0, &video_payload, None),
                block_group(2, 50, 0, b"After video group", Some(1000)),
            ],
        );
        let tracks = subtitle_map(&[(2, SubtitleCodec::Srt)]);
        let mut scanner = ClusterScanner::new(1_000_000, tracks);
        let cues = scanner.feed(&clusters);

        assert_eq!(cues.len(), 1, "the video-wrapped BlockGroup must not produce a cue");
        assert_eq!(cues[0].text, "After video group");
        assert_eq!(cues[0].start_ms, 3050);
    }

    #[test]
    fn scanner_handles_unknown_size_cluster_followed_by_second_cluster() {
        let mut cluster1_body = elem(ID_CLUSTER_TIMESTAMP, &encode_uint(0, 3));
        cluster1_body.extend(block_group(5, 0, 0, b"First cluster cue", None));
        let cluster1 = concat(&[encode_id(ID_CLUSTER), encode_size_unknown(1), cluster1_body]);

        let cluster2 = cluster(5000, &[block_group(5, 0, 0, b"Second cluster cue", None)]);

        let stream = concat(&[cluster1, cluster2]);
        let tracks = subtitle_map(&[(5, SubtitleCodec::Srt)]);
        let mut scanner = ClusterScanner::new(1_000_000, tracks);
        let cues = scanner.feed(&stream);

        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].text, "First cluster cue");
        assert_eq!(cues[0].start_ms, 0);
        assert_eq!(cues[1].text, "Second cluster cue");
        assert_eq!(cues[1].start_ms, 5000);
    }
}
