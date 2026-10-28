// @vitest-environment jsdom
// tauri-plugin-http reports aborts as plain Errors. Unnormalized, a provider timeout read as a
// network fault: a pointless native re-fetch, "unreachable" copy, and three retries of a cancel.
import { describe, it, expect, beforeEach, vi } from "vitest"

vi.mock("@/scripts/lib/app-settings.js", () => ({
  getUserAgent: () => "",
  getNetworkTimeoutSeconds: () => networkTimeoutSeconds,
  getGlobalDns: () => null,
  DNS_EVENT: "xt:dns-changed",
}))

let networkTimeoutSeconds = 15

const warnings: string[] = []
vi.mock("@/scripts/lib/log.js", async () => {
  const actual = await vi.importActual<typeof import("@/scripts/lib/log")>("@/scripts/lib/log.js")
  return {
    ...actual,
    log: {
      log: () => {},
      info: () => {},
      error: () => {},
      warn: (...args: unknown[]) => warnings.push(args.map(String).join(" ")),
    },
  }
})

let tauriFetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () =>
  new Response(null, { status: 200 })

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string, init?: RequestInit) => tauriFetchImpl(url, init),
}))

async function loadProviderFetch(tauri: boolean) {
  if (tauri) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  return import("@/scripts/lib/provider-fetch.js")
}

beforeEach(() => {
  vi.resetModules()
  warnings.length = 0
  networkTimeoutSeconds = 15
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  delete (window as unknown as Record<string, unknown>).__TAURI__
  tauriFetchImpl = async () => new Response(null, { status: 200 })
})

describe("isAbortLikeError", () => {
  it("recognizes the standard abort and timeout names without needing a signal", async () => {
    const { isAbortLikeError } = await loadProviderFetch(false)
    expect(isAbortLikeError(new DOMException("x", "AbortError"))).toBe(true)
    expect(isAbortLikeError(new DOMException("x", "TimeoutError"))).toBe(true)
  })

  it("recognizes the plugin's abort messages only when the signal actually aborted", async () => {
    const { isAbortLikeError } = await loadProviderFetch(false)
    const aborted = { aborted: true } as AbortSignal
    const live = { aborted: false } as AbortSignal
    for (const message of ["Request canceled", "The resource id 3628484489 is invalid."]) {
      expect(isAbortLikeError(new Error(message), aborted)).toBe(true)
      // Same text with a live signal is a genuine fault, not an abort.
      expect(isAbortLikeError(new Error(message), live)).toBe(false)
    }
  })

  it("does not mistake an ordinary transport failure for an abort", async () => {
    const { isAbortLikeError } = await loadProviderFetch(false)
    const aborted = { aborted: true } as AbortSignal
    expect(isAbortLikeError(new Error("Load failed"), aborted)).toBe(false)
    expect(isAbortLikeError(null, aborted)).toBe(false)
  })
})

