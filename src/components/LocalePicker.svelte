<script>
  import { onMount } from "svelte"
  import {
    getActiveLocale,
    getAvailableLocales,
    setLocale,
    t,
    LOCALE_EVENT,
  } from "@/scripts/lib/i18n.js"

  let active = $state(getActiveLocale())
  let locales = $state(getAvailableLocales())
  let label = $state(t("settings.language.label"))
  let helper = $state(t("settings.language.helper"))
  let systemOption = $state(t("settings.language.system"))

  function onChange(event) {
    const next = event.target.value
    if (next === "__system") {
      setLocale(null)
    } else {
      setLocale(next)
    }
  }

  function refresh() {
    active = getActiveLocale()
    locales = getAvailableLocales()
    label = t("settings.language.label")
    helper = t("settings.language.helper")
    systemOption = t("settings.language.system")
  }

  onMount(() => {
    // The $state initializers above run synchronously when the component is
    // hydrated. If initI18n() is still in flight (race on first paint), they
    // snapshot English. Re-read once on mount so we land on the resolved
    // locale without waiting for the next LOCALE_EVENT fire.
    refresh()
    document.addEventListener(LOCALE_EVENT, refresh)
    return () => document.removeEventListener(LOCALE_EVENT, refresh)
  })
</script>

<label class="flex flex-col gap-1.5">
  <span class="text-sm text-fg-2">{label}</span>
  <select
    onchange={onChange}
    value={active}
    class="field-input">
    <option value="__system">{systemOption}</option>
    {#each locales as locale (locale.code)}
      <option value={locale.code}>{locale.nativeName} ({locale.code})</option>
    {/each}
  </select>
  <span class="text-xs text-fg-3">{helper}</span>
</label>
