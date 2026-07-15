// Shared constants for epg-data.js and epg-worker.ts - kept side-effect-free
// so the worker (which has no DOM) can import it safely.
export const EPG_PAST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
