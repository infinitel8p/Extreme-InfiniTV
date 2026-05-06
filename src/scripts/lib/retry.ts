// Exponential-backoff retry helper. Used by catalog / EPG / account-info
// fetchers so a single transient 5xx doesn't kill a whole warmup.

export interface RetryOptions {
  tries?: number
  baseMs?: number
  maxMs?: number
  signal?: AbortSignal
}

export class HttpRetryError extends Error {
  status: number
  constructor(status: number, message?: string) {
    super(message || `HTTP ${status}`)
    this.status = status
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"))
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error("aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })

function shouldGiveUp(error: unknown): boolean {
  if (!error) return false
  // Caller cancellation - never retry.
  if (error instanceof DOMException && error.name === "AbortError") return true
  // 4xx is the user's problem (wrong creds / not found / forbidden).
  // Throw HttpRetryError(status) from the body of fn() to opt in.
  if (error instanceof HttpRetryError) {
    return error.status >= 400 && error.status < 500
  }
  return false
}

/**
 * Run `fn` up to `tries` times with exponential backoff.
 * - 4xx errors thrown as HttpRetryError short-circuit.
 * - AbortError propagates immediately.
 * - Network / 5xx / TimeoutError get retried.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const tries = Math.max(1, options.tries ?? 3)
  const baseMs = Math.max(1, options.baseMs ?? 500)
  const maxMs = Math.max(baseMs, options.maxMs ?? 4000)
  const signal = options.signal

  let lastError: unknown = null
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted")
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (shouldGiveUp(error) || attempt === tries) throw error
      const delay = Math.min(maxMs, baseMs * 2 ** (attempt - 1))
      const jitter = Math.floor(Math.random() * Math.min(250, delay / 2))
      await sleep(delay + jitter, signal)
    }
  }
  throw lastError
}
