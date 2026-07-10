import { describe, it, expect } from "vitest"
import { splitUrlAuth } from "../src/scripts/lib/url-auth"

function basicCredentials(authorization: string | null): string | null {
  if (!authorization) return null
  const base64Part = authorization.replace(/^Basic /, "")
  return new TextDecoder().decode(
    Uint8Array.from(atob(base64Part), (character) => character.charCodeAt(0)),
  )
}

describe("splitUrlAuth", () => {
  it("passes through URLs without credentials untouched", () => {
    const plain = "https://provider.tld:8080/live/stream.m3u8?token=abc"
    expect(splitUrlAuth(plain)).toEqual({ url: plain, authorization: null })
  })

  it("splits http user:pass into a Basic header", () => {
    const out = splitUrlAuth("http://alice:secret@host.example/path")
    expect(out.url).toBe("http://host.example/path")
    expect(out.authorization).toBe("Basic YWxpY2U6c2VjcmV0")
  })

  it("splits https user:pass into a Basic header", () => {
    const out = splitUrlAuth("https://alice:secret@host.example/path")
    expect(out.url).toBe("https://host.example/path")
    expect(out.authorization).toBe("Basic YWxpY2U6c2VjcmV0")
  })

  it("handles a username with an empty password", () => {
    const out = splitUrlAuth("https://user@host.example/")
    expect(out.url).toBe("https://host.example/")
    expect(out.authorization).toBe("Basic dXNlcjo=")
  })

  it("percent-decodes credentials before encoding", () => {
    const out = splitUrlAuth("https://user:p%40ss@host.example/")
    expect(out.url).toBe("https://host.example/")
    // base64("user:p@ss")
    expect(out.authorization).toBe("Basic dXNlcjpwQHNz")
  })

  it("encodes non-ASCII credentials as UTF-8", () => {
    const out = splitUrlAuth("https://m%C3%BCller:p%C3%A4ss@host.example/")
    expect(out.url).toBe("https://host.example/")
    // base64 of UTF-8 "müller:päss"
    expect(out.authorization).toBe("Basic bcO8bGxlcjpww6Rzcw==")
  })

  it("leaves non-http schemes alone", () => {
    const blob = "blob:https://host.example/1234-5678"
    expect(splitUrlAuth(blob)).toEqual({ url: blob, authorization: null })
    const ftp = "ftp://user:pass@host.example/file"
    expect(splitUrlAuth(ftp)).toEqual({ url: ftp, authorization: null })
  })

  it("leaves unparseable strings alone", () => {
    expect(splitUrlAuth("not a url at all")).toEqual({
      url: "not a url at all",
      authorization: null,
    })
    expect(splitUrlAuth("/relative/path.m3u8")).toEqual({
      url: "/relative/path.m3u8",
      authorization: null,
    })
    expect(splitUrlAuth("")).toEqual({ url: "", authorization: null })
  })

  it("preserves port, query, and fragment after stripping userinfo", () => {
    const out = splitUrlAuth(
      "https://user:pass@host.example:8443/path/file.m3u8?a=1#frag",
    )
    expect(out.url).toBe("https://host.example:8443/path/file.m3u8?a=1#frag")
    expect(out.authorization).toBe("Basic dXNlcjpwYXNz")
  })

  it("handles a raw @ in the password", () => {
    const out = splitUrlAuth("https://user:p@ss@host.com/x.m3u")
    expect(out.url).toBe("https://host.com/x.m3u")
    expect(basicCredentials(out.authorization)).toBe("user:p@ss")
  })

  it("handles a raw : in the password", () => {
    const out = splitUrlAuth("https://user:pa:ss@host.com/x.m3u")
    expect(out.url).toBe("https://host.com/x.m3u")
    expect(basicCredentials(out.authorization)).toBe("user:pa:ss")
  })

  it("handles raw @ and : together in the password", () => {
    const out = splitUrlAuth("https://user:p@ss:w@rd@host.com/x.m3u")
    expect(out.url).toBe("https://host.com/x.m3u")
    expect(basicCredentials(out.authorization)).toBe("user:p@ss:w@rd")
  })

  it("handles a raw space in the username", () => {
    const out = splitUrlAuth("https://my user:pass@host.com/x.m3u")
    expect(out.url).toBe("https://host.com/x.m3u")
    expect(basicCredentials(out.authorization)).toBe("my user:pass")
  })

  it("handles a raw space in the password", () => {
    const out = splitUrlAuth("https://user:pa ss@host.com/x.m3u")
    expect(out.url).toBe("https://host.com/x.m3u")
    expect(basicCredentials(out.authorization)).toBe("user:pa ss")
  })

  it("preserves a literal % that is not a valid escape", () => {
    const out = splitUrlAuth("https://user:pa%ss@host.com/x.m3u")
    expect(out.url).toBe("https://host.com/x.m3u")
    expect(basicCredentials(out.authorization)).toBe("user:pa%ss")
  })

  it("rescues a password containing /", () => {
    const out = splitUrlAuth("https://user:pa/ss@host.com/x.m3u")
    expect(out.url).toBe("https://host.com/x.m3u")
    expect(basicCredentials(out.authorization)).toBe("user:pa/ss")
  })

  it("rescues a password containing ?", () => {
    const out = splitUrlAuth("https://user:pa?ss@host.com/x.m3u")
    expect(out.url).toBe("https://host.com/x.m3u")
    expect(basicCredentials(out.authorization)).toBe("user:pa?ss")
  })

  it("rescues a password containing #", () => {
    const out = splitUrlAuth("https://user:pa#ss@host.com/x.m3u")
    expect(out.url).toBe("https://host.com/x.m3u")
    expect(basicCredentials(out.authorization)).toBe("user:pa#ss")
  })

  it("rescues a password containing /, ?, and # together", () => {
    const out = splitUrlAuth("https://user:pa/ss?#@host.com/x.m3u")
    expect(out.url).toBe("https://host.com/x.m3u")
    expect(basicCredentials(out.authorization)).toBe("user:pa/ss?#")
  })

  it("leaves an invalid URL without an @ unchanged", () => {
    const invalid = "https://host.com:notaport/x.m3u"
    expect(splitUrlAuth(invalid)).toEqual({ url: invalid, authorization: null })
  })

  it("does not misroute an invalid port URL with an @ in an unrelated query value", () => {
    const invalid =
      "https://host.com:notaport/x.m3u?email=test@example.com"
    expect(splitUrlAuth(invalid)).toEqual({ url: invalid, authorization: null })
  })

  it("does not misroute an out-of-range port URL with an @ in an unrelated query value", () => {
    const invalid = "https://host.com:99999/x.m3u?cb=a@b.com"
    expect(splitUrlAuth(invalid)).toEqual({ url: invalid, authorization: null })
  })

  it("leaves a valid URL with @ only in the query untouched", () => {
    const plain =
      "https://provider.tld:8080/live/stream.m3u8?token=abc@def.com"
    expect(splitUrlAuth(plain)).toEqual({ url: plain, authorization: null })
  })
})
