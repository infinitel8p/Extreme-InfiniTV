// Native-video hole contract: mpv-embedded.ts requires Tauri's invoke() bridge, so this drives
// the published attributes/vars directly and proves the CSS hole-punch, not the JS bounds-push loop.
import { test, expect, type Page } from "@playwright/test"

type VideoRect = { x: number; y: number; width: number; height: number; radius: number }

const OWNER_ID = "hole-probe-owner"
const SESSION_ID = "hole-probe-session"
const OWNER_BACKGROUND = "rgb(10, 20, 30)"

async function seedAppState(page: Page) {
  await page.context().addInitScript(() => {
    try {
      localStorage.setItem("xt_locale", "en")
      localStorage.setItem("xt_theme", "dark")
      localStorage.setItem("xt_perf_mode", "1")
    } catch {}
  })
}

async function openPage(page: Page): Promise<void> {
  await seedAppState(page)
  await page.goto("/")
  await page.waitForSelector("body")
  await settleFrame(page)
}

/** A positioned owner holding the player container, as applySurface() expects. */
async function mountHoleOwner(page: Page, ownerClass = ""): Promise<void> {
  await page.evaluate(
    ({ ownerId, className, background }) => {
      // Class, not inline, so the background competes like a real utility class would.
      const sheet = document.createElement("style")
      sheet.textContent = `.hole-probe-bg { background: ${background} }`
      document.head.appendChild(sheet)
      const owner = document.createElement("div")
      owner.id = ownerId
      owner.className = `hole-probe-bg ${className}`
      owner.style.cssText = "position:relative;margin:40px;padding:24px"
      const container = document.createElement("div")
      container.id = "hole-probe-container"
      container.style.cssText = "width:60%;height:300px"
      const controls = document.createElement("div")
      controls.id = "hole-probe-controls"
      controls.textContent = "controls"
      container.appendChild(controls)
      owner.appendChild(container)
      document.body.appendChild(owner)
    },
    { ownerId: OWNER_ID, className: ownerClass, background: OWNER_BACKGROUND }
  )
}

async function setVideoRect(page: Page, rect: VideoRect, openHole = true): Promise<void> {
  await page.evaluate(
    ({ ownerId, sessionId, holeRect, open }) => {
      const owner = document.getElementById(ownerId)!
      owner.setAttribute("data-native-video-hole-owner", "")
      owner.style.setProperty("--xt-video-x", `${holeRect.x}px`)
      owner.style.setProperty("--xt-video-y", `${holeRect.y}px`)
      owner.style.setProperty("--xt-video-w", `${holeRect.width}px`)
      owner.style.setProperty("--xt-video-h", `${holeRect.height}px`)
      owner.style.setProperty("--xt-video-r", `${holeRect.radius}px`)
      if (open) {
        document.documentElement.setAttribute("data-native-video", "on")
        document.documentElement.setAttribute("data-native-video-owner", sessionId)
      }
    },
    { ownerId: OWNER_ID, sessionId: SESSION_ID, holeRect: rect, open: openHole }
  )
  await settleTransitions(page)
}

// Perf mode shortens every transition to 0.01ms rather than removing it, so a toggled
// background is still mid-transition when read; wait for those to land.
async function settleTransitions(page: Page): Promise<void> {
  await settleFrame(page)
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)))
}

async function clearVideoRect(page: Page): Promise<void> {
  await page.evaluate((ownerId) => {
    const root = document.documentElement
    root.removeAttribute("data-native-video")
    root.removeAttribute("data-native-video-owner")
    const owner = document.getElementById(ownerId)!
    owner.removeAttribute("data-native-video-hole-owner")
    for (const prop of ["--xt-video-x", "--xt-video-y", "--xt-video-w", "--xt-video-h", "--xt-video-r"]) {
      owner.style.removeProperty(prop)
    }
  }, OWNER_ID)
  await settleTransitions(page)
}

