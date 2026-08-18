<script>
  // Controller that renders the user's chosen hub strips in order.
  // Backed by `xt_hub_strips` in localStorage via app-settings.js.
  // Re-renders on HUB_STRIPS_EVENT so changes from /settings apply live.
  import { onMount } from "svelte"
  import {
    getHubStrips,
    HUB_STRIPS_EVENT,
  } from "@/scripts/lib/app-settings.js"
  import ContinueWatching from "./ContinueWatching.svelte"
  import BecauseWatchedStrip from "./BecauseWatchedStrip.svelte"
  import FavoritesStrip from "./FavoritesStrip.svelte"
  import WatchlistStrip from "./WatchlistStrip.svelte"
  import RecentlyAddedStrip from "./RecentlyAddedStrip.svelte"

  let strips = $state(getHubStrips())

  onMount(() => {
    const onChanged = () => { strips = getHubStrips() }
    document.addEventListener(HUB_STRIPS_EVENT, onChanged)
    return () => document.removeEventListener(HUB_STRIPS_EVENT, onChanged)
  })
</script>

{#each strips as strip (strip.id)}
  {#if strip.type === "continue-watching"}
    <ContinueWatching />
  {:else if strip.type === "because-watched"}
    <BecauseWatchedStrip />
  {:else if strip.type === "favorites"}
    <FavoritesStrip kind={strip.kind} />
  {:else if strip.type === "watchlist"}
    <WatchlistStrip kind={strip.kind} />
  {:else if strip.type === "recently-added"}
    <RecentlyAddedStrip kind={strip.kind} />
  {/if}
{/each}
