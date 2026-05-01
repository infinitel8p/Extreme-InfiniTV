<script>
  // Thin top-of-page progress bar shown while the catalog is warming.

  import { onMount } from "svelte"
  import { KIND_ORDER, kindLabelPlural } from "@/scripts/lib/kinds.js"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"

  const SHOW_AFTER_MS = 150
  const HOLD_AFTER_DONE_MS = 350

  let active = $state(false)
  /** @type {{ live: "pending"|"done"|"error", vod: "pending"|"done"|"error", series: "pending"|"done"|"error" }} */
  let kinds = $state({ live: "pending", vod: "pending", series: "pending" })
  let locale = $state(0)
  // Wrappers read the locale rune so {tr(...)} / {klp(...)} template effects
  // track it and re-evaluate on LOCALE_EVENT.
  const tr = (key, params) => (locale, t(key, params))
  const klp = (kind) => (locale, kindLabelPlural(kind))

  let _showTimer = null
  let _doneSeen = false

  function start() {
    _doneSeen = false
    kinds = { live: "pending", vod: "pending", series: "pending" }
    if (_showTimer) clearTimeout(_showTimer)
    _showTimer = setTimeout(() => {
      _showTimer = null
      // Only flip on if warmup hasn't already finished.
      if (!_doneSeen) active = true
    }, SHOW_AFTER_MS)
  }

  function progress(ev) {
    const d = ev.detail
    if (!d?.kind) return
    kinds[d.kind] =
      d.status === "done" ? "done" : d.status === "error" ? "error" : "pending"
    kinds = kinds
  }

  function done() {
    _doneSeen = true
    if (_showTimer) {
      clearTimeout(_showTimer)
      _showTimer = null
      return
    }
    setTimeout(() => {
      active = false
    }, HOLD_AFTER_DONE_MS)
  }

  const onLocale = () => { locale++ }

  onMount(() => {
    document.addEventListener("xt:catalog-warming-start", start)
    document.addEventListener("xt:catalog-warming-progress", progress)
    document.addEventListener("xt:catalog-warmed", done)
    document.addEventListener(LOCALE_EVENT, onLocale)
    return () => {
      document.removeEventListener("xt:catalog-warming-start", start)
      document.removeEventListener("xt:catalog-warming-progress", progress)
      document.removeEventListener("xt:catalog-warmed", done)
      document.removeEventListener(LOCALE_EVENT, onLocale)
      if (_showTimer) clearTimeout(_showTimer)
    }
  })

  let doneCount = $derived(
    KIND_ORDER.reduce((n, k) => (kinds[k] !== "pending" ? n + 1 : n), 0)
  )
  let pct = $derived((doneCount / KIND_ORDER.length) * 100)
</script>

{#if active}
  <div
    class="warming fixed left-0 right-0 z-10000 flex items-center gap-2.5 px-3 py-1.5
           bg-bg border-b border-line text-2xs text-fg-2 sm:bg-bg/95 sm:backdrop-blur"
    style="top: env(safe-area-inset-top, 0)"
    role="status"
    aria-live="polite">
    <svg viewBox="0 0 24 24" width="0.875rem" height="0.875rem" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" class="animate-spin shrink-0 text-fg-3">
      <path d="M21 12a9 9 0 1 1-6.2-8.55"/>
    </svg>
    <span>{tr("catalog.warming")}</span>
    <span class="hidden sm:flex items-center gap-2.5 ml-0.5">
      {#each KIND_ORDER as k}
        <span class="flex items-center gap-1">
          <span
            class="kind-dot size-1.5 rounded-full transition-colors duration-200"
            data-state={kinds[k]}
            class:bg-fg-3={kinds[k] === "pending"}
            class:bg-ok={kinds[k] === "done"}
            class:bg-bad={kinds[k] === "error"}
            aria-hidden="true"></span>
          <span
            class="transition-colors duration-200"
            class:text-fg={kinds[k] === "done"}
            class:text-fg-3={kinds[k] === "pending"}
            class:text-bad={kinds[k] === "error"}>
            {klp(k)}
          </span>
        </span>
      {/each}
    </span>
    <span class="sm:hidden text-fg-3 tabular-nums ml-0.5">{doneCount}/{KIND_ORDER.length}</span>
    <div class="ml-auto h-1 w-24 rounded-full bg-surface-2 overflow-hidden hidden sm:block">
      <div
        class="h-full bg-accent transition-[width] duration-200 ease-out"
        style:width={pct + "%"}></div>
    </div>
  </div>
{/if}

<style>
  .warming {
    animation: warming-in 200ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes warming-in {
    from { transform: translateY(-100%); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .kind-dot[data-state="done"],
  .kind-dot[data-state="error"] {
    animation: dot-land 320ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes dot-land {
    0%   { transform: scale(1); }
    40%  { transform: scale(1.6); }
    100% { transform: scale(1); }
  }

  @media (prefers-reduced-motion: reduce) {
    .warming { animation: none; }
    .kind-dot { animation: none !important; }
  }
</style>
