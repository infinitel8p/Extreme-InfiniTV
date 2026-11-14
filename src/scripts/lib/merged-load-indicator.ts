export type MergedLoadStatus = "cached" | "loading" | "done" | "error"

export interface MergedLoadIndicatorOptions {
  host: HTMLElement
  getTitle: (playlistId: string) => string
  t: (key: string, params?: Record<string, unknown>) => string
}

export interface MergedLoadIndicator {
  setPlaylists(ids: string[]): void
  setStatus(
    id: string,
    status: MergedLoadStatus,
    info?: { count?: number; onRetry?: () => void },
  ): void
  clear(): void
}

interface PillState {
  status: MergedLoadStatus
  count?: number
  onRetry?: () => void
}

const PILL_CLASS =
  "inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 min-h-8 text-xs text-fg-2"

export function createMergedLoadIndicator(options: MergedLoadIndicatorOptions): MergedLoadIndicator {
  const { host, getTitle } = options
  let ids: string[] = []
  const states = new Map<string, PillState>()

  const translate = (key: string, params: Record<string, unknown>, fallback: string): string => {
    const text = options.t(key, params)
    return !text || text === key ? fallback : text
  }

  host.setAttribute("aria-live", "polite")

  const render = (): void => {
    if (ids.length < 2) {
      host.hidden = true
      host.replaceChildren()
      return
    }
    host.hidden = false
    const frag = document.createDocumentFragment()
    for (const id of ids) {
      const state = states.get(id) || { status: "cached" as MergedLoadStatus }
      const title = getTitle(id)
      const pill = document.createElement("span")
      pill.className = PILL_CLASS
      pill.dataset.playlistId = id
      pill.dataset.status = state.status
      const text = document.createElement("span")
      text.className = "truncate"
      if (state.status === "loading") {
        text.textContent = translate("list.merged.loading", { title }, `${title}...`)
      } else if (state.status === "error") {
        text.textContent = translate("list.merged.failed", { title }, `${title}: failed`)
      } else if (state.status === "done") {
        text.textContent = translate(
          "list.merged.loaded",
          { title, count: state.count ?? 0 },
          `${title}: ${state.count ?? 0}`,
        )
      } else {
        text.textContent = title
      }
      pill.appendChild(text)
      if (state.status === "error" && state.onRetry) {
        const retry = document.createElement("button")
        retry.type = "button"
        retry.className =
          "rounded-full px-1.5 text-accent outline-none hover:underline focus-visible:ring-1 focus-visible:ring-accent"
        retry.textContent = translate("list.merged.retry", {}, "Retry")
        retry.addEventListener("click", state.onRetry)
        pill.appendChild(retry)
      }
      frag.appendChild(pill)
    }
    host.replaceChildren(frag)
  }

  return {
    setPlaylists(nextIds) {
      ids = nextIds.slice()
      for (const id of [...states.keys()]) if (!ids.includes(id)) states.delete(id)
      render()
    },
    setStatus(id, status, info = {}) {
      states.set(id, { status, count: info.count, onRetry: info.onRetry })
      render()
    },
    clear() {
      ids = []
      states.clear()
      render()
    },
  }
}