describe("providerFetch abort classification on the tauri transport", () => {
  it("surfaces a caller abort as an AbortError so retry.ts stops retrying", async () => {
    const controller = new AbortController()
    tauriFetchImpl = async () => {
      controller.abort()
      throw new Error("Request canceled")
    }
    const nativeMock = vi.fn(async () => new Response(null, { status: 200 }))
    globalThis.fetch = nativeMock as unknown as typeof fetch

    const { providerFetch } = await loadProviderFetch(true)
    const error = await providerFetch("http://p.test/player_api.php", { signal: controller.signal }).catch(
      (err) => err
    )

    expect(error).toBeInstanceOf(DOMException)
    expect((error as DOMException).name).toBe("AbortError")
    expect(nativeMock).not.toHaveBeenCalled()
  })

  // The logged bug: providerFetch's own timeout signal was invisible to every abort check.
  it("surfaces its own timeout as a TimeoutError instead of falling back to native", async () => {
    networkTimeoutSeconds = 0.01
    tauriFetchImpl = async (_url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 40))
      if (init?.signal?.aborted) throw new Error("The resource id 3628484489 is invalid.")
      return new Response(null, { status: 200 })
    }
    const nativeMock = vi.fn(async () => new Response(null, { status: 200 }))
    globalThis.fetch = nativeMock as unknown as typeof fetch

    const { providerFetch } = await loadProviderFetch(true)
    const error = await providerFetch("http://p.test/player_api.php").catch((err) => err)

    expect(error).toBeInstanceOf(DOMException)
    expect((error as DOMException).name).toBe("TimeoutError")
    expect(nativeMock).not.toHaveBeenCalled()
    expect(warnings.join(" ")).not.toContain("falling back to native")
  })

  it("classifies its own timeout as a timeout for the user-facing message", async () => {
    networkTimeoutSeconds = 0.01
    tauriFetchImpl = async (_url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 40))
      if (init?.signal?.aborted) throw new Error("Request canceled")
      return new Response(null, { status: 200 })
    }
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch

    const { providerFetch } = await loadProviderFetch(true)
    const error = await providerFetch("http://p.test/player_api.php").catch((err) => err)
    const { classifyError } = await import("@/scripts/lib/provider-error.js")

    expect(classifyError({ error }).kind).toBe("timeout")
  })

  it("still falls back to native for a real transport failure", async () => {
    tauriFetchImpl = async () => {
      throw new Error("error sending request for url")
    }
    const nativeMock = vi.fn(async () => new Response(null, { status: 200 }))
    globalThis.fetch = nativeMock as unknown as typeof fetch

    const { providerFetch } = await loadProviderFetch(true)
    const response = await providerFetch("http://p.test/player_api.php")

    expect(response.status).toBe(200)
    expect(nativeMock).toHaveBeenCalledTimes(1)
    expect(warnings.join(" ")).toContain("falling back to native")
  })

  it("records an abort as aborted rather than a failure in the net log", async () => {
    networkTimeoutSeconds = 0.01
    tauriFetchImpl = async (_url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 40))
      if (init?.signal?.aborted) throw new Error("Request canceled")
      return new Response(null, { status: 200 })
    }
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch

    const { providerFetch, getProviderStats } = await loadProviderFetch(true)
    await providerFetch("http://p.test/player_api.php").catch(() => {})

    const { getNetworkLog } = await import("@/scripts/lib/net-log")
    expect(getNetworkLog().entries.at(-1)?.outcome).toBe("aborted")
    expect(getProviderStats().failures).toBe(0)
  })
})

// plugin-http cancels the Rust request/body resources from its own abort listener without catching
// the invoke, so our request timeout firing after a drained response spammed the console with
// "Uncaught (in promise) The resource id N is invalid." for a resource Rust had already freed.
describe("plugin cleanup noise", () => {
  it("recognizes only the freed-resource-id rejection", async () => {
    const { isPluginCleanupNoise } = await loadProviderFetch(false)
    expect(isPluginCleanupNoise(new Error("The resource id 3628484489 is invalid."))).toBe(true)
    expect(isPluginCleanupNoise("The resource id 12 is invalid")).toBe(true)
    expect(isPluginCleanupNoise(new Error("Request canceled"))).toBe(false)
    expect(isPluginCleanupNoise(new Error("resource id 12 is invalid, and so is the request"))).toBe(false)
    expect(isPluginCleanupNoise(null)).toBe(false)
  })

  it("swallows that rejection on the tauri transport only", async () => {
    await loadProviderFetch(true)
    const noise = new PromiseRejectionEvent("unhandledrejection", {
      promise: Promise.reject(new Error("The resource id 42 is invalid.")).catch(() => {}) as Promise<never>,
      reason: new Error("The resource id 42 is invalid."),
      cancelable: true,
    })
    window.dispatchEvent(noise)
    expect(noise.defaultPrevented).toBe(true)

    const real = new PromiseRejectionEvent("unhandledrejection", {
      promise: Promise.resolve() as Promise<never>,
      reason: new TypeError("Failed to fetch"),
      cancelable: true,
    })
    window.dispatchEvent(real)
    expect(real.defaultPrevented).toBe(false)
  })
})

describe("retry interaction", () => {
  it("gives up immediately on a caller abort routed through the tauri transport", async () => {
    const controller = new AbortController()
    tauriFetchImpl = async () => {
      controller.abort()
      throw new Error("Request canceled")
    }
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch

    const { providerFetch } = await loadProviderFetch(true)
    const { retryWithBackoff } = await import("@/scripts/lib/retry")

    let attempts = 0
    await retryWithBackoff(
      () => {
        attempts++
        return providerFetch("http://p.test/player_api.php", { signal: controller.signal })
      },
      { tries: 3, baseMs: 1 }
    ).catch(() => {})

    expect(attempts).toBe(1)
  })
})
