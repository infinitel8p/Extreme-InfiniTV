<script>
  import { onMount } from "svelte"
  import {
    getPlayerBackend,
    setPlayerBackend,
    getPlayerPath,
    setPlayerPath,
    getPlayerExtraArgs,
    setPlayerExtraArgs,
    getPlayerReuseInstance,
    setPlayerReuseInstance,
    getExternalPlayerPref,
    setExternalPlayerPref,
    PLAYER_BACKENDS,
    PLAYER_BACKEND_EVENT,
    EXTERNAL_PLAYER_PREF_VALUES,
  } from "@/scripts/lib/app-settings.js"
  import {
    detectPlayer,
    externalPlayersAvailable,
    PlayerNotConfiguredError,
  } from "@/scripts/lib/player-runtime.ts"
  import { surfaceLaunchError } from "@/scripts/lib/external-player-button.js"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
  import { toastError, toastSuccess } from "@/scripts/lib/toast.js"

  const DETECT_CACHE_PREFIX = "xt_player_detected_"
  const DETECT_STATUS_PREFIX = "xt_player_detect_status_"

  const isAndroidEnv = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "")
  const isDesktopTauriEnv =
    typeof window !== "undefined" &&
    !!(window.__TAURI_INTERNALS__ || window.__TAURI__) &&
    !isAndroidEnv

  let backend = $state(getPlayerBackend())
  let pathMpv = $state(getPlayerPath("mpv"))
  let pathVlc = $state(getPlayerPath("vlc"))
  let argsMpv = $state(getPlayerExtraArgs("mpv").join("\n"))
  let argsVlc = $state(getPlayerExtraArgs("vlc").join("\n"))
  let reuseMpv = $state(getPlayerReuseInstance("mpv"))
  let reuseVlc = $state(getPlayerReuseInstance("vlc"))
  let detectedMpv = $state(readDetectCache("mpv"))
  let detectedVlc = $state(readDetectCache("vlc"))
  let statusMpv = $state(readDetectStatus("mpv"))
  let statusVlc = $state(readDetectStatus("vlc"))
  let externalPref = $state(getExternalPlayerPref())
  // externalPlayersAvailable already reflects sandbox state.
  const sandboxed = isDesktopTauriEnv && !externalPlayersAvailable

  let titleLabel = $state(label("title", "Playback"))
  let videojsLabel = $state(label("backend.videojs", "Video.js"))
  let videojsHelper = $state(label("backend.videojsHelper", "Mature HTML5 player with broad codec support."))
  let artplayerLabel = $state(label("backend.artplayer", "ArtPlayer (default)"))
  let shakaLabel = $state(label("backend.shaka", "Shaka Player"))
  let shakaHelper = $state(label("backend.shakaHelper", "Google's streaming player with strong DASH and DRM support."))
  let mpvLabel = $state(label("backend.mpv", "MPV (external)"))
  let vlcLabel = $state(label("backend.vlc", "VLC (external)"))
  let artplayerHelper = $state(label("backend.artplayerHelper", "Lightweight HTML5 player powered by ArtPlayer + hls.js."))
  let artplayerAndroidHelper = $state(label("backend.artplayerAndroidHelper", "Not supported on Android - Video.js is used instead."))
  let mpvHelper = $state(label("backend.mpvHelper", "Best for 4K and HDR."))
  let vlcHelper = $state(label("backend.vlcHelper", "Plays almost any format."))
  let pathLabel = $state(label("pathLabel", "Path"))
  let readyLabel = $state(label("ready", "Ready"))
  let activeLabel = $state(label("active", "Active"))
  let notDetectedLabel = $state(label("notDetected", "Not detected"))
  let notFoundLabel = $state(label("notFound", "Not found"))
  let browseLabel = $state(label("browse", "Browse…"))
  let detectLabel = $state(label("detect", "Detect"))
  let advancedLabel = $state(label("advanced", "Advanced"))
  let extraArgsLabel = $state(label("extraArgs", "Extra arguments (one per line)"))
  let externalPrefLabel = $state(label("externalPref.label", "Preferred external player"))
  let externalPrefHelper = $state(label("externalPref.helper", "Which player the 'Open in…' button uses when both MPV and VLC are set."))
  let externalPrefAskLabel = $state(label("externalPref.ask", "Ask each time"))
  let sandboxNoteLabel = $state(label("sandboxNote", "External players (MPV/VLC) aren't available in Snap or Flatpak installs."))

  function label(suffix, fallback, params) {
    const key = `settings.playback.${suffix}`
    const localized = t(key, params)
    if (localized && localized !== key) return localized
    return fallback
  }

  function readDetectCache(kind) {
    try {
      return localStorage.getItem(DETECT_CACHE_PREFIX + kind) || ""
    } catch {
      return ""
    }
  }

  function writeDetectCache(kind, value) {
    try {
      if (value) localStorage.setItem(DETECT_CACHE_PREFIX + kind, value)
      else localStorage.removeItem(DETECT_CACHE_PREFIX + kind)
    } catch {}
  }

  function readDetectStatus(kind) {
    try {
      const raw = localStorage.getItem(DETECT_STATUS_PREFIX + kind) || ""
      return raw === "ok" || raw === "fail" ? raw : ""
    } catch {
      return ""
    }
  }

  function writeDetectStatus(kind, status) {
    try {
      if (status) localStorage.setItem(DETECT_STATUS_PREFIX + kind, status)
      else localStorage.removeItem(DETECT_STATUS_PREFIX + kind)
    } catch {}
  }

  function refreshLabels() {
    titleLabel = label("title", "Playback")
    videojsLabel = label("backend.videojs", "Video.js")
    videojsHelper = label("backend.videojsHelper", "Mature HTML5 player with broad codec support.")
    artplayerLabel = label("backend.artplayer", "ArtPlayer (default)")
    shakaLabel = label("backend.shaka", "Shaka Player")
    shakaHelper = label("backend.shakaHelper", "Google's streaming player with strong DASH and DRM support.")
    mpvLabel = label("backend.mpv", "MPV (external)")
    vlcLabel = label("backend.vlc", "VLC (external)")
    artplayerHelper = label("backend.artplayerHelper", "Lightweight HTML5 player powered by ArtPlayer + hls.js.")
    artplayerAndroidHelper = label("backend.artplayerAndroidHelper", "Not supported on Android - Video.js is used instead.")
    mpvHelper = label("backend.mpvHelper", "Best for 4K and HDR.")
    vlcHelper = label("backend.vlcHelper", "Plays almost any format.")
    pathLabel = label("pathLabel", "Path")
    readyLabel = label("ready", "Ready")
    activeLabel = label("active", "Active")
    notDetectedLabel = label("notDetected", "Not detected")
    notFoundLabel = label("notFound", "Not found")
    browseLabel = label("browse", "Browse…")
    detectLabel = label("detect", "Detect")
    advancedLabel = label("advanced", "Advanced")
    extraArgsLabel = label("extraArgs", "Extra arguments (one per line)")
    externalPrefLabel = label("externalPref.label", "Preferred external player")
    externalPrefHelper = label("externalPref.helper", "Which player the 'Open in…' button uses when both MPV and VLC are set.")
    externalPrefAskLabel = label("externalPref.ask", "Ask each time")
    sandboxNoteLabel = label("sandboxNote", "External players (MPV/VLC) aren't available in Snap or Flatpak installs.")
  }

  function onBackendChange(event) {
    const next = event.target.value
    if (PLAYER_BACKENDS.includes(next)) {
      backend = next
      setPlayerBackend(next)
    }
  }

  function onPathChange(kind, value) {
    if (kind === "mpv") pathMpv = value
    else pathVlc = value
    setPlayerPath(kind, value)
    writeDetectCache(kind, "")
    writeDetectStatus(kind, "")
    if (kind === "mpv") { detectedMpv = ""; statusMpv = "" }
    else { detectedVlc = ""; statusVlc = "" }
  }

  function onArgsChange(kind, value) {
    if (kind === "mpv") argsMpv = value
    else argsVlc = value
    setPlayerExtraArgs(kind, value)
  }

  function onReuseChange(kind, value) {
    if (kind === "mpv") reuseMpv = value
    else reuseVlc = value
    setPlayerReuseInstance(kind, value)
  }

  function onExternalPrefChange(value) {
    if (!EXTERNAL_PLAYER_PREF_VALUES.includes(value)) return
    externalPref = value
    setExternalPlayerPref(value)
  }

  async function browseFor(kind) {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const filters = []
      if (typeof navigator !== "undefined" && /Win/i.test(navigator.userAgent || "")) {
        filters.push({ name: "Executable", extensions: ["exe"] })
      } else if (typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent || "")) {
        filters.push({ name: "Application bundle", extensions: ["app"] })
      }
      const picked = await open({
        multiple: false,
        directory: false,
        filters: filters.length ? filters : undefined,
      })
      if (typeof picked !== "string" || !picked) return
      onPathChange(kind, picked)
    } catch (err) {
      toastError(`Couldn't open file picker: ${err?.message || err}`)
    }
  }

  async function detectFor(kind, candidatePath) {
    if (!candidatePath) {
      surfaceLaunchError(new PlayerNotConfiguredError(kind), kind)
      return
    }
    const result = await detectPlayer(kind, candidatePath)
    if (result.ok) {
      const version = result.version || "OK"
      writeDetectCache(kind, version)
      writeDetectStatus(kind, "ok")
      if (kind === "mpv") { detectedMpv = version; statusMpv = "ok" }
      else { detectedVlc = version; statusVlc = "ok" }
      toastSuccess(`${kind.toUpperCase()}: ${version}`)
    } else {
      writeDetectCache(kind, "")
      writeDetectStatus(kind, "fail")
      if (kind === "mpv") { detectedMpv = ""; statusMpv = "fail" }
      else { detectedVlc = ""; statusVlc = "fail" }
      surfaceLaunchError(result.error, kind)
    }
  }

  function onBackendEvent() {
    backend = getPlayerBackend()
  }

  onMount(() => {
    document.addEventListener(LOCALE_EVENT, refreshLabels)
    document.addEventListener(PLAYER_BACKEND_EVENT, onBackendEvent)
    refreshLabels()
    return () => {
      document.removeEventListener(LOCALE_EVENT, refreshLabels)
      document.removeEventListener(PLAYER_BACKEND_EVENT, onBackendEvent)
    }
  })
