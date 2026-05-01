/**
 * Tiny logging boundary for browser-side code.
 *
 * `error` and `warn` always reach the console so production users can attach
 * stack traces to a bug report. `info` / `debug` / `log` are gated to dev so
 * they don't pollute the console in shipping builds.
 *
 * Future: route through `@tauri-apps/plugin-log` when the plugin is installed
 * on the Rust side - the JS shim accepts the same arg shape, so swapping in is
 * a one-file change here.
 *
 * Existing call sites keep their `[xt:component]` prefix as the first arg.
 */

const isDev = Boolean(import.meta.env?.DEV)

type LogFn = (...args: unknown[]) => void
const noop: LogFn = () => {}

export const log: {
    error: LogFn
    warn: LogFn
    info: LogFn
    debug: LogFn
    log: LogFn
} = {
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    info: isDev ? console.info.bind(console) : noop,
    debug: isDev ? console.debug.bind(console) : noop,
    log: isDev ? console.log.bind(console) : noop,
}
