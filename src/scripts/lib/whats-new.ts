// "What's new" dialog: shown once on the first launch after the app version
// increases (the pattern most desktop apps and games use). Reuses the same
// GitHub release fetch + markdown pipeline as the Settings "What's new" panel,
// so the notes read identically. Mounted from Layout.astro.
//
// Baseline behaviour: the last-seen version defaults to "1.0.0" when nothing is
// stored, so a fresh install still sees the current release's notes on first
// launch. After that, only a version *bump* triggers the notes for everything
// released between the last-seen version and the current one.

import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import type { ReleaseSummary } from "@/scripts/lib/changelog.js"
import { filterReleasesForDisplay } from "@/scripts/lib/changelog.js"
import { compareVersions } from "@/scripts/lib/version-compare.js"

type RenderMarkdown = (source: string) => Promise<string>
import { ICON_SPARKLES } from "@/scripts/lib/icons.js"
import { t } from "@/scripts/lib/i18n.js"
import { log } from "@/scripts/lib/log.js"

const STORAGE_KEY = "xt_last_seen_version"
const DIALOG_ID = "xt-whats-new-dialog"

async function getCurrentVersion(): Promise<string | null> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app")
    return await getVersion()
  } catch {
    const meta = document
      .querySelector('meta[name="x-app-version"]')
      ?.getAttribute("content")
    return meta || null
  }
}

function readLastSeen(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeLastSeen(version: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, version)
  } catch {}
}

function formatDate(iso?: string): string {
  if (!iso) return ""
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    })
  } catch {
    return ""
  }
}

const CLOSE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true" class="size-5"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'

function buildDialog(
  version: string,
  releases: ReleaseSummary[],
  renderMarkdown: RenderMarkdown
): HTMLDialogElement {
  const node = document.createElement("dialog")
  node.id = DIALOG_ID
  node.setAttribute("aria-labelledby", `${DIALOG_ID}-title`)
  node.className = [
    "fixed inset-0 m-auto rounded-2xl border border-line bg-surface text-fg p-0",
    "w-[min(40rem,calc(100vw-2rem))] max-h-[85vh]",
    "open:flex flex-col overflow-hidden",
    "icon-mark-host",
    "backdrop:bg-black/70",
  ].join(" ")

  const header = document.createElement("div")
  header.className =
    "shrink-0 flex items-start gap-3 px-5 sm:px-6 pt-5 pb-4 border-b border-line/60"
  header.innerHTML = `
    <span class="icon-mark icon-mark--sparkle mt-0.5">${ICON_SPARKLES}</span>
    <div class="flex flex-col gap-1 flex-1 min-w-0">
      <h2 id="${DIALOG_ID}-title" class="text-lg font-semibold"></h2>
      <p data-role="subtitle" class="text-sm text-fg-2"></p>
    </div>
    <button
      data-role="close-x"
      type="button"
      class="shrink-0 -mt-1 -mr-1 rounded-lg p-2 text-fg-3 hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent">
      ${CLOSE_ICON}
    </button>
  `

  const titleEl = header.querySelector("h2") as HTMLElement
  const VERSION_SLOT = "\uE000"
  const [beforeVersion, afterVersion = ""] = t("whatsNew.title", {
    version: VERSION_SLOT,
  }).split(VERSION_SLOT)
  const versionEl = document.createElement("span")
  versionEl.className = "text-accent"
  versionEl.textContent = `v${version}`
  titleEl.append(
    document.createTextNode(beforeVersion),
    versionEl,
    document.createTextNode(afterVersion)
  )
  const subtitleEl = header.querySelector('[data-role="subtitle"]') as HTMLElement
  subtitleEl.textContent = t("whatsNew.subtitle")

  const closeXBtn = header.querySelector(
    '[data-role="close-x"]'
  ) as HTMLButtonElement
  closeXBtn.setAttribute("aria-label", t("common.close"))

  const body = document.createElement("div")
  body.className =
    "flex-auto min-h-0 overflow-y-auto overscroll-contain px-5 sm:px-6 py-4 flex flex-col gap-6"
  body.tabIndex = 0

  const stagger = releases.length > 1
  releases.forEach((release, index) => {
    const section = document.createElement("section")
    section.className = "flex flex-col gap-2"
    if (stagger) {
      section.classList.add("xt-wn-section")
      section.style.animationDelay = `${140 + index * 80}ms`
    }

    const heading = document.createElement("div")
    heading.className = "flex items-baseline gap-3 flex-wrap"
    const tag = document.createElement("span")
    tag.className = "font-semibold text-sm tabular-nums"
    tag.textContent = release.name || release.tagName
    heading.appendChild(tag)
    const dateText = formatDate(release.publishedAt)
    if (dateText) {
      const date = document.createElement("time")
      date.className = "text-xs text-fg-3 tabular-nums"
      if (release.publishedAt) date.dateTime = release.publishedAt
      date.textContent = dateText
      heading.appendChild(date)
    }
    section.appendChild(heading)

    const content = document.createElement("div")
    content.className = "changelog-md text-sm text-fg-2"
    renderMarkdown(release.body || "").then((html) => {
      content.innerHTML = html
    })
    section.appendChild(content)

    body.appendChild(section)
  })

  const footer = document.createElement("div")
  footer.className =
    "shrink-0 flex justify-end gap-2 px-5 sm:px-6 py-4 border-t border-line/60"
  const gotItBtn = document.createElement("button")
  gotItBtn.type = "button"
  gotItBtn.dataset.role = "got-it"
  gotItBtn.className =
    "rounded-xl px-4 py-2 text-sm font-semibold bg-accent text-bg " +
    "hover:opacity-90 focus-visible:opacity-90 focus-visible:outline-none " +
    "focus-visible:ring-1 focus-visible:ring-accent"
  gotItBtn.textContent = t("whatsNew.gotIt")
  footer.appendChild(gotItBtn)

  node.appendChild(header)
  node.appendChild(body)
  node.appendChild(footer)
  document.body.appendChild(node)

  attachDialogSpatialNav(node, {
    selector: `#${DIALOG_ID} button, #${DIALOG_ID} a[href]`,
    defaultElement: `#${DIALOG_ID} [data-role="got-it"]`,
  })

  const dismiss = () => node.close()
  closeXBtn.addEventListener("click", dismiss)
  gotItBtn.addEventListener("click", dismiss)

  node.addEventListener("click", (event) => {
    if (event.target === node) node.close()
  })
  node.addEventListener("close", () => node.remove())

  return node
}

