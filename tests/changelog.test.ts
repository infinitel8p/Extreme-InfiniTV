import { describe, it, expect } from "vitest"
import { Marked } from "marked"
import { createAlertExtension, matchAlertMarker } from "../src/scripts/lib/changelog"

function render(markdown: string): string {
  return new Marked({ gfm: true, breaks: false })
    .use({ extensions: [createAlertExtension()] })
    .parse(markdown, { async: false }) as string
}

describe("matchAlertMarker", () => {
  it("recognizes each of the five alert types", () => {
    expect(matchAlertMarker("[!NOTE]")).toBe("note")
    expect(matchAlertMarker("[!TIP]")).toBe("tip")
    expect(matchAlertMarker("[!IMPORTANT]")).toBe("important")
    expect(matchAlertMarker("[!WARNING]")).toBe("warning")
    expect(matchAlertMarker("[!CAUTION]")).toBe("caution")
  })

  it("is case-insensitive per GitHub's own parser", () => {
    expect(matchAlertMarker("[!note]")).toBe("note")
    expect(matchAlertMarker("[!Tip]")).toBe("tip")
  })

  it("rejects anything that isn't an exact marker line", () => {
    expect(matchAlertMarker("hello")).toBeNull()
    expect(matchAlertMarker("[!NOTE] extra text")).toBeNull()
    expect(matchAlertMarker("[!UNKNOWN]")).toBeNull()
  })
})

describe("alert callout rendering", () => {
  it.each(["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"] as const)(
    "renders a %s callout with a localized title and inner markdown",
    (marker) => {
      const html = render(`> [!${marker}]\n> some **bold** text`)
      expect(html).toContain(`xt-alert--${marker.toLowerCase()}`)
      expect(html).toContain("xt-alert__title")
      expect(html).toContain("<strong>bold</strong>")
    }
  )

  it("accepts a lowercase marker", () => {
    const html = render("> [!note]\n> lowercase still counts")
    expect(html).toContain("xt-alert--note")
    expect(html).toContain("lowercase still counts")
  })

  it("leaves a plain blockquote without a marker unchanged", () => {
    const html = render("> just a quote\n> second line")
    expect(html).not.toContain("xt-alert")
    expect(html).toContain("<blockquote>")
    expect(html).toContain("just a quote")
  })

  it("renders lists and links inside the callout body", () => {
    const html = render(
      "> [!TIP]\n> - first item\n> - second item\n>\n> See [docs](https://example.com)."
    )
    expect(html).toContain("<ul>")
    expect(html).toContain("<li>first item</li>")
    expect(html).toContain('<a href="https://example.com">docs</a>')
  })
})
