<script>
  // Strip-only warming indicator: a small chip-shaped status bar with a
  // pulsing dot, three kind donuts that lock to checks on landing, and a
  // live progress readout per kind (percent if Content-Length is known,
  // else megabytes downloaded). When each kind finishes, the readout
  // swaps to the final item count and a count tween animates from 0.

  import { onMount } from "svelte"
  import { KIND_ORDER, kindLabelPlural } from "@/scripts/lib/kinds.js"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"

  const STRIP_SHOW_AFTER_MS = 150
  const HOLD_AFTER_DONE_MS = 420

  let stripActive = $state(false)
  /** @type {{ live: "pending"|"done"|"error", vod: "pending"|"done"|"error", series: "pending"|"done"|"error" }} */
  let kinds = $state({ live: "pending", vod: "pending", series: "pending" })
  /** @type {{ live: number, vod: number, series: number }} */
  let counts = $state({ live: 0, vod: 0, series: 0 })
  /** Per-kind animated count value used by the ticker. */
  let displayed = $state({ live: 0, vod: 0, series: 0 })
  /** Per-kind bytes received from the streaming reader. */
  let bytes = $state({ live: 0, vod: 0, series: 0 })
  /** Per-kind Content-Length if the server sent one. 0 means unknown. */
  let totalBytes = $state({ live: 0, vod: 0, series: 0 })
  let locale = $state(0)
  // Wrappers read the locale rune so {tr(...)} / {klp(...)} template effects
  // track it and re-evaluate on LOCALE_EVENT.
  const tr = (key, params) => (locale, t(key, params))
  const klp = (kind) => (locale, kindLabelPlural(kind))

  let _stripTimer = null
  let _doneSeen = false

  function start() {
    _doneSeen = false
    kinds = { live: "pending", vod: "pending", series: "pending" }
    counts = { live: 0, vod: 0, series: 0 }
    displayed = { live: 0, vod: 0, series: 0 }
    bytes = { live: 0, vod: 0, series: 0 }
    totalBytes = { live: 0, vod: 0, series: 0 }
    if (_stripTimer) clearTimeout(_stripTimer)
    _stripTimer = setTimeout(() => {
      _stripTimer = null
      if (!_doneSeen) stripActive = true
    }, STRIP_SHOW_AFTER_MS)
  }

  function tweenCount(kind, target) {
    if (target <= 0) {
      displayed[kind] = 0
      return
    }
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (reduceMotion) {
      displayed[kind] = target
      return
    }
    const duration = 720
    const tStart = performance.now()
    const from = displayed[kind] || 0
    const step = (now) => {
      const tProg = Math.min(1, (now - tStart) / duration)
      const eased = tProg === 1 ? 1 : 1 - Math.pow(2, -10 * tProg)
      displayed[kind] = Math.round(from + (target - from) * eased)
      if (tProg < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  function progress(ev) {
    const detail = ev.detail
    if (!detail?.kind) return
    const kind = detail.kind
    const status =
      detail.status === "done" ? "done" : detail.status === "error" ? "error" : "pending"
    kinds[kind] = status
    kinds = kinds
    if (status === "done" && Number.isFinite(detail.count)) {
      counts[kind] = Number(detail.count)
      tweenCount(kind, counts[kind])
    }
  }

  function bytesProgress(ev) {
    const detail = ev.detail
    if (!detail?.kind) return
    const kind = detail.kind
    if (!(kind in bytes)) return
    bytes[kind] = Number(detail.bytes) || 0
    if (Number.isFinite(detail.total) && detail.total > 0) {
      totalBytes[kind] = Number(detail.total)
    }
  }

  function done() {
    _doneSeen = true
    if (_stripTimer) {
      clearTimeout(_stripTimer)
      _stripTimer = null
      return
    }
    setTimeout(() => {
      stripActive = false
    }, HOLD_AFTER_DONE_MS)
  }

  const onLocale = () => { locale++ }

  onMount(() => {
    document.addEventListener("xt:catalog-warming-start", start)
    document.addEventListener("xt:catalog-warming-progress", progress)
    document.addEventListener("xt:catalog-warming-bytes", bytesProgress)
    document.addEventListener("xt:catalog-warmed", done)
    document.addEventListener(LOCALE_EVENT, onLocale)
    return () => {
      document.removeEventListener("xt:catalog-warming-start", start)
      document.removeEventListener("xt:catalog-warming-progress", progress)
      document.removeEventListener("xt:catalog-warming-bytes", bytesProgress)
      document.removeEventListener("xt:catalog-warmed", done)
      document.removeEventListener(LOCALE_EVENT, onLocale)
      if (_stripTimer) clearTimeout(_stripTimer)
    }
  })

  let doneCount = $derived(
    KIND_ORDER.reduce((n, k) => (kinds[k] !== "pending" ? n + 1 : n), 0)
  )
  let allDone = $derived(doneCount === KIND_ORDER.length)

  /** Aggregated 0..1 progress across all three kinds. Done kinds contribute
   *  a full 1/3; in-flight kinds with a known Content-Length contribute a
   *  fractional 1/3 based on bytes/total. In-flight kinds without a total
   *  stay at 0 until they land - the bar then jumps a clean third. */
  let aggregateProgress = $derived.by(() => {
    let acc = 0
    for (const kind of KIND_ORDER) {
      if (kinds[kind] === "done" || kinds[kind] === "error") {
        acc += 1 / KIND_ORDER.length
      } else if (totalBytes[kind] > 0 && bytes[kind] > 0) {
        const part = Math.min(1, bytes[kind] / totalBytes[kind])
        acc += part / KIND_ORDER.length
      }
    }
    return Math.max(0, Math.min(1, acc))
  })
  function fmt(n) {
    return (n || 0).toLocaleString()
  }
  function fmtMB(n) {
    if (!n) return "0 KB"
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
    return `${(n / (1024 * 1024)).toFixed(1)} MB`
  }
  function readout(kind) {
    if (kinds[kind] === "done") return fmt(displayed[kind])
    if (kinds[kind] === "error") return "!"
    if (totalBytes[kind] > 0 && bytes[kind] > 0) {
      const pct = Math.min(99, Math.floor((bytes[kind] / totalBytes[kind]) * 100))
      return `${pct}%`
    }
    if (bytes[kind] > 0) return fmtMB(bytes[kind])
    return ""
  }
</script>

{#if stripActive}
  <div
    class="warming-strip fixed left-0 right-0 z-10000 flex items-center gap-2.5 px-3 py-1.5
           bg-bg/95 border-b border-line text-2xs text-fg-2 backdrop-blur-md"
    style="top: env(safe-area-inset-top, 0)"
    role="status"
    aria-live="polite">
    <span class="warming-strip__label inline-flex items-center gap-2">
      <span
        class="warming-strip__sweep relative shrink-0 size-3 rounded-full"
        data-state={allDone ? "done" : "pending"}
        aria-hidden="true"></span>
      <span>{tr("catalog.warming")}</span>
    </span>

    <span class="hidden sm:flex items-center gap-3 ml-1">
      {#each KIND_ORDER as kind}
        <span class="warming-kind" data-state={kinds[kind]}>
          <span class="warming-kind__donut" data-state={kinds[kind]} aria-hidden="true">
            <svg viewBox="0 0 24 24" class="warming-kind__check" aria-hidden="true">
              <path d="M5 12.5l4 4 10-10" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </span>
          <span class="warming-kind__label">{klp(kind)}</span>
          {#if readout(kind)}
            <span class="warming-kind__readout tabular-nums" data-state={kinds[kind]}>{readout(kind)}</span>
          {/if}
        </span>
      {/each}
    </span>

    <span class="sm:hidden text-fg-3 tabular-nums ml-0.5">{doneCount}/{KIND_ORDER.length}</span>

    <div
      class="ml-auto warming-comet"
      data-state={allDone ? "done" : "pending"}
      style="--progress: {aggregateProgress}"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={Math.round(aggregateProgress * 100)}>
      <div class="warming-comet__fill"></div>
    </div>
  </div>
{/if}

<style>
  /* ─── Strip ───────────────────────────────────────── */
  .warming-strip {
    animation: strip-in 240ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes strip-in {
    from { transform: translateY(-100%); opacity: 0; }
    to   { transform: translateY(0);     opacity: 1; }
  }

  /* The label-side dot: a small accent point with a soft glow when working,
     a calm filled dot when done. */
  .warming-strip__sweep {
    background: color-mix(in oklch, var(--color-accent) 16%, transparent);
  }
  .warming-strip__sweep[data-state="pending"] {
    background: var(--color-accent);
    box-shadow:
      0 0 0 0 color-mix(in oklch, var(--color-accent) 60%, transparent);
    animation: dot-glow 1.4s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }
  .warming-strip__sweep[data-state="done"] {
    background: var(--color-accent);
  }
  @keyframes dot-glow {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklch, var(--color-accent) 50%, transparent); }
    50%      { box-shadow: 0 0 0 5px color-mix(in oklch, var(--color-accent) 0%, transparent); }
  }

  /* Per-kind block: donut + label + readout. */
  .warming-kind {
    display: inline-flex;
    align-items: baseline;
    gap: 0.45rem;
    transition: color 220ms ease;
    color: var(--color-fg-3);
  }
  .warming-kind[data-state="done"] {
    color: var(--color-fg);
  }
  .warming-kind[data-state="error"] {
    color: var(--color-bad);
  }
  .warming-kind__donut {
    align-self: center;
  }
  .warming-kind__label {
    transition: color 220ms ease;
  }
  .warming-kind__readout {
    color: var(--color-fg);
    font-weight: 600;
    min-width: 2.5ch;
    text-align: right;
    font-variant-numeric: tabular-nums;
    transition: color 220ms ease;
  }
  .warming-kind__readout[data-state="pending"] {
    color: var(--color-accent);
    font-weight: 500;
  }
  .warming-kind__readout[data-state="error"] {
    color: var(--color-bad);
  }

  /* Donut: 14px ring. While pending, an indeterminate arc rotates around it.
     On done, the ring fills solid and a check draws in, plus a soft ring
     radiates outward once. */
  .warming-kind__donut {
    position: relative;
    width: 0.875rem;
    height: 0.875rem;
    border-radius: 50%;
    flex-shrink: 0;
    background: color-mix(in oklch, var(--color-line) 80%, transparent);
    color: var(--color-bg);
    transition: background-color 220ms ease;
  }
  .warming-kind__donut[data-state="pending"]::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 2px solid transparent;
    border-top-color: var(--color-accent);
    border-right-color: color-mix(in oklch, var(--color-accent) 35%, transparent);
    animation: donut-spin 0.95s linear infinite;
  }
  .warming-kind__donut[data-state="done"] {
    background: var(--color-accent);
  }
  .warming-kind__donut[data-state="done"]::after {
    content: "";
    position: absolute;
    inset: -3px;
    border-radius: 50%;
    border: 2px solid var(--color-accent);
    opacity: 0;
    animation: donut-ring 720ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
    pointer-events: none;
  }
  .warming-kind__donut[data-state="error"] {
    background: var(--color-bad);
  }
  .warming-kind__check {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    transform: scale(0.6);
    pointer-events: none;
  }
  .warming-kind__donut[data-state="done"] .warming-kind__check {
    opacity: 1;
    transform: scale(1);
    transition: opacity 220ms 80ms cubic-bezier(0.16, 1, 0.3, 1),
                transform 320ms 80ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .warming-kind__donut[data-state="done"] .warming-kind__check :global(path) {
    stroke-dasharray: 28;
    stroke-dashoffset: 28;
    animation: check-stroke 380ms 120ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
  @keyframes donut-spin {
    to { transform: rotate(360deg); }
  }
  @keyframes donut-ring {
    0%   { opacity: 0.7; transform: scale(0.85); }
    100% { opacity: 0;   transform: scale(2.4); }
  }
  @keyframes check-stroke {
    to { stroke-dashoffset: 0; }
  }

  /* Right-side progress bar: a thin slate track that fills with fuchsia
     as the aggregate byte progress climbs. While pending, a soft highlight
     band sweeps across the filled portion to telegraph that work is still
     in flight. When all done, the bar locks at 100% and the shimmer stops. */
  .warming-comet {
    width: 6rem;
    height: 0.25rem;
    border-radius: 9999px;
    background: color-mix(in oklch, var(--color-line) 80%, transparent);
    overflow: hidden;
    position: relative;
  }
  .warming-comet__fill {
    position: absolute;
    inset: 0 auto 0 0;
    width: calc(var(--progress, 0) * 100%);
    border-radius: inherit;
    background: linear-gradient(
      90deg,
      var(--color-accent) 0%,
      color-mix(in oklch, var(--color-accent) 50%, white) 50%,
      var(--color-accent) 100%
    );
    background-size: 220% 100%;
    background-position: 100% 0;
    transition: width 320ms cubic-bezier(0.16, 1, 0.3, 1);
    animation: comet-shimmer 1.6s linear infinite;
  }
  .warming-comet[data-state="done"] .warming-comet__fill {
    animation: none;
    background: var(--color-accent);
  }
  @keyframes comet-shimmer {
    from { background-position: 100% 0; }
    to   { background-position: -120% 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .warming-strip,
    .warming-strip__sweep[data-state="pending"],
    .warming-kind__donut[data-state="pending"]::before,
    .warming-kind__donut[data-state="done"]::after,
    .warming-comet__fill {
      animation: none !important;
    }
    .warming-comet__fill {
      transition: none !important;
      background: var(--color-accent) !important;
    }
    .warming-kind__donut[data-state="done"] .warming-kind__check :global(path) {
      stroke-dashoffset: 0 !important;
      animation: none !important;
    }
  }
</style>