</script>

<div class="flex flex-col gap-4">
  <fieldset class="flex flex-col gap-2">
    <legend class="sr-only">{titleLabel}</legend>

    <label class="player-row">
      <input
        type="radio"
        name="player-backend"
        value="artplayer"
        checked={backend === "artplayer"}
        onchange={onBackendChange}
        aria-labelledby="playback-artplayer-title"
        aria-describedby="playback-artplayer-helper"
        class="mt-0.5"
      />
      <span class="flex flex-col gap-0.5 min-w-0 flex-1">
        <span id="playback-artplayer-title" class="player-row__title">{artplayerLabel}</span>
        <span id="playback-artplayer-helper" class="text-xs text-fg-3">{isAndroidEnv ? artplayerAndroidHelper : artplayerHelper}</span>
      </span>
      {#if backend === "artplayer"}
        <span class="active-pill" aria-hidden="true">{activeLabel}</span>
      {/if}
    </label>

    <label class="player-row">
      <input
        type="radio"
        name="player-backend"
        value="videojs"
        checked={backend === "videojs"}
        onchange={onBackendChange}
        aria-labelledby="playback-videojs-title"
        aria-describedby="playback-videojs-helper"
        class="mt-0.5"
      />
      <span class="flex flex-col gap-0.5 min-w-0 flex-1">
        <span id="playback-videojs-title" class="player-row__title">{videojsLabel}</span>
        <span id="playback-videojs-helper" class="text-xs text-fg-3">{videojsHelper}</span>
      </span>
      {#if backend === "videojs"}
        <span class="active-pill" aria-hidden="true">{activeLabel}</span>
      {/if}
    </label>

    <label class="player-row">
      <input
        type="radio"
        name="player-backend"
        value="shaka"
        checked={backend === "shaka"}
        onchange={onBackendChange}
        aria-labelledby="playback-shaka-title"
        aria-describedby="playback-shaka-helper"
        class="mt-0.5"
      />
      <span class="flex flex-col gap-0.5 min-w-0 flex-1">
        <span id="playback-shaka-title" class="player-row__title">{shakaLabel}</span>
        <span id="playback-shaka-helper" class="text-xs text-fg-3">{shakaHelper}</span>
      </span>
      {#if backend === "shaka"}
        <span class="active-pill" aria-hidden="true">{activeLabel}</span>
      {/if}
    </label>

    {#if externalPlayersAvailable && !sandboxed}
    <label class="player-row">
      <input
        type="radio"
        name="player-backend"
        value="mpv"
        checked={backend === "mpv"}
        onchange={onBackendChange}
        aria-labelledby="playback-mpv-title"
        aria-describedby={backend === "mpv" ? "playback-mpv-helper" : "playback-mpv-helper playback-mpv-status"}
        class="mt-0.5"
      />
      <span class="flex flex-col gap-0.5 min-w-0 flex-1">
        <span id="playback-mpv-title" class="player-row__title">{mpvLabel}</span>
        <span id="playback-mpv-helper" class="text-xs text-fg-3">{mpvHelper}</span>
      </span>
      {#if backend === "mpv"}
        <span class="active-pill" aria-hidden="true">{activeLabel}</span>
      {:else}
        <span class="status-meta">
          <span
            id="playback-mpv-status"
            class="status-chip"
            class:status-chip--ready={statusMpv === "ok"}
            class:status-chip--fail={statusMpv === "fail"}>
            <span class="status-chip__dot" aria-hidden="true"></span>
            <span>{statusMpv === "fail" ? notFoundLabel : statusMpv === "ok" ? readyLabel : notDetectedLabel}</span>
          </span>
          {#if statusMpv === "ok" && detectedMpv}
            <span class="status-meta__version" aria-hidden="true">{detectedMpv}</span>
          {/if}
        </span>
      {/if}
    </label>

    <label class="player-row">
      <input
        type="radio"
        name="player-backend"
        value="vlc"
        checked={backend === "vlc"}
        onchange={onBackendChange}
        aria-labelledby="playback-vlc-title"
        aria-describedby={backend === "vlc" ? "playback-vlc-helper" : "playback-vlc-helper playback-vlc-status"}
        class="mt-0.5"
      />
      <span class="flex flex-col gap-0.5 min-w-0 flex-1">
        <span id="playback-vlc-title" class="player-row__title">{vlcLabel}</span>
        <span id="playback-vlc-helper" class="text-xs text-fg-3">{vlcHelper}</span>
      </span>
      {#if backend === "vlc"}
        <span class="active-pill" aria-hidden="true">{activeLabel}</span>
      {:else}
        <span class="status-meta">
          <span
            id="playback-vlc-status"
            class="status-chip"
            class:status-chip--ready={statusVlc === "ok"}
            class:status-chip--fail={statusVlc === "fail"}>
            <span class="status-chip__dot" aria-hidden="true"></span>
            <span>{statusVlc === "fail" ? notFoundLabel : statusVlc === "ok" ? readyLabel : notDetectedLabel}</span>
          </span>
          {#if statusVlc === "ok" && detectedVlc}
            <span class="status-meta__version" aria-hidden="true">{detectedVlc}</span>
          {/if}
        </span>
      {/if}
    </label>
    {:else if sandboxed}
    <p class="text-xs text-fg-3">{sandboxNoteLabel}</p>
    {/if}
  </fieldset>

  {#if externalPlayersAvailable && !sandboxed && pathMpv && pathVlc}
    <fieldset class="flex flex-col gap-2 player-config">
      <legend class="text-eyebrow font-medium uppercase text-fg-3">{externalPrefLabel}</legend>
      <p class="text-xs text-fg-3">{externalPrefHelper}</p>
      <div class="flex flex-wrap gap-2">
        <label class="pref-option">
          <input
            type="radio"
            name="external-player-pref"
            value="mpv"
            checked={externalPref === "mpv"}
            onchange={() => onExternalPrefChange("mpv")}
          />
          <span>MPV</span>
        </label>
        <label class="pref-option">
          <input
            type="radio"
            name="external-player-pref"
            value="vlc"
            checked={externalPref === "vlc"}
            onchange={() => onExternalPrefChange("vlc")}
          />
          <span>VLC</span>
        </label>
        <label class="pref-option">
          <input
            type="radio"
            name="external-player-pref"
            value="ask"
            checked={externalPref === "ask"}
            onchange={() => onExternalPrefChange("ask")}
          />
          <span>{externalPrefAskLabel}</span>
        </label>
      </div>
    </fieldset>
  {/if}

  {#if backend === "mpv" && !sandboxed}
    <div class="player-config">
      <label class="flex flex-col gap-1.5">
        <span class="text-eyebrow font-medium uppercase text-fg-3">{pathLabel}</span>
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="text"
            spellcheck="false"
            autocomplete="off"
            placeholder="/usr/bin/mpv"
            value={pathMpv}
            oninput={(event) => onPathChange("mpv", event.target.value)}
            class="field-input font-mono flex-1"
          />
          <button type="button" class="btn" onclick={() => browseFor("mpv")}>{browseLabel}</button>
          <button type="button" class="btn" onclick={() => detectFor("mpv", pathMpv)}>{detectLabel}</button>
        </div>
      </label>

      <label class="flex items-start gap-2 text-xs text-fg-2 cursor-pointer" class:opacity-50={!pathMpv}>
        <input
          type="checkbox"
          checked={reuseMpv}
          disabled={!pathMpv}
          onchange={(event) => onReuseChange("mpv", event.target.checked)}
          class="mt-0.5"
        />
        <span class="flex flex-col gap-0.5">
          <span>{label("reuse", "Reuse the same window")}</span>
          <span class="text-fg-3">
            {label("reuseHelper",
              "Open new streams in the same MPV window.")}
          </span>
        </span>
      </label>

      <details class="player-config__advanced">
        <summary class="cursor-pointer text-xs font-medium text-fg-3">{advancedLabel}</summary>
        <label class="flex flex-col gap-1.5 mt-2">
          <span class="text-eyebrow font-medium uppercase text-fg-3">{extraArgsLabel}</span>
          <textarea
            rows="3"
            spellcheck="false"
            autocomplete="off"
            placeholder="--hwdec=auto&#10;--cache-secs=20"
            value={argsMpv}
            oninput={(event) => onArgsChange("mpv", event.target.value)}
            class="field-input font-mono"
          ></textarea>
        </label>
      </details>
    </div>
  {:else if backend === "vlc" && !sandboxed}
    <div class="player-config">
      <label class="flex flex-col gap-1.5">
        <span class="text-eyebrow font-medium uppercase text-fg-3">{pathLabel}</span>
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="text"
            spellcheck="false"
            autocomplete="off"
            placeholder="/usr/bin/vlc"
            value={pathVlc}
            oninput={(event) => onPathChange("vlc", event.target.value)}
            class="field-input font-mono flex-1"
          />
          <button type="button" class="btn" onclick={() => browseFor("vlc")}>{browseLabel}</button>
          <button type="button" class="btn" onclick={() => detectFor("vlc", pathVlc)}>{detectLabel}</button>
        </div>
      </label>

      <label class="flex items-start gap-2 text-xs text-fg-2 cursor-pointer" class:opacity-50={!pathVlc}>
        <input
          type="checkbox"
          checked={reuseVlc}
          disabled={!pathVlc}
          onchange={(event) => onReuseChange("vlc", event.target.checked)}
          class="mt-0.5"
        />
        <span class="flex flex-col gap-0.5">
          <span>{label("reuse", "Reuse the same window")}</span>
          <span class="text-fg-3">
            {label("reuseHelperVlc",
              "Open new streams in the same VLC window. The first stream's settings apply for the session.")}
          </span>
        </span>
      </label>

      <details class="player-config__advanced">
        <summary class="cursor-pointer text-xs font-medium text-fg-3">{advancedLabel}</summary>
        <label class="flex flex-col gap-1.5 mt-2">
          <span class="text-eyebrow font-medium uppercase text-fg-3">{extraArgsLabel}</span>
          <textarea
            rows="3"
            spellcheck="false"
            autocomplete="off"
            placeholder="--avcodec-hw=any"
            value={argsVlc}
            oninput={(event) => onArgsChange("vlc", event.target.value)}
            class="field-input font-mono"
          ></textarea>
        </label>
      </details>
    </div>
  {/if}
</div>

<style>
  .player-row {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.75rem;
    border-radius: 0.75rem;
    border: 1px solid var(--color-line);
    cursor: pointer;
    transition: background-color 150ms, border-color 150ms, box-shadow 150ms;
  }
  .player-row:hover {
    background: var(--color-surface-2);
  }
  .player-row:focus-within {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-accent) 18%, transparent);
  }
  .player-row:has(input[name="player-backend"]:checked) {
    border-color: var(--color-accent);
    background: var(--color-accent-soft);
  }
  .player-row__title {
    font-size: 0.875rem;
    font-weight: 500;
    line-height: 1.25rem;
  }

  .pref-option {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2.75rem;
    padding-inline: 0.75rem;
    border-radius: 0.75rem;
    border: 1px solid var(--color-line);
    font-size: 0.875rem;
    cursor: pointer;
    transition: background-color 150ms, border-color 150ms, box-shadow 150ms,
                transform 100ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .pref-option:hover {
    background: var(--color-surface-2);
  }
  .pref-option:active {
    transform: scale(0.97);
  }
  .pref-option:focus-within {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-accent) 18%, transparent);
  }
  .pref-option:has(input:checked) {
    border-color: var(--color-accent);
    background: var(--color-accent-soft);
  }

  .active-pill {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    padding-inline: 0.5rem;
    padding-block: 0.1875rem;
    border-radius: 9999px;
    background: var(--color-accent);
    color: var(--color-bg);
    font-size: 0.625rem;
    font-weight: 600;
    line-height: 1;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    box-shadow: 0 0 0 4px color-mix(in oklch, var(--color-accent) 14%, transparent);
  }

  .status-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.25rem;
    min-width: 0;
    max-width: 14rem;
  }
  .status-meta__version {
    font-size: 0.6875rem;
    line-height: 1;
    color: var(--color-fg-3);
    font-variant-numeric: tabular-nums;
    padding-inline-end: 0.125rem;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding-inline: 0.5rem;
    padding-block: 0.1875rem;
    border-radius: 9999px;
    background: color-mix(in oklch, var(--color-surface-2) 80%, transparent);
    border: 1px solid var(--color-line-soft);
    font-size: 0.6875rem;
    line-height: 1rem;
    color: var(--color-fg-3);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .status-chip__dot {
    width: 0.4375rem;
    height: 0.4375rem;
    border-radius: 9999px;
    background: var(--color-fg-3);
    opacity: 0.55;
  }
  .status-chip--ready {
    color: var(--color-fg-2);
    border-color: color-mix(in oklab, var(--color-ok) 35%, var(--color-line));
    background: color-mix(in oklab, var(--color-ok) 8%, var(--color-surface-2));
  }
  .status-chip--ready .status-chip__dot {
    background: var(--color-ok);
    opacity: 1;
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-ok) 18%, transparent);
  }
  .status-chip--fail {
    color: var(--color-bad);
    border-color: color-mix(in oklab, var(--color-bad) 40%, var(--color-line));
    background: color-mix(in oklab, var(--color-bad) 8%, var(--color-surface-2));
  }
  .status-chip--fail .status-chip__dot {
    background: var(--color-bad);
    opacity: 1;
  }

  .player-config {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    padding-top: 0.875rem;
    border-top: 1px solid var(--color-line-soft);
  }
  .player-config__advanced {
    border-top: 1px solid var(--color-line-soft);
    padding-top: 0.75rem;
  }

  @media (max-width: 480px) {
    .status-meta__version {
      display: none;
    }
  }
</style>
