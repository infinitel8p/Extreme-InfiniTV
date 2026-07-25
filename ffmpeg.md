# ffmpeg audio-transcode proxy - plan

Goal: working sound in the embedded player for live channels whose audio the WebView cannot decode (AC-3, E-AC-3, MP2, DTS), by teeing the stream through a local ffmpeg process that copies the video untouched and transcodes only the audio to AAC. Desktop only. Companion to, not a replacement for, the external-player escape hatch: channels whose *video* the WebView can't handle (e.g. HEVC Main 10 2160p50) still belong in MPV/VLC.

## Why this shape

- The decode gap is platform-side: WebView2/Chromium ships no Dolby/MP2 decoders, and even when Windows has a Dolby MFT it is unreliable (observed: `audio/mp4;codecs=ac-3` SourceBuffer accepted, zero bytes decoded, no error). Transcoding audio to AAC removes the dependency on the user's machine entirely.
- Video is copied (`-c:v copy`), so CPU cost is a single audio decode+encode - negligible.
- Same architectural pattern as `vod_proxy.rs`: local 127.0.0.1 HTTP server the player tunes to, Rust owns the upstream connection. Reference implementations: Threadfin, Dispatcharr (both proxy live TS through ffmpeg).
- Android/TV are NOT in scope: the native-player handoff already covers them (ExoPlayer/VLC decode AC-3). Prerequisite tweak there instead: `giveUpOnPlayback` should auto-hand-off for `failure.kind === "audio"` like it does for `hevc`/`codec`.
- macOS likely doesn't need it (CoreAudio decodes AC-3 in WKWebView); confirm before excluding.

## Pipeline

```
provider ──HTTP──> Rust fetch task ──stdin──> ffmpeg ──stdout──> Rust HTTP server ──127.0.0.1──> mpegts.js
```

- Rust fetches the source (not ffmpeg) so credentials never appear on a process command line (visible in Task Manager), and so the existing semantics are reused: per-channel User-Agent, `splitUrlAuth` Authorization headers, redirect handling.
- ffmpeg command (built by a pure, unit-tested `buildFfmpegArgs` equivalent on the Rust side):

```
ffmpeg -hide_banner -loglevel warning \
  -i pipe:0 \
  -map 0:v:0 -map 0:a:0? \
  -c:v copy -c:a aac -b:a 192k \
  -f mpegts pipe:1
```

- Output stays MPEG-TS so the player path is unchanged: the frontend remounts with the local URL and `kindHint: "ts"` (mpegts.js).
- Decision needed: `-ac 2` stereo downmix vs keeping 5.1. AAC 5.1 decodes fine in WebView2; stereo is the safer default for TVs/laptops. Suggest: stereo in v1, revisit.

## Rust side (`src-tauri/src/audio_proxy.rs`)

Mirrors `vod_proxy.rs` conventions.

- `audio_transcode_available()` - sidecar binary present + `-version` probe with 2s timeout (mirror `external_player.rs` detect mode).
- `register_audio_transcode(url, user_agent) -> { session_id, local_url }` - spawns the fetch task and the ffmpeg sidecar, serves ffmpeg stdout at `http://127.0.0.1:<port>/live/<session_id>` with `Content-Type: video/mp2t`. One live session at a time: registering tears down the previous one.
- `unregister_audio_transcode(session_id)` - kills ffmpeg, aborts the fetch. Also torn down on window destroy and app exit (no orphan ffmpeg processes; use a kill-on-drop child handle).
- Health: ffmpeg exiting nonzero, or stdout producing no bytes for N seconds, emits `xt:audioproxy-error {session_id, detail}`; the frontend falls back to direct play and messaging.
- Error strings use the existing prefix convention (`NOT_FOUND:` / `TIMEOUT:` / `OTHER:`).
- **ACL gotcha** (see CLAUDE.md): every new command must be added to `permissions/desktop-commands.toml` and is granted via `capabilities/desktop.json`, or it is denied at runtime.

## Frontend

New `src/scripts/lib/audio-proxy.ts` (mirror `vod-proxy.ts`): `audioTranscodeAvailable()`, `startAudioTranscode(streamUrl)`, `stopAudioTranscode()`, subscribes to `xt:audioproxy-error`.

