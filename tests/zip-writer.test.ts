import { describe, it, expect } from "vitest"
import { crc32, createZip, type ZipEntry } from "../src/scripts/lib/zip-writer"

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  )
}

function findLast(bytes: Uint8Array, signature: number): number {
  for (let offset = bytes.length - 4; offset >= 0; offset--) {
    if (readUint32(bytes, offset) === signature) return offset
  }
  return -1
}

describe("crc32", () => {
  it("returns 0 for empty input", () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it("matches the known vector for '123456789'", () => {
    const bytes = new TextEncoder().encode("123456789")
    expect(crc32(bytes)).toBe(0xcbf43926)
  })
})

describe("createZip", () => {
  it("writes a single-entry archive with correct headers", () => {
    const data = new TextEncoder().encode("hello world")
    const zip = createZip([{ name: "hello.txt", data }])

    expect(readUint32(zip, 0)).toBe(0x04034b50)
    const nameLength = readUint16(zip, 26)
    const nameBytes = zip.slice(30, 30 + nameLength)
    expect(new TextDecoder().decode(nameBytes)).toBe("hello.txt")

    const payloadOffset = 30 + nameLength
    const payloadBytes = zip.slice(payloadOffset, payloadOffset + data.length)
    expect(new TextDecoder().decode(payloadBytes)).toBe("hello world")

    const eocdOffset = findLast(zip, 0x06054b50)
    expect(eocdOffset).toBeGreaterThanOrEqual(0)
    const entryCount = readUint16(zip, eocdOffset + 10)
    expect(entryCount).toBe(1)

    const centralDirectoryOffset = readUint32(zip, eocdOffset + 16)
    expect(readUint32(zip, centralDirectoryOffset)).toBe(0x02014b50)
  })

  it("writes a two-entry archive with correct offsets", () => {
    const entries: ZipEntry[] = [
      { name: "a.txt", data: new TextEncoder().encode("aaa") },
      { name: "b.txt", data: new TextEncoder().encode("bbbbb") },
    ]
    const zip = createZip(entries)

    const eocdOffset = findLast(zip, 0x06054b50)
    expect(readUint16(zip, eocdOffset + 10)).toBe(2)

    expect(readUint32(zip, 0)).toBe(0x04034b50)
    const firstNameLength = readUint16(zip, 26)
    const secondLocalHeaderOffset = 30 + firstNameLength + entries[0].data.length
    expect(readUint32(zip, secondLocalHeaderOffset)).toBe(0x04034b50)

    const centralDirectoryOffset = readUint32(zip, eocdOffset + 16)
    const firstCentralNameLength = readUint16(zip, centralDirectoryOffset + 28)
    const secondCentralOffset = centralDirectoryOffset + 46 + firstCentralNameLength
    expect(readUint32(zip, secondCentralOffset)).toBe(0x02014b50)

    const secondRelativeOffset = readUint32(zip, secondCentralOffset + 42)
    expect(secondRelativeOffset).toBe(secondLocalHeaderOffset)
    expect(readUint32(zip, secondRelativeOffset)).toBe(0x04034b50)
  })

  it("round-trips a UTF-8 filename and sets the UTF-8 flag", () => {
    const zip = createZip([{ name: "logs-café.log", data: new Uint8Array([1, 2, 3]) }])

    const flags = readUint16(zip, 6)
    expect(flags & 0x0800).toBe(0x0800)

    const nameLength = readUint16(zip, 26)
    const nameBytes = zip.slice(30, 30 + nameLength)
    expect(new TextDecoder().decode(nameBytes)).toBe("logs-café.log")
  })

  it("handles a zero-byte entry without corrupting later offsets", () => {
    const entries: ZipEntry[] = [
      { name: "empty.log", data: new Uint8Array(0) },
      { name: "next.log", data: new TextEncoder().encode("next") },
    ]
    const zip = createZip(entries)

    expect(readUint32(zip, 14)).toBe(0)
    expect(readUint32(zip, 18)).toBe(0)
    expect(readUint32(zip, 22)).toBe(0)

    const firstNameLength = readUint16(zip, 26)
    const secondLocalHeaderOffset = 30 + firstNameLength + 0
    expect(readUint32(zip, secondLocalHeaderOffset)).toBe(0x04034b50)

    const eocdOffset = findLast(zip, 0x06054b50)
    expect(readUint16(zip, eocdOffset + 10)).toBe(2)
  })

  it("normalizes backslashes and leading slashes in entry names", () => {
    const zipWithBackslashes = createZip([
      { name: "logs\\app.log", data: new Uint8Array([9]) },
    ])
    const nameLengthBackslash = readUint16(zipWithBackslashes, 26)
    expect(
      new TextDecoder().decode(zipWithBackslashes.slice(30, 30 + nameLengthBackslash)),
    ).toBe("logs/app.log")

    const zipWithLeadingSlash = createZip([
      { name: "/logs/app.log", data: new Uint8Array([9]) },
    ])
    const nameLengthLeadingSlash = readUint16(zipWithLeadingSlash, 26)
    expect(
      new TextDecoder().decode(zipWithLeadingSlash.slice(30, 30 + nameLengthLeadingSlash)),
    ).toBe("logs/app.log")
  })
})
