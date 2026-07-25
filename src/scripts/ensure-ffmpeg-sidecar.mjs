// Makes sure a ffmpeg sidecar binary is present for Tauri's externalBin bundling before
// `tauri dev` / `tauri build` runs. Windows and Linux desktop only; no-op elsewhere.
import {
  existsSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  chmodSync,
  unlinkSync,
  createWriteStream,
  createReadStream,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { platform } from "node:os"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import https from "node:https"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, "..", "..")
const binariesDir = join(repoRoot, "src-tauri", "binaries")

const RELEASE_BASE_URL =
  "https://github.com/infinitel8p/Extreme-InfiniTV/releases/download/ffmpeg-sidecar-v2"
const RELEASE_TAG = RELEASE_BASE_URL.split("/").pop()
const MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000

function resolveTarget() {
  switch (platform()) {
    case "win32":
      return { triple: "x86_64-pc-windows-msvc", ext: ".exe", asset: "ffmpeg-x86_64-pc-windows-msvc.exe" }
    case "linux":
      return { triple: "x86_64-unknown-linux-gnu", ext: "", asset: "ffmpeg-x86_64-unknown-linux-gnu" }
    default:
      return null
  }
}

function download(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const request = https
      .get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume()
          if (redirectsLeft <= 0) {
            reject(new Error("too many redirects"))
            return
          }
          download(response.headers.location, destPath, redirectsLeft - 1).then(resolve, reject)
          return
        }
        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`HTTP ${response.statusCode}`))
          return
        }
        response.on("error", reject)
        const fileStream = createWriteStream(destPath)
        response.pipe(fileStream)
        fileStream.on("finish", () => fileStream.close(() => resolve()))
        fileStream.on("error", reject)
      })
      .on("error", reject)
    request.setTimeout(30000, () => {
      request.destroy(new Error("download timed out after 30s"))
    })
  })
}

function fetchText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const request = https
      .get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume()
          if (redirectsLeft <= 0) {
            reject(new Error("too many redirects"))
            return
          }
          fetchText(response.headers.location, redirectsLeft - 1).then(resolve, reject)
          return
        }
        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`HTTP ${response.statusCode}`))
          return
        }
        let body = ""
        response.setEncoding("utf8")
        response.on("data", (chunk) => (body += chunk))
        response.on("end", () => resolve(body))
        response.on("error", reject)
      })
      .on("error", reject)
    request.setTimeout(30000, () => {
      request.destroy(new Error("download timed out after 30s"))
    })
  })
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    const stream = createReadStream(filePath)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", () => resolve(hash.digest("hex")))
    stream.on("error", reject)
  })
}

class ChecksumVerificationError extends Error {}

async function expectedHashFor(assetName) {
  const sumsText = await fetchText(`${RELEASE_BASE_URL}/SHA256SUMS.txt`)
  const sumsLine = sumsText.split(/\r?\n/).find((line) => line.trim().endsWith(assetName))
  if (!sumsLine) {
    throw new ChecksumVerificationError(`${assetName} is not listed in SHA256SUMS.txt`)
  }
  return sumsLine.trim().split(/\s+/)[0]
}

async function verifyChecksum(filePath, assetName) {
  let expectedHash
  try {
    expectedHash = await expectedHashFor(assetName)
  } catch (fetchError) {
    if (fetchError instanceof ChecksumVerificationError) throw fetchError
    throw new ChecksumVerificationError(`could not download SHA256SUMS.txt (${fetchError.message})`)
  }
  const actualHash = await sha256File(filePath)
  if (actualHash !== expectedHash) {
    throw new ChecksumVerificationError(`checksum mismatch for ${assetName}: expected ${expectedHash}, got ${actualHash}`)
  }
  return actualHash
}

// Lookup failure keeps the existing binary; marked unverifiable, not cached.
async function checkAgainstRelease(filePath, assetName) {
  let expectedHash
  try {
    expectedHash = await expectedHashFor(assetName)
  } catch (checkError) {
    console.warn(
      `[ensure-ffmpeg-sidecar] could not verify local binary against the latest release (${checkError.message}), keeping it`
    )
    return { status: "unverifiable" }
  }
  const actualHash = await sha256File(filePath)
  return actualHash === expectedHash ? { status: "match", sha256: actualHash } : { status: "mismatch" }
}

function markerPathFor(destPath) {
  return `${destPath}.marker.json`
}

function readMarker(markerPath) {
  try {
    return JSON.parse(readFileSync(markerPath, "utf8"))
  } catch {
    return null
  }
}

function writeMarker(markerPath, marker) {
  try {
    writeFileSync(markerPath, JSON.stringify(marker))
  } catch {
    // best-effort local cache, safe to skip on write failure
  }
}

