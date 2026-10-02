// Native-video hole contract: mpv-embedded.ts requires Tauri's invoke() bridge, so this drives
// the published attribute/vars directly and proves the CSS hole-punch, not the JS bounds-push loop.
import { test, expect, type Page } from "@playwright/test"

type VideoRect = { x: number; y: number; width: number; height: number; radius: number }

async function seedAppState(page: Page) {
  await page.context().addInitScript(() => {
    try {
      localStorage.setItem("xt_locale", "en")
      localStorage.setItem("xt_theme", "dark")
      localStorage.setItem("xt_perf_mode", "1")
    } catch {}
  })
}

async function setVideoRect(page: Page, rect: VideoRect): Promise<void> {
  await page.evaluate((r) => {
    const root = document.documentElement
    root.setAttribute("data-native-video", "on")
    root.style.setProperty("--xt-video-x", `${r.x}px`)
    root.style.setProperty("--xt-video-y", `${r.y}px`)
    root.style.setProperty("--xt-video-w", `${r.width}px`)
    root.style.setProperty("--xt-video-h", `${r.height}px`)
    root.style.setProperty("--xt-video-r", `${r.radius}px`)
  }, rect)
  await settleFrame(page)
}

async function clearVideoRect(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.documentElement
    root.removeAttribute("data-native-video")
    for (const prop of ["--xt-video-x", "--xt-video-y", "--xt-video-w", "--xt-video-h", "--xt-video-r"]) {
      root.style.removeProperty(prop)
    }
  })
  await settleFrame(page)
}