Integration in `stream.ts`:

1. **Trigger**: the dead-audio watchdog verdict (video frames decoding, zero audio bytes) and the `failure.kind === "audio"` start-failure path. When the proxy is available, the toast/panel gains a "Fix audio" action; clicking remounts the current channel through the local URL. The tune context is flagged so the watchdog doesn't re-arm against the proxied mount.
2. **Memory**: on success, remember the channel (per-playlist key, e.g. `xt_audio_transcode:<playlistId>` holding channel keys) so the next tune of that channel goes straight through the proxy without waiting for the watchdog.
3. **Fallback**: any proxy error mid-play falls back to direct playback (silent) plus the existing toast, never a dead player.
4. **Settings** (Playback section): "Fix unsupported audio automatically (transcode)" - when on, the watchdog verdict remounts automatically instead of offering the button. Ship off by default in v1, consider default-on once proven.

Out of scope for v1: catch-up/timeshift sources, VOD (MP4/MKV movies with AC-3 - natural follow-up since `vod_proxy.rs` already sits in that path), any video transcoding (never: that is what external players are for).

## Binary strategy

- Tauri sidecar via `externalBin` with per-target-triple binaries. Bundled into NSIS/MSI, and therefore into the MSIX/Store package automatically (`pnpm msix` packs the signed MSI).
- **No runtime download.** MS Store policy forbids fetching executable code post-install; bundling is compliant (Store apps ship ffmpeg routinely). This also keeps NSIS and Store builds functionally identical - no `is_store_build()` split needed here.
- Size: a full static ffmpeg is ~80-120 MB - too much. Build a trimmed LGPL static binary in CI: `--disable-everything` plus only `mpegts/hls` demuxers, `ac3 eac3 mp2 mp3 dca aac` decoders, `aac` encoder, `mpegts` muxer, `pipe` protocol. Expected ~8-15 MB per platform. v1 bootstrapping can use an official essentials build while the trimmed CI build is set up.
- Platforms: Windows first (where the problem lives), Linux second (WebKitGTK has the same gap), macOS pending the CoreAudio check above.
- Licensing: LGPL configure (no `--enable-gpl`, no nonfree). Separate-process sidecar means no linking questions. Ship the LGPL text + a source offer in the about/licenses surface. Patent posture: core AC-3 patents expired 2017; decoding ships in VLC worldwide.

## Phases

1. **Groundwork** (mostly done): dead-audio watchdog + toast, mpegts.js registration-descriptor patch, Android `giveUpOnPlayback` audio-verdict handoff (pending, one line).
2. **Proxy core**: `audio_proxy.rs` + sidecar wiring + `audio-proxy.ts`, dev-machine binary dropped in manually, "Fix audio" toast action end to end on the known AC-3 channels.
3. **Polish**: per-channel memory, settings toggle, failure fallback paths, redacted logging.
4. **Distribution**: trimmed ffmpeg CI build for each desktop target, bundle wiring in `release.yml`/`beta.yml`, MSIX validation, license page entry.
5. **Later**: VOD audio path, auto mode by default, catch-up sources.

## Verification matrix

- AC-3 (stream type 0x81): zshr `340487` - silent today, must play with sound via proxy.
- AC-3 in private-data PID: Beijing TV 4K (needs the mpegts patch to even report the codec; video will remain a slideshow there - that channel's real answer stays MPV, which is fine: the toast still points there).
- AAC control channel (`340512`): watchdog must stay quiet, proxy never triggers.
- Proxy kill mid-play (kill ffmpeg in Task Manager): player falls back to direct, no zombie session.
- Channel zap while proxied: old session torn down, no port/process leak.
- MSIX build: sidecar spawns from the WindowsApps install dir.

## Open decisions

- Stereo downmix vs 5.1 AAC (suggest stereo v1).
- Audio bitrate (suggest 192k stereo).
- Auto-transcode default on/off (suggest off in v1, on after a beta cycle).
- macOS inclusion (check CoreAudio AC-3 decode in WKWebView first).
- Whether the local server should merge with `vod_proxy.rs` into one shared 127.0.0.1 server module now or later (suggest later, after both exist).