/** Reads the owner's ::before hole layer plus the owner's and body's own backgrounds. */
function holeLayer(page: Page) {
  return page.evaluate((ownerId) => {
    const owner = document.getElementById(ownerId)!
    const pseudo = getComputedStyle(owner, "::before")
    return {
      content: pseudo.content,
      position: pseudo.position,
      left: pseudo.left,
      top: pseudo.top,
      width: pseudo.width,
      height: pseudo.height,
      borderRadius: pseudo.borderTopLeftRadius,
      boxShadow: pseudo.boxShadow,
      pointerEvents: pseudo.pointerEvents,
      ownerBackground: getComputedStyle(owner).backgroundColor,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
    }
  }, OWNER_ID)
}

// The Astro `@view-transition { navigation: auto }` opt-in freezes style application for one
// frame after a navigation; wait it out once instead of racing it on every assertion below.
function settleFrame(page: Page): Promise<void> {
  return page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  )
}

/** Resolves a CSS color/var to its computed rgb() form via a throwaway probe element. */
async function resolvedColor(page: Page, cssValue: string): Promise<string> {
  return page.evaluate((value) => {
    const probe = document.createElement("div")
    probe.style.cssText = `position:fixed;inset:0;z-index:-1;background:${value}`
    document.body.appendChild(probe)
    const resolved = getComputedStyle(probe).backgroundColor
    probe.remove()
    return resolved
  }, cssValue)
}