// Skips the network check when a recent marker still matches.
async function markerIsFresh(markerPath, destPath) {
  const marker = readMarker(markerPath)
  if (!marker || marker.tag !== RELEASE_TAG) return false
  if (typeof marker.verifiedAt !== "number" || Date.now() - marker.verifiedAt > MARKER_MAX_AGE_MS) return false
  const actualHash = await sha256File(destPath)
  return actualHash === marker.sha256
}

function findOnPath(binaryName) {
  try {
    const command = platform() === "win32" ? "where" : "which"
    const output = execFileSync(command, [binaryName], { encoding: "utf8" })
    const firstLine = output.split(/\r?\n/).find((line) => line.trim().length > 0)
    return firstLine ? firstLine.trim() : null
  } catch {
    return null
  }
}

async function main() {
  if (["1", "true"].includes(process.env.XT_SKIP_FFMPEG_SIDECAR)) {
    console.log("[ensure-ffmpeg-sidecar] skipped (XT_SKIP_FFMPEG_SIDECAR set)")
    return
  }

  const target = resolveTarget()
  if (!target) return

  mkdirSync(binariesDir, { recursive: true })
  const destPath = join(binariesDir, `ffmpeg-${target.triple}${target.ext}`)
  const markerPath = markerPathFor(destPath)

  const overridePath = process.env.XT_FFMPEG_SIDECAR_PATH
  if (overridePath) {
    if (!existsSync(overridePath)) {
      console.error(`[ensure-ffmpeg-sidecar] XT_FFMPEG_SIDECAR_PATH is set but ${overridePath} does not exist`)
      process.exit(1)
    }
    copyFileSync(overridePath, destPath)
    if (platform() === "linux") chmodSync(destPath, 0o755)
    const overrideHash = await sha256File(destPath)
    writeMarker(markerPath, { tag: RELEASE_TAG, sha256: overrideHash, verifiedAt: Date.now() })
    console.log(`[ensure-ffmpeg-sidecar] using XT_FFMPEG_SIDECAR_PATH override: ${overridePath} -> ${destPath}`)
    return
  }

  if (existsSync(destPath)) {
    if (await markerIsFresh(markerPath, destPath)) {
      console.log("[ensure-ffmpeg-sidecar] local binary verified recently, skipping network check")
      return
    }
    const check = await checkAgainstRelease(destPath, target.asset)
    if (check.status === "match") {
      writeMarker(markerPath, { tag: RELEASE_TAG, sha256: check.sha256, verifiedAt: Date.now() })
      return
    }
    if (check.status === "unverifiable") return
    console.log(`[ensure-ffmpeg-sidecar] local binary is out of date, re-fetching ${target.asset}`)
  }

  const tmpPath = `${destPath}.tmp`

  try {
    await download(`${RELEASE_BASE_URL}/${target.asset}`, tmpPath)
    const verifiedHash = await verifyChecksum(tmpPath, target.asset)
    renameSync(tmpPath, destPath)
    if (platform() === "linux") chmodSync(destPath, 0o755)
    writeMarker(markerPath, { tag: RELEASE_TAG, sha256: verifiedHash, verifiedAt: Date.now() })
    console.log(`[ensure-ffmpeg-sidecar] downloaded ${target.asset} -> ${destPath}`)
    return
  } catch (downloadError) {
    if (downloadError instanceof ChecksumVerificationError) {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
      console.error(
        `[ensure-ffmpeg-sidecar] refusing to install ${target.asset}: ${downloadError.message}`
      )
      process.exit(1)
    }
    if (existsSync(tmpPath)) unlinkSync(tmpPath)
    console.warn(
      `[ensure-ffmpeg-sidecar] release download failed (${downloadError.message}), falling back to PATH ffmpeg`
    )
  }

  const pathBinary = findOnPath("ffmpeg")
  if (pathBinary) {
    copyFileSync(pathBinary, tmpPath)
    renameSync(tmpPath, destPath)
    if (platform() === "linux") chmodSync(destPath, 0o755)
    console.log(
      `[ensure-ffmpeg-sidecar] dev fallback: copied PATH ffmpeg (${pathBinary}) -> ${destPath}. The release pipeline uses a trimmed build instead.`
    )
    return
  }

  console.error(
    "[ensure-ffmpeg-sidecar] no ffmpeg sidecar available. Fix one of:\n" +
      "  1. Run the ffmpeg-sidecar-v2 release workflow once so the binary exists on GitHub.\n" +
      "  2. Install ffmpeg and make sure it's on your PATH.\n" +
      "  3. Set XT_FFMPEG_SIDECAR_PATH to a local ffmpeg binary.\n" +
      `  4. Drop a ffmpeg binary manually at ${destPath}.`
  )
  process.exit(1)
}

await main()
