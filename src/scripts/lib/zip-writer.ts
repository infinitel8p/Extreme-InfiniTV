// Dependency-free ZIP writer (STORED entries only) for bundling diagnostic files.

export interface ZipEntry {
  name: string
  data: Uint8Array
  modifiedAt?: Date
}

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const VERSION = 20
const UTF8_FLAG = 0x0800
const STORED_METHOD = 0

let crcTable: Uint32Array | null = null

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  const table = new Uint32Array(256)
  for (let byteValue = 0; byteValue < 256; byteValue++) {
    let remainder = byteValue
    for (let bit = 0; bit < 8; bit++) {
      remainder = remainder & 1 ? 0xedb88320 ^ (remainder >>> 1) : remainder >>> 1
    }
    table[byteValue] = remainder
  }
  crcTable = table
  return table
}

export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// DOS date/time floor is 1980-01-01 00:00:00; pre-1980 dates clamp to it.
function toDosDateTime(modifiedAt: Date | undefined): { dosTime: number; dosDate: number } {
  const date = modifiedAt ?? new Date(1980, 0, 1)
  const year = date.getFullYear()
  if (year < 1980) return { dosTime: 0, dosDate: 0x21 }
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2))
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { dosTime, dosDate }
}

function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, "/").replace(/^\/+/, "")
}

class ByteWriter {
  private chunks: Uint8Array[] = []
  length = 0

  writeBytes(bytes: Uint8Array): void {
    this.chunks.push(bytes)
    this.length += bytes.length
  }

  writeUint16(value: number): void {
    const buffer = new Uint8Array(2)
    buffer[0] = value & 0xff
    buffer[1] = (value >>> 8) & 0xff
    this.writeBytes(buffer)
  }

  writeUint32(value: number): void {
    const buffer = new Uint8Array(4)
    buffer[0] = value & 0xff
    buffer[1] = (value >>> 8) & 0xff
    buffer[2] = (value >>> 16) & 0xff
    buffer[3] = (value >>> 24) & 0xff
    this.writeBytes(buffer)
  }

  toUint8Array(): Uint8Array {
    const result = new Uint8Array(this.length)
    let offset = 0
    for (const chunk of this.chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    return result
  }
}

interface PreparedEntry {
  nameBytes: Uint8Array
  data: Uint8Array
  crc: number
  dosTime: number
  dosDate: number
  localHeaderOffset: number
}

export function createZip(entries: ZipEntry[]): Uint8Array {
  const writer = new ByteWriter()
  const prepared: PreparedEntry[] = []
  const textEncoder = new TextEncoder()

  for (const entry of entries) {
    const nameBytes = textEncoder.encode(normalizeEntryName(entry.name))
    const { dosTime, dosDate } = toDosDateTime(entry.modifiedAt)
    const crc = crc32(entry.data)
    const localHeaderOffset = writer.length

    writer.writeUint32(LOCAL_FILE_HEADER_SIGNATURE)
    writer.writeUint16(VERSION)
    writer.writeUint16(UTF8_FLAG)
    writer.writeUint16(STORED_METHOD)
    writer.writeUint16(dosTime)
    writer.writeUint16(dosDate)
    writer.writeUint32(crc)
    writer.writeUint32(entry.data.length)
    writer.writeUint32(entry.data.length)
    writer.writeUint16(nameBytes.length)
    writer.writeUint16(0)
    writer.writeBytes(nameBytes)
    writer.writeBytes(entry.data)

    prepared.push({ nameBytes, data: entry.data, crc, dosTime, dosDate, localHeaderOffset })
  }

  const centralDirectoryOffset = writer.length
  for (const entry of prepared) {
    writer.writeUint32(CENTRAL_DIRECTORY_SIGNATURE)
    writer.writeUint16(VERSION)
    writer.writeUint16(VERSION)
    writer.writeUint16(UTF8_FLAG)
    writer.writeUint16(STORED_METHOD)
    writer.writeUint16(entry.dosTime)
    writer.writeUint16(entry.dosDate)
    writer.writeUint32(entry.crc)
    writer.writeUint32(entry.data.length)
    writer.writeUint32(entry.data.length)
    writer.writeUint16(entry.nameBytes.length)
    writer.writeUint16(0)
    writer.writeUint16(0)
    writer.writeUint16(0)
    writer.writeUint16(0)
    writer.writeUint32(0)
    writer.writeUint32(entry.localHeaderOffset)
    writer.writeBytes(entry.nameBytes)
  }
  const centralDirectorySize = writer.length - centralDirectoryOffset

  writer.writeUint32(END_OF_CENTRAL_DIRECTORY_SIGNATURE)
  writer.writeUint16(0)
  writer.writeUint16(0)
  writer.writeUint16(prepared.length)
  writer.writeUint16(prepared.length)
  writer.writeUint32(centralDirectorySize)
  writer.writeUint32(centralDirectoryOffset)
  writer.writeUint16(0)

  return writer.toUint8Array()
}
