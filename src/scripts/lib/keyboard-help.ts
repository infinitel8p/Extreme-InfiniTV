// @ts-nocheck - migrated to TS shell; strict typing pending follow-up
// Keyboard-shortcut help overlay. Press `?` (Shift+/) anywhere to open it.

import { t } from "@/scripts/lib/i18n.js"

const DIALOG_ID = "xt-keyboard-help"

function buildSections() {
  return [
    {
      title: t("keyboardHelp.section.global"),
      items: [
        { keys: ["Ctrl", "K"], desc: t("keyboardHelp.desc.openSearch") },
        { keys: ["?"], desc: t("keyboardHelp.desc.showHelp") },
        { keys: ["Esc"], desc: t("keyboardHelp.desc.closeDialogs") },
      ],
    },
    {
      title: t("keyboardHelp.section.livetvList"),
      items: [
        { keys: ["0", "9"], joiner: t("keyboardHelp.joiner.to"), desc: t("keyboardHelp.desc.jumpChannelNumber") },
        { keys: ["Enter"], desc: t("keyboardHelp.desc.commitNumber") },
        { keys: ["["], desc: t("keyboardHelp.desc.previousChannel") },
        { keys: ["]"], desc: t("keyboardHelp.desc.nextChannel") },
        { keys: ["↑", "↓"], joiner: t("keyboardHelp.joiner.slash"), desc: t("keyboardHelp.desc.moveRow") },
        { keys: ["PgUp", "PgDn"], joiner: t("keyboardHelp.joiner.slash"), desc: t("keyboardHelp.desc.movePage") },
        { keys: ["Home", "End"], joiner: t("keyboardHelp.joiner.slash"), desc: t("keyboardHelp.desc.firstLast") },
      ],
    },
    {
      title: t("keyboardHelp.section.player"),
      items: [
        { keys: ["Space"], desc: t("keyboardHelp.desc.playPause") },
        { keys: ["M"], desc: t("keyboardHelp.desc.muteToggle") },
        { keys: ["F"], desc: t("keyboardHelp.desc.fullscreenToggle") },
        { keys: ["J"], desc: t("keyboardHelp.desc.seekBack") },
        { keys: ["L"], desc: t("keyboardHelp.desc.seekForward") },
      ],
    },
  ]
}

function isTypingTarget(target) {
  if (!target) return false
  const el = /** @type {HTMLElement} */ (target)
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  return false
}

function renderKey(label) {
  return (
    '<kbd class="inline-flex items-center justify-center min-w-7 h-7 px-2 ' +
    "rounded-md border border-line bg-surface-2 text-fg text-2xs font-sans " +
    'font-semibold tabular-nums tracking-wide">' +
    escapeHtml(label) +
    "</kbd>"
  )
}

function renderItem(item) {
  const keys = item.keys || []
  const joiner = item.joiner || ""
  let keyHtml = ""
  if (keys.length === 1) {
    keyHtml = renderKey(keys[0])
  } else if (joiner) {
    keyHtml = keys
      .map((k) => renderKey(k))
      .join(`<span class="text-fg-3 mx-1.5 text-2xs">${escapeHtml(joiner)}</span>`)
  } else {
    keyHtml = keys
      .map((k) => renderKey(k))
      .join('<span class="text-fg-3 mx-0.5 text-2xs">+</span>')
  }
  return (
    '<li class="flex items-center justify-between gap-4 py-1.5">' +
    `<span class="text-sm text-fg-2 truncate">${escapeHtml(item.desc)}</span>` +
    `<span class="flex items-center shrink-0">${keyHtml}</span>` +
    "</li>"
  )
}

function escapeHtml(text) {
  const div = document.createElement("div")
  div.textContent = String(text || "")
  return div.innerHTML
}

let dialog = null

function buildDialog() {
  if (dialog) return dialog
  dialog = document.createElement("dialog")
  dialog.id = DIALOG_ID
  dialog.setAttribute("aria-labelledby", DIALOG_ID + "-title")
  dialog.className =
    "fixed inset-0 m-auto rounded-2xl border border-line bg-surface text-fg p-0 " +
    "w-[min(34rem,calc(100vw-2rem))] max-h-[min(80dvh,38rem)] backdrop:bg-black/60"

  const sectionsHtml = buildSections().map(
    (section) =>
      '<section class="flex flex-col gap-1.5">' +
      `<h3 class="text-eyebrow font-semibold uppercase tracking-widest text-fg-3">${escapeHtml(section.title)}</h3>` +
      `<ul class="flex flex-col divide-y divide-line/60 rounded-xl border border-line/60 bg-bg/50 px-3 py-1">${section.items.map(renderItem).join("")}</ul>` +
      "</section>"
  ).join("")

  dialog.innerHTML =
    '<div class="flex flex-col gap-4 p-5 overflow-y-auto custom-scroll">' +
    '<div class="flex items-start justify-between gap-3 shrink-0">' +
    `<h2 id="${DIALOG_ID}-title" class="text-base font-semibold">${escapeHtml(t("keyboardHelp.title"))}</h2>` +
    '<button type="button" data-close ' +
    `class="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-2 hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent">${escapeHtml(t("common.close"))}</button>` +
    "</div>" +
    `<div class="flex flex-col gap-4">${sectionsHtml}</div>` +
    "</div>"

  document.body.appendChild(dialog)

  dialog.addEventListener("click", (event) => {
    const target = /** @type {HTMLElement} */ (event.target)
    if (target === dialog) {
      dialog.close()
      return
    }
    if (target.closest("[data-close]")) dialog.close()
  })
  dialog.addEventListener("close", () => {
    if (lastTrigger && document.body.contains(lastTrigger)) {
      try { lastTrigger.focus({ preventScroll: true }) } catch {}
    }
    lastTrigger = null
  })

  return dialog
}

let lastTrigger = null

function open() {
  const dlg = buildDialog()
  lastTrigger = /** @type {HTMLElement|null} */ (document.activeElement)
  if (typeof dlg.showModal === "function") dlg.showModal()
  else dlg.setAttribute("open", "")
  // Defer focus to next frame so spatial-nav re-registers the dialog content.
  requestAnimationFrame(() => {
    window.SpatialNavigation?.makeFocusable?.()
    /** @type {HTMLElement|null} */
    const closeBtn = dlg.querySelector("[data-close]")
    closeBtn?.focus?.({ preventScroll: true })
  })
}

let initialised = false
export function initKeyboardHelp() {
  if (initialised) return
  initialised = true
  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return
    if (event.key !== "?") return
    if (isTypingTarget(event.target)) return
    if (dialog?.open) return
    event.preventDefault()
    open()
  })
}