async function maybeShowWhatsNew(): Promise<void> {
  const pathname = location.pathname || "/"
  if (pathname === "/login" || pathname.startsWith("/login/")) return
  if (document.getElementById(DIALOG_ID)) return

  const current = await getCurrentVersion()
  if (!current) return

  const lastSeen = readLastSeen() || "1.0.0"

  if (compareVersions(current, lastSeen) <= 0) return

  const { fetchReleases, renderMarkdown } = await import(
    "@/scripts/lib/changelog.js"
  )

  let releases: ReleaseSummary[]
  try {
    releases = await fetchReleases()
  } catch (error) {
    log.error("[whats-new] release fetch failed:", error)
    return
  }

  const fresh = filterReleasesForDisplay(releases, current).filter((release) => {
    const version = release.tagName
    return (
      compareVersions(version, lastSeen) > 0 &&
      compareVersions(version, current) <= 0
    )
  })

  if (!fresh.length) return

  writeLastSeen(current)

  const dialog = buildDialog(current, fresh, renderMarkdown)
  if (typeof dialog.showModal === "function") dialog.showModal()
  else dialog.setAttribute("open", "")
}

function afterSplash(callback: () => void): void {
  const root = document.documentElement
  if (root.hasAttribute("data-splash-done")) {
    callback()
    return
  }
  const observer = new MutationObserver(() => {
    if (root.hasAttribute("data-splash-done")) {
      observer.disconnect()
      callback()
    }
  })
  observer.observe(root, {
    attributes: true,
    attributeFilter: ["data-splash-done"],
  })
  setTimeout(() => {
    observer.disconnect()
    callback()
  }, 6000)
}

export function initWhatsNew(): void {
  afterSplash(() => {
    setTimeout(() => {
      maybeShowWhatsNew().catch((error) =>
        log.error("[whats-new] failed:", error)
      )
    }, 400)
  })
}
