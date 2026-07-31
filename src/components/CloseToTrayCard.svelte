<script>
  // "Close button behavior" card - desktop Tauri only. Stays hidden on web
  // and Android where the X is owned by the OS / browser. setCloseToTray()
  // pushes the new value to the Rust side via a Tauri command so the
  // window-event handler picks it up immediately.
  import { onMount } from "svelte"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
  import {
    getCloseToTray,
    setCloseToTray,
    CLOSE_TO_TRAY_EVENT,
  } from "@/scripts/lib/app-settings.js"

  let available = $state(false)
  let closeToTray = $state(getCloseToTray())
  let locale = $state(0)
  const tr = (key) => (locale, t(key))

  function pick(value) {
    setCloseToTray(value)
  }

  onMount(() => {
    available =
      !!(window.__TAURI_INTERNALS__ || window.__TAURI__) &&
      !/Android/i.test(navigator.userAgent || "")
    const onChange = (event) => {
      const next = event?.detail?.value
      closeToTray = typeof next === "boolean" ? next : getCloseToTray()
    }
    const onLocale = () => { locale++ }
    document.addEventListener(CLOSE_TO_TRAY_EVENT, onChange)
    document.addEventListener(LOCALE_EVENT, onLocale)
    return () => {
      document.removeEventListener(CLOSE_TO_TRAY_EVENT, onChange)
      document.removeEventListener(LOCALE_EVENT, onLocale)
    }
  })
</script>

{#if available}
  <div
    id="close-behavior-section"
    data-settings-item
    class="settings-row scroll-mt-6 lg:scroll-mt-20 border-t border-line/60">
    <div class="settings-row__text">
      <h3 class="text-sm font-medium leading-snug">{tr("settings.closeBehavior.title")}</h3>
      <p id="close-behavior-helper" class="text-xs text-fg-3">{tr("settings.closeBehavior.helper")}</p>
    </div>
    <div class="settings-row__control">
      <div
        class="settings-seg"
        role="radiogroup"
        aria-label={tr("settings.closeBehavior.label")}
        aria-describedby="close-behavior-helper">
        <button
          type="button"
          role="radio"
          class="btn"
          aria-checked={closeToTray ? "true" : "false"}
          onclick={() => pick(true)}>
          {tr("settings.closeBehavior.tray")}
        </button>
        <button
          type="button"
          role="radio"
          class="btn"
          aria-checked={!closeToTray ? "true" : "false"}
          onclick={() => pick(false)}>
          {tr("settings.closeBehavior.quit")}
        </button>
      </div>
    </div>
  </div>
{/if}