test.describe("native-video hole contract (CSS layer)", () => {
  test("is inert until data-native-video is set, and reverts once it is removed", async ({ page }) => {
    await openPage(page)
    await mountHoleOwner(page)

    await setVideoRect(page, { x: 10, y: 10, width: 200, height: 120, radius: 8 }, false)
    const before = await holeLayer(page)
    expect(before.content).toBe("none")
    expect(before.ownerBackground).toBe(OWNER_BACKGROUND)
    expect(before.bodyBackground).not.toBe("rgba(0, 0, 0, 0)")

    await setVideoRect(page, { x: 10, y: 10, width: 200, height: 120, radius: 8 })
    const open = await holeLayer(page)
    expect(open.content).not.toBe("none")
    expect(open.ownerBackground).toBe("rgba(0, 0, 0, 0)")
    expect(open.bodyBackground).toBe("rgba(0, 0, 0, 0)")

    await clearVideoRect(page)
    const after = await holeLayer(page)
    expect(after.content).toBe("none")
    expect(after.ownerBackground).toBe(OWNER_BACKGROUND)
    expect(after.bodyBackground).not.toBe("rgba(0, 0, 0, 0)")
  })

  test("cuts a hole matching the published owner-relative rect and radius exactly", async ({ page }) => {
    await openPage(page)
    await mountHoleOwner(page)

    const rect: VideoRect = { x: 24, y: 24, width: 800, height: 450, radius: 18 }
    await setVideoRect(page, rect)

    const hole = await holeLayer(page)
    expect(hole.position).toBe("absolute")
    expect(hole.left).toBe(`${rect.x}px`)
    expect(hole.top).toBe(`${rect.y}px`)
    expect(hole.width).toBe(`${rect.width}px`)
    expect(hole.height).toBe(`${rect.height}px`)
    expect(hole.borderRadius).toBe(`${rect.radius}px`)
    expect(hole.pointerEvents).toBe("none")

    const backgroundRgb = await resolvedColor(page, "var(--color-bg)")
    expect(hole.boxShadow).toContain(backgroundRgb)
  })

  test("the Live TV player card's hole layer paints in the surface color, not the page background", async ({
    page,
  }) => {
    await openPage(page)
    await mountHoleOwner(page, "xt-video-hole")

    await setVideoRect(page, { x: 30, y: 40, width: 300, height: 200, radius: 12 })

    const hole = await holeLayer(page)
    expect(hole.ownerBackground).toBe("rgba(0, 0, 0, 0)")
    const surfaceRgb = await resolvedColor(page, "var(--color-surface)")
    const backgroundRgb = await resolvedColor(page, "var(--color-bg)")
    expect(surfaceRgb).not.toBe(backgroundRgb)
    expect(hole.boxShadow).toContain(surfaceRgb)
  })

  // Simulates the mpv-embedded.ts bounds-push loop (container rect relative to the owner rect)
  // since its actual rAF loop needs Tauri's invoke() bridge to run.
  test("the hole tracks the player container through a resize and a scroll", async ({ page }) => {
    await openPage(page)
    await page.evaluate(() => {
      document.body.style.minHeight = "3000px"
    })
    await mountHoleOwner(page)
    await page.evaluate((ownerId) => {
      document.getElementById(ownerId)!.style.marginTop = "900px"
    }, OWNER_ID)

    async function pushRectFromContainer(): Promise<VideoRect> {
      const rect = await page.evaluate((ownerId) => {
        const box = document.getElementById("hole-probe-container")!.getBoundingClientRect()
        const ownerBox = document.getElementById(ownerId)!.getBoundingClientRect()
        return {
          x: Math.round(box.left - ownerBox.left),
          y: Math.round(box.top - ownerBox.top),
          width: Math.round(box.width),
          height: Math.round(box.height),
        }
      }, OWNER_ID)
      const withRadius: VideoRect = { ...rect, radius: 12 }
      await setVideoRect(page, withRadius)
      return withRadius
    }

    async function assertHoleMatches(rect: VideoRect): Promise<void> {
      const hole = await holeLayer(page)
      expect(hole.left).toBe(`${rect.x}px`)
      expect(hole.top).toBe(`${rect.y}px`)
      expect(hole.width).toBe(`${rect.width}px`)
      expect(hole.height).toBe(`${rect.height}px`)
    }

    async function assertControlsVisible(): Promise<void> {
      const controls = await page.evaluate(() => {
        const element = document.getElementById("hole-probe-controls")!
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return { hidden: style.visibility === "hidden" || style.display === "none", width: rect.width, height: rect.height }
      })
      expect(controls.hidden).toBe(false)
      expect(controls.width).toBeGreaterThan(0)
      expect(controls.height).toBeGreaterThan(0)
    }

    const initialRect = await pushRectFromContainer()
    await assertHoleMatches(initialRect)
    await assertControlsVisible()

    await page.setViewportSize({ width: 1000, height: 850 })
    // setViewportSize resolves before Chromium's own resize event finishes propagating.
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1000)
    const resizedRect = await pushRectFromContainer()
    expect(resizedRect.width).not.toBe(initialRect.width)
    await assertHoleMatches(resizedRect)
    await assertControlsVisible()

    // Page-space hole: scrolling moves the owner and its ::before together, so the vars hold.
    await page.evaluate(() => window.scrollTo(0, 500))
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
    const scrolledRect = await pushRectFromContainer()
    expect(scrolledRect).toEqual(resizedRect)
    await assertHoleMatches(scrolledRect)
    await assertControlsVisible()
  })

  // Regression guard: the box-shadow hole must live on a childless ::before, never on an
  // element that itself has children, or a future clip-path there would hide the controls.
  test("only the childless ::before paints the hole, never the container that hosts controls", async ({ page }) => {
    await openPage(page)
    await mountHoleOwner(page)
    await setVideoRect(page, { x: 0, y: 0, width: 100, height: 100, radius: 0 })

    const result = await page.evaluate((ownerId) => {
      const owner = document.getElementById(ownerId)!
      const ownerStyle = getComputedStyle(owner)
      const pseudoStyle = getComputedStyle(owner, "::before")
      return {
        hasChildren: owner.children.length > 0,
        ownerClipPath: ownerStyle.clipPath,
        ownerMaskImage: ownerStyle.maskImage,
        ownerBoxShadow: ownerStyle.boxShadow,
        ownerBackground: ownerStyle.backgroundColor,
        pseudoContent: pseudoStyle.content,
        pseudoBoxShadow: pseudoStyle.boxShadow,
      }
    }, OWNER_ID)

    expect(result.hasChildren, "sanity: the owner must have children for this guard to mean anything").toBe(true)
    expect(result.ownerClipPath, "the childful owner must never be clipped directly").toBe("none")
    expect(result.ownerMaskImage, "the childful owner must never be masked directly").toBe("none")
    expect(result.ownerBoxShadow, "the childful owner must not paint the hole itself").toBe("none")
    expect(result.ownerBackground, "the childful owner must paint nothing over the hole").toBe("rgba(0, 0, 0, 0)")
    expect(result.pseudoContent).not.toBe("none")
    expect(result.pseudoBoxShadow, "the hole must come from the childless ::before, not the owner").not.toBe("none")
  })
})
