import { describe, expect, it } from "vitest"
import { isSafeObjectKey } from "../src/scripts/lib/safe-object-key"
import { isSafeImageUrl } from "../src/scripts/lib/img-scale"

describe("isSafeObjectKey", () => {
  it("rejects prototype-polluting and empty keys", () => {
    for (const key of ["__proto__", "constructor", "prototype", ""]) expect(isSafeObjectKey(key)).toBe(false)
    expect(isSafeObjectKey(undefined)).toBe(false)
    expect(isSafeObjectKey(12)).toBe(false)
  })
  it("accepts ordinary ids", () => {
    expect(isSafeObjectKey("abc-123")).toBe(true)
    expect(isSafeObjectKey("__proto")).toBe(true)
  })
})

describe("isSafeImageUrl", () => {
  it("allows web, blob, image data and relative urls", () => {
    for (const url of ["http://a/b.png", "https://a/b.png", "blob:x", "data:image/png;base64,AA", "/img/a.png", "a/b.png", "asset://localhost/x"])
      expect(isSafeImageUrl(url)).toBe(true)
  })
  it("rejects script-capable schemes", () => {
    for (const url of ["javascript:alert(1)", " JavaScript:alert(1)", "vbscript:x", "data:text/html,<script>", "file:///etc/passwd"])
      expect(isSafeImageUrl(url)).toBe(false)
  })
})
