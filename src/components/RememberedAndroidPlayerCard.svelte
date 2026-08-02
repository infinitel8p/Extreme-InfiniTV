<script>
  // "Default external player" card - Android Tauri only. Visible when the
  // user has previously ticked "Always use this app" inside the player
  // picker. Clearing it brings the picker back on the next external launch.
  import { onMount } from "svelte"
  import { IconX } from "@tabler/icons-svelte"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
  import {
    getRememberedAndroidPlayer,
    clearRememberedAndroidPlayer,
    ANDROID_REMEMBERED_PLAYER_EVENT,
  } from "@/scripts/lib/app-settings.js"

  let available = $state(false)
  let remembered = $state(getRememberedAndroidPlayer())
  let locale = $state(0)
  const tr = (key, params) => (locale, t(key, params))

  function clearChoice() {
    clearRememberedAndroidPlayer()
  }

  onMount(() => {
    available =
      !!(window.__TAURI_INTERNALS__ || window.__TAURI__) &&
      /Android/i.test(navigator.userAgent || "")
    const onChange = (event) => {
      const next = event?.detail?.value
      remembered = next || getRememberedAndroidPlayer()
    }
    const onLocale = () => { locale++ }
    document.addEventListener(ANDROID_REMEMBERED_PLAYER_EVENT, onChange)
    document.addEventListener(LOCALE_EVENT, onLocale)
    return () => {
      document.removeEventListener(ANDROID_REMEMBERED_PLAYER_EVENT, onChange)
      document.removeEventListener(LOCALE_EVENT, onLocale)
    }
  })
</script>

{#if available && remembered}
  <div
    id="android-default-player-section"
    data-settings-item
    class="settings-row scroll-mt-6 lg:scroll-mt-20 border-t border-line/60">
    <div class="settings-row__text">
      <h3 class="text-sm font-medium leading-snug">{tr("settings.androidDefaultPlayer.title")}</h3>
      <p class="text-xs text-fg-3">{tr("settings.androidDefaultPlayer.helper")}</p>
    </div>
    <div class="settings-row__control">
      <div class="flex items-center gap-2.5 min-w-0">
        {#if remembered.icon}
          <img
            src={remembered.icon}
            alt=""
            aria-hidden="true"
            loading="eager"
            decoding="sync"
            class="shrink-0 w-8 h-8 rounded-lg object-contain bg-surface-2"
          />
        {:else}
          <span
            aria-hidden="true"
            class="shrink-0 w-8 h-8 rounded-lg bg-surface-2 grid place-items-center text-fg-3 text-xs font-semibold">
            {(remembered.label || remembered.pkg).charAt(0).toUpperCase()}
          </span>
        {/if}
        <span class="flex flex-col min-w-0">
          <span class="text-sm font-medium leading-snug truncate">{remembered.label || remembered.pkg}</span>
          <span class="text-xs text-fg-3 truncate">{remembered.pkg}</span>
        </span>
      </div>
      <button
        type="button"
        class="btn text-fg-2 shrink-0"
        onclick={clearChoice}
        aria-label={tr("settings.androidDefaultPlayer.clear")}>
        <IconX aria-hidden="true" class="btn-icon" />
        <span class="hidden sm:inline">{tr("settings.androidDefaultPlayer.clear")}</span>
      </button>
    </div>
  </div>
{/if}
