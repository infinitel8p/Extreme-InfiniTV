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

const isTauri =
    typeof window !== "undefined" &&
    (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)

// Mirror warn/error/info into the persistent log file (tauri-plugin-log) so
// users can attach it to a bug report. Redacted first - the file may be shared.
type PluginLog = typeof import("@tauri-apps/plugin-log")
let pluginLogPromise: Promise<PluginLog> | null = null
function toFile(level: "error" | "warn" | "info", args: unknown[]): void {
    const text = redactUrl(stringifyArgs(args))
    toSinks(level, text)
    if (!isTauri) return
    try {
        if (!pluginLogPromise) pluginLogPromise = import("@tauri-apps/plugin-log")
        void pluginLogPromise.then((mod) => mod[level](text)).catch(() => {})
    } catch {}
}

// Extra destinations for warn/error/info, fed the same redacted text the file mirror gets.
export type LogSink = (level: "error" | "warn" | "info", text: string) => void

const sinks = new Set<LogSink>()

export function addLogSink(sink: LogSink): () => void {
    sinks.add(sink)
    return () => sinks.delete(sink)
}

function toSinks(level: "error" | "warn" | "info", text: string): void {
    if (sinks.size === 0) return
    for (const sink of sinks) {
        // A throwing sink must never take down the call site it was logging for.
        try { sink(level, text) } catch {}
    }
}

// Error's message/stack are non-enumerable, so a nested one stringifies to "{}".
function errorReplacer(_key: string, value: unknown): unknown {
    if (!(value instanceof Error)) return value
    return { name: value.name, message: value.message, ...(value.stack ? { stack: value.stack } : {}) }
}

export function stringifyLogValue(value: unknown): string {
    try { return JSON.stringify(value, errorReplacer) ?? String(value) } catch { return String(value) }
}

function stringifyArgs(args: unknown[]): string {
    return args
        .map((arg) => {
            if (typeof arg === "string") return arg
            if (arg instanceof Error) return arg.stack || arg.message
            return stringifyLogValue(arg)
        })
        .join(" ")
}

// Redact string/Error/object args before they hit the console, so DevTools output matches the redacted file mirror.
// Objects only round-trip through JSON when something actually needed redacting, so untouched values (Dates, etc.) keep their original type.
export function redactArg(arg: unknown): unknown {
    if (typeof arg === "string") return redactUrl(arg)
    if (arg instanceof Error) return redactUrl(arg.stack || arg.message)
    if (arg !== null && typeof arg === "object") {
        try {
            const serialized = JSON.stringify(arg, errorReplacer)
            const redacted = redactUrl(serialized)
            if (redacted === serialized) return arg
            // A redaction that broke the JSON must still not put the raw value on the console.
            try { return JSON.parse(redacted) } catch { return redacted }
        } catch {
            return redactUrl(String(arg))
        }
    }
    return arg
}

export const log: {
    error: LogFn
    warn: LogFn
    info: LogFn
    debug: LogFn
    log: LogFn
} = {
    error: (...args) => { console.error(...args.map(redactArg)); toFile("error", args) },
    warn: (...args) => { console.warn(...args.map(redactArg)); toFile("warn", args) },
    info: (...args) => { if (isDev) console.info(...args.map(redactArg)); toFile("info", args) },
    debug: isDev ? console.debug.bind(console) : noop,
    log: isDev ? console.log.bind(console) : noop,
}

const SENSITIVE_USERINFO = /(\/\/)[^/@\s?#]+@/g

// The value class excludes `"` so redacting a URL inside JSON can't eat the closing
// quote and leave the document unparseable.
const SENSITIVE_PARAMS = /(\b(?:username|user|password|pass|token|authorization|auth|key|api_key|apikey)=)([^&#\s"]*)/gi

const SENSITIVE_PATH =
    /(\/(?:live|movie|series|timeshift|hls|hlsr)\/)([^/\s?#]+)\/([^/\s?#]+)(\/)/gi

// Same sensitive key list as SENSITIVE_PARAMS, shaped for JSON.stringify() output ("key":"value") instead of a query string.
const SENSITIVE_JSON_VALUE =
    /("(?:username|user|password|pass|token|authorization|auth|key|api_key|apikey)"\s*:\s*)"([^"]*)"/gi

export function redactUrl(input: unknown): string {
    if (input == null) return ""
    const text = typeof input === "string" ? input : String(input)
    return text
        .replace(SENSITIVE_USERINFO, "$1***@")
        .replace(SENSITIVE_PARAMS, (_match, prefix) => `${prefix}***`)
        .replace(SENSITIVE_PATH, (_match, prefix) => `${prefix}***/***/`)
        .replace(SENSITIVE_JSON_VALUE, (_match, prefix) => `${prefix}"***"`)
}

function redactDeepInner(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === "string") return redactUrl(value)
    if (Array.isArray(value)) {
        if (seen.has(value)) return "[circular]"
        seen.add(value)
        return value.map((item) => redactDeepInner(item, seen))
    }
    if (value !== null && typeof value === "object") {
        if (seen.has(value)) return "[circular]"
        seen.add(value)
        const redacted: Record<string, unknown> = {}
        for (const [key, fieldValue] of Object.entries(value)) redacted[key] = redactDeepInner(fieldValue, seen)
        return redacted
    }
    return value
}

// Recursively redacts every string field of a value; guards against circular refs.
export function redactDeep(value: unknown): unknown {
    return redactDeepInner(value, new WeakSet())
}
