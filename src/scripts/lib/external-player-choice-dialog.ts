// "Ask each time" chooser for the desktop escape-hatch button: one button per
// configured external player, mirroring confirm-dialog.ts's styled <dialog>.

import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { t } from "@/scripts/lib/i18n.js"
import { ICON_EXTERNAL_LINK } from "@/scripts/lib/icons.js"

export type ExternalPlayerChoice = "mpv" | "vlc"

const DIALOG_ID = "xt-external-player-choice-dialog"

let dlg: HTMLDialogElement | null = null
let resolveFn: ((value: ExternalPlayerChoice | null) => void) | null = null

export interface ExternalPlayerChoiceOptions {
  title?: string
  subtitle?: string
}

// Substantial rows carry the decision: a monogram accent tile + bold name + an "opens externally" glyph.
const CHOICE_BUTTON_CLASS =
  "flex w-full items-center gap-3 min-h-14 rounded-xl border border-line bg-surface-2 px-3 " +
  "text-left transition duration-150 active:scale-[0.97] " +
  "hover:border-accent hover:bg-surface-3 " +
  "focus-visible:outline-none focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent"

// Ghost, so the player rows stay the focal point.
const CANCEL_BUTTON_CLASS =
  "inline-flex items-center justify-center min-h-11 rounded-xl px-4 text-sm text-fg-2 " +
  "transition duration-150 active:scale-[0.97] hover:bg-surface-2 hover:text-fg " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"

function labelForChoice(choice: ExternalPlayerChoice): string {
  return choice === "vlc" ? "VLC" : "MPV"
}

// Official upstream marks, bundled in public/ (mpv-player/mpv, videolan/vlc).
const ICON_SRC: Record<ExternalPlayerChoice, string> = {
  mpv: "/players/mpv.png",
  vlc: "/players/vlc.png",
}

function ensureDialog(): HTMLDialogElement {
  if (dlg) return dlg
  const node = document.createElement("dialog")
  node.id = DIALOG_ID
  node.setAttribute("aria-labelledby", `${DIALOG_ID}-title`)
  node.className = [
    "fixed inset-0 m-auto rounded-2xl border border-line bg-surface text-fg p-0",
    "w-[min(24rem,calc(100vw-2rem))]",
    "backdrop:bg-black/70",
  ].join(" ")
  node.innerHTML = `
    <div class="flex flex-col gap-4 p-5">
      <div class="flex flex-col gap-0.5">
        <h2 id="${DIALOG_ID}-title" data-role="title" class="m-0 text-lg font-semibold tracking-tight"></h2>
        <p data-role="subtitle" class="m-0 text-sm text-fg-3 empty:hidden"></p>
      </div>
      <div data-role="choices" class="flex flex-col gap-2"></div>
      <div class="flex justify-end">
        <button
          data-role="cancel"
          type="button"
          class="${CANCEL_BUTTON_CLASS}"></button>
      </div>
    </div>
  `
  document.body.appendChild(node)
  attachDialogSpatialNav(node, {
    defaultElement: `#${DIALOG_ID} [data-role="choices"] button`,
  })

  const cancelBtn = node.querySelector('[data-role="cancel"]') as HTMLButtonElement
  cancelBtn.addEventListener("click", () => node.close())
  // Backdrop click closes (= cancel).
  node.addEventListener("click", (event) => {
    if (event.target === node) node.close()
  })
  // Esc or any non-choice close resolves null.
  node.addEventListener("close", () => settle(null))

  dlg = node
  return dlg
}

function settle(value: ExternalPlayerChoice | null) {
  if (!resolveFn) return
  const fn = resolveFn
  resolveFn = null
  fn(value)
}

export function pickExternalPlayer(
  choices: ExternalPlayerChoice[],
  opts?: ExternalPlayerChoiceOptions,
): Promise<ExternalPlayerChoice | null> {
  return new Promise<ExternalPlayerChoice | null>((resolve) => {
    const node = ensureDialog()
    // A prior dialog left open would otherwise never resolve once we
    // reattach the resolver below.
    settle(null)
    resolveFn = resolve

    const titleEl = node.querySelector('[data-role="title"]') as HTMLElement
    const subtitleEl = node.querySelector('[data-role="subtitle"]') as HTMLElement
    const choicesEl = node.querySelector('[data-role="choices"]') as HTMLElement
    const cancelBtn = node.querySelector('[data-role="cancel"]') as HTMLButtonElement

    const defaultTitle = t("settings.playback.choosePlayerTitle")
    titleEl.textContent =
      opts?.title ||
      (defaultTitle && defaultTitle !== "settings.playback.choosePlayerTitle"
        ? defaultTitle
        : "Choose a player")
    subtitleEl.textContent = opts?.subtitle || ""
    cancelBtn.textContent = t("common.cancel")

    choicesEl.innerHTML = ""
    for (const choice of choices) {
      const button = document.createElement("button")
      button.type = "button"
      button.className = CHOICE_BUTTON_CLASS
      button.dataset.choice = choice
      const label = labelForChoice(choice)

      const iconWrap = document.createElement("span")
      iconWrap.className = "grid h-10 w-10 shrink-0 place-items-center"
      const iconImg = document.createElement("img")
      iconImg.src = ICON_SRC[choice]
      iconImg.alt = ""
      iconImg.width = 28
      iconImg.height = 28
      iconImg.decoding = "async"
      iconImg.className = "h-7 w-7 object-contain"
      iconWrap.appendChild(iconImg)

      const name = document.createElement("span")
      name.className = "flex-1 text-base font-semibold text-fg"
      name.textContent = label

      const openHint = document.createElement("span")
      openHint.className = "shrink-0 inline-flex text-lg leading-none text-fg-3"
      openHint.setAttribute("aria-hidden", "true")
      openHint.innerHTML = ICON_EXTERNAL_LINK

      button.append(iconWrap, name, openHint)
      button.addEventListener("click", () => {
        settle(choice)
        node.close()
      })
      choicesEl.appendChild(button)
    }

    if (typeof node.showModal === "function") node.showModal()
    else node.setAttribute("open", "")
  })
}