/** Reads the ::before hole layer plus the host element's own background, for a given selector. */
function holeLayer(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = sel === "body" ? document.body : document.querySelector(sel)!
    const pseudo = getComputedStyle(el, "::before")
    return {
      content: pseudo.content,
      position: pseudo.position,
      left: pseudo.left,
      top: pseudo.top,
      width: pseudo.width,
      height: pseudo.height,
      borderRadius: pseudo.borderTopLeftRadius,
      boxShadow: pseudo.boxShadow,
      elementBackground: getComputedStyle(el).backgroundColor,
    }
  }, selector)
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
    await seedAppState(page)
    await page.goto("/")
    await page.waitForSelector("body")
    await settleFrame(page)

    const before = await holeLayer(page, "body")
    expect(before.content).toBe("none")
    expect(before.elementBackground).not.toBe("rgba(0, 0, 0, 0)")

    await setVideoRect(page, { x: 10, y: 10, width: 200, height: 120, radius: 8 })
    expect((await holeLayer(page, "body")).content).not.toBe("none")

    await clearVideoRect(page)
    const after = await holeLayer(page, "body")
    expect(after.content).toBe("none")
    expect(after.elementBackground).not.toBe("rgba(0, 0, 0, 0)")
  })

  test("cuts a hole matching the published rect and radius exactly", async ({ page }) => {
    await seedAppState(page)
    await page.goto("/")
    await page.waitForSelector("body")
    await settleFrame(page)

    const rect: VideoRect = { x: 120, y: 64, width: 800, height: 450, radius: 18 }
    await setVideoRect(page, rect)

    const hole = await holeLayer(page, "body")
    expect(hole.position).toBe("fixed")
    expect(hole.left).toBe(`${rect.x}px`)
    expect(hole.top).toBe(`${rect.y}px`)
    expect(hole.width).toBe(`${rect.width}px`)
    expect(hole.height).toBe(`${rect.height}px`)
    expect(hole.borderRadius).toBe(`${rect.radius}px`)
    expect(hole.elementBackground).toBe("rgba(0, 0, 0, 0)")

    const backgroundRgb = await resolvedColor(page, "var(--color-bg)")
    expect(hole.boxShadow).toContain(backgroundRgb)
  })

  test("the Live TV player card's hole layer paints in the surface color, not the page background", async ({
    page,
  }) => {
    await seedAppState(page)
    await page.goto("/")
    await page.waitForSelector("body")
    await settleFrame(page)

    await page.evaluate(() => {
      const card = document.createElement("div")
      card.id = "hole-probe-card"
      card.className = "xt-video-hole"
      document.body.appendChild(card)
    })

    await setVideoRect(page, { x: 30, y: 40, width: 300, height: 200, radius: 12 })

    const hole = await holeLayer(page, "#hole-probe-card")
    expect(hole.elementBackground).toBe("rgba(0, 0, 0, 0)")
    const surfaceRgb = await resolvedColor(page, "var(--color-surface)")
    expect(hole.boxShadow).toContain(surfaceRgb)
  })

  // Simulates the mpv-embedded.ts bounds-push loop (getBoundingClientRect of the player container
  // on resize/scroll) since its actual rAF loop needs Tauri's invoke() bridge to run.
  test("the hole tracks the player container through a resize and a scroll", async ({ page }) => {
    await seedAppState(page)
    await page.goto("/")
    await page.waitForSelector("body")
    await settleFrame(page)

    await page.evaluate(() => {
      document.body.style.minHeight = "3000px"
      const container = document.createElement("div")
      container.id = "hole-probe-container"
      container.style.cssText = "position:relative;margin-top:900px;width:60vw;height:400px"
      const controls = document.createElement("div")
      controls.id = "hole-probe-controls"
      controls.textContent = "controls"
      container.appendChild(controls)
      document.body.appendChild(container)
    })

    async function pushRectFromContainer(): Promise<VideoRect> {
      const rect = await page.evaluate(() => {
        const box = document.getElementById("hole-probe-container")!.getBoundingClientRect()
        return { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) }
      })
      const withRadius: VideoRect = { ...rect, radius: 12 }
      await setVideoRect(page, withRadius)
      return withRadius
    }

    async function assertControlsVisible(): Promise<void> {
      const controls = await page.evaluate(() => {
        const el = document.getElementById("hole-probe-controls")!
        const rect = el.getBoundingClientRect()
        return { hidden: getComputedStyle(el).visibility === "hidden" || getComputedStyle(el).display === "none", width: rect.width, height: rect.height }
      })
      expect(controls.hidden).toBe(false)
      expect(controls.width).toBeGreaterThan(0)
      expect(controls.height).toBeGreaterThan(0)
    }

    const initialRect = await pushRectFromContainer()
    let hole = await holeLayer(page, "body")
    expect(hole.left).toBe(`${initialRect.x}px`)
    expect(hole.top).toBe(`${initialRect.y}px`)
    expect(hole.width).toBe(`${initialRect.width}px`)
    await assertControlsVisible()

    await page.setViewportSize({ width: 1000, height: 850 })
    // setViewportSize resolves before Chromium's own resize event finishes propagating.
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1000)
    const resizedRect = await pushRectFromContainer()
    expect(resizedRect.width).not.toBe(initialRect.width)
    hole = await holeLayer(page, "body")
    expect(hole.left).toBe(`${resizedRect.x}px`)
    expect(hole.width).toBe(`${resizedRect.width}px`)
    await assertControlsVisible()

    await page.evaluate(() => window.scrollTo(0, 500))
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
    const scrolledRect = await pushRectFromContainer()
    expect(scrolledRect.y).toBeLessThan(resizedRect.y)
    hole = await holeLayer(page, "body")
    expect(hole.top).toBe(`${scrolledRect.y}px`)
    await assertControlsVisible()
  })

  // Regression guard: the box-shadow hole must live on a childless ::before, never on an
  // element that itself has children, or a future clip-path there would hide the controls.
  test("only the childless ::before paints the hole, never the container that hosts controls", async ({ page }) => {
    await seedAppState(page)
    await page.goto("/")
    await page.waitForSelector("body")
    await settleFrame(page)
    await setVideoRect(page, { x: 0, y: 0, width: 100, height: 100, radius: 0 })

    const result = await page.evaluate(() => {
      const container = document.body
      const containerStyle = getComputedStyle(container)
      const pseudoStyle = getComputedStyle(container, "::before")
      return {
        hasChildren: container.children.length > 0,
        containerClipPath: containerStyle.clipPath,
        containerMaskImage: containerStyle.maskImage,
        pseudoContent: pseudoStyle.content,
        pseudoBoxShadow: pseudoStyle.boxShadow,
      }
    })

    expect(result.hasChildren, "sanity: body must have children for this guard to mean anything").toBe(true)
    expect(result.containerClipPath, "the childful container must never be clipped directly").toBe("none")
    expect(result.containerMaskImage, "the childful container must never be masked directly").toBe("none")
    expect(result.pseudoContent).not.toBe("none")
    expect(result.pseudoBoxShadow, "the hole must come from the childless ::before, not the container").not.toBe(
      "none"
    )
  })
})
