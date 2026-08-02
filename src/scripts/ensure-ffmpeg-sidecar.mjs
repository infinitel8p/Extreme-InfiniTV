// Makes sure a ffmpeg sidecar binary is present for Tauri's externalBin bundling before
// `tauri dev` / `tauri build` runs. Windows, Linux, and macOS desktop only; no-op elsewhere.
import {
  existsSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  chmodSync,
  unlinkSync,
  statSync,
  createWriteStream,
  createReadStream,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve as resolvePath } from "node:path"
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
const PINS_FILE = "src/scripts/ffmpeg-sidecar-checksums.json"
const pinsPath = join(__dirname, "ffmpeg-sidecar-checksums.json")
const REFRESH_PINS_HINT =
  'refresh them with "node src/scripts/ensure-ffmpeg-sidecar.mjs --update-pins", review the diff and commit it'
const PINNED_BINARY_ASSETS = [
  "ffmpeg-x86_64-pc-windows-msvc.exe",
  "ffmpeg-x86_64-unknown-linux-gnu",
  "ffmpeg-aarch64-pc-windows-msvc.exe",
  "ffmpeg-aarch64-unknown-linux-gnu",
  "ffmpeg-aarch64-apple-darwin",
  "ffmpeg-x86_64-apple-darwin",
  "ffmpeg-universal-apple-darwin",
]

function toTarget(triple, ext) {
  return { triple, ext, asset: `ffmpeg-${triple}${ext}` }
}

// macOS always resolves all three targets: `tauri build --target universal-apple-darwin`
// compiles each arch separately (each needs its own triple binary) then bundles the universal one.
function resolveTargets() {
  switch (platform()) {
    case "win32":
      if (process.arch === "x64") return [toTarget("x86_64-pc-windows-msvc", ".exe")]
      if (process.arch === "arm64") return [toTarget("aarch64-pc-windows-msvc", ".exe")]
      return []
    case "linux":
      if (process.arch === "x64") return [toTarget("x86_64-unknown-linux-gnu", "")]
      if (process.arch === "arm64") return [toTarget("aarch64-unknown-linux-gnu", "")]
      return []
    case "darwin":
      if (process.arch === "arm64" || process.arch === "x64") {
        return [
          toTarget("aarch64-apple-darwin", ""),
          toTarget("x86_64-apple-darwin", ""),
          toTarget("universal-apple-darwin", ""),
        ]
      }
      return []
    default:
      return []
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

function readPins() {
  try {
    return JSON.parse(readFileSync(pinsPath, "utf8"))
  } catch (readError) {
    throw new ChecksumVerificationError(`could not read ${PINS_FILE} (${readError.message})`)
  }
}

// The release's own sums are no trust root; the committed pins decide.
function pinnedHashFor(assetName) {
  const pins = readPins()
  if (pins?.tag !== RELEASE_TAG) {
    throw new ChecksumVerificationError(
      `${PINS_FILE} pins tag "${pins?.tag}" but this script downloads from "${RELEASE_TAG}"; ${REFRESH_PINS_HINT}`
    )
  }
  const pinnedHash = pins?.sha256?.[assetName]
  if (typeof pinnedHash !== "string" || !/^[0-9a-f]{64}$/.test(pinnedHash)) {
    throw new ChecksumVerificationError(
      `${assetName} has no pinned sha256 in ${PINS_FILE}; ${REFRESH_PINS_HINT}`
    )
  }
  return pinnedHash
}

async function verifyChecksum(filePath, assetName) {
  const expectedHash = pinnedHashFor(assetName)
  const actualHash = await sha256File(filePath)
  if (actualHash !== expectedHash) {
    throw new ChecksumVerificationError(`checksum mismatch for ${assetName}: expected ${expectedHash}, got ${actualHash}`)
  }
  return actualHash
}

// Deliberate asymmetry: fail closed on first install, keep-and-warn on re-verify.
async function checkAgainstPins(filePath, assetName) {
  let expectedHash
  try {
    expectedHash = pinnedHashFor(assetName)
  } catch (checkError) {
    console.warn(
      `[ensure-ffmpeg-sidecar] could not verify local binary against the pinned checksums (${checkError.message}), keeping it`
    )
    return { status: "unverifiable" }
  }
  const actualHash = await sha256File(filePath)
  return actualHash === expectedHash ? { status: "match", sha256: actualHash } : { status: "mismatch" }
}

function parseSums(sumsText) {
  const sha256 = {}
  for (const line of sumsText.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S.*)$/)
    if (match) sha256[match[2].trim()] = match[1]
  }
  return sha256
}

async function fetchSidecarBuild() {
  try {
    const buildInfo = await fetchText(`${RELEASE_BASE_URL}/BUILD-INFO-windows.txt`)
    const field = (label) => buildInfo.match(new RegExp(`^${label}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? null
    return {
      ffmpegVersion: field("ffmpeg version"),
      builtAt: field("built"),
      workflowCommit: field("workflow commit"),
    }
  } catch {
    return null
  }
}

async function updatePins() {
  let sha256
  try {
    sha256 = parseSums(await fetchText(`${RELEASE_BASE_URL}/SHA256SUMS.txt`))
  } catch (fetchError) {
    console.error(
      `[ensure-ffmpeg-sidecar] could not download SHA256SUMS.txt from ${RELEASE_TAG} (${fetchError.message})`
    )
    process.exit(1)
  }
  const missing = PINNED_BINARY_ASSETS.filter((assetName) => !sha256[assetName])
  if (missing.length > 0) {
    console.error(
      `[ensure-ffmpeg-sidecar] ${RELEASE_TAG} SHA256SUMS.txt is missing ${missing.join(", ")}; not rewriting ${PINS_FILE}`
    )
    process.exit(1)
  }
  let previousPins = null
  try {
    previousPins = readPins()
  } catch {
    previousPins = null
  }
  const pins = {
    tag: RELEASE_TAG,
    pinnedAt: new Date().toISOString().slice(0, 10),
    sidecarBuild: (await fetchSidecarBuild()) ?? previousPins?.sidecarBuild ?? null,
    sha256,
  }
  writeFileSync(pinsPath, `${JSON.stringify(pins, null, 2)}\n`)
  console.log(`[ensure-ffmpeg-sidecar] rewrote ${PINS_FILE} from ${RELEASE_TAG}:`)
  for (const [assetName, hash] of Object.entries(sha256)) console.log(`  ${hash}  ${assetName}`)
  console.log("[ensure-ffmpeg-sidecar] review the diff and commit it so CI trusts the new sidecar build")
}

function printPin(assetName) {
  if (!assetName) {
    console.error("[ensure-ffmpeg-sidecar] --print-pin needs an asset filename")
    process.exit(1)
  }
  try {
    process.stdout.write(`${pinnedHashFor(assetName)}\n`)
  } catch (pinError) {
    console.error(`[ensure-ffmpeg-sidecar] ${pinError.message}`)
    process.exit(1)
  }
}

function printUsage() {
  console.log(
    [
      "Usage: node src/scripts/ensure-ffmpeg-sidecar.mjs [option]",
      "",
      `  (no option)          ensure src-tauri/binaries holds the sidecar pinned in ${PINS_FILE}`,
      "  --print-pin <asset>  print the pinned sha256 for one release asset (used by CI)",
      `  --update-pins        fetch ${RELEASE_TAG} checksums and rewrite ${PINS_FILE}`,
      "  --help               this text",
      "",
      "Env: XT_SKIP_FFMPEG_SIDECAR=1 skips everything, XT_FFMPEG_SIDECAR_PATH=<file> installs a local binary.",
    ].join("\n")
  )
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

// Cleans up the pre-rename destination so dev machines don't keep both.
function removeStaleOldNamedBinary(target) {
  const oldDestPath = join(binariesDir, `ffmpeg-${target.triple}${target.ext}`)
  if (existsSync(oldDestPath)) unlinkSync(oldDestPath)
  const oldMarkerPath = markerPathFor(oldDestPath)
  if (existsSync(oldMarkerPath)) unlinkSync(oldMarkerPath)
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

async function ensureSidecar(target) {
  const destPath = join(binariesDir, `infinitv-ffmpeg-${target.triple}${target.ext}`)
  const markerPath = markerPathFor(destPath)

  removeStaleOldNamedBinary(target)

  if (existsSync(destPath)) {
    if (await markerIsFresh(markerPath, destPath)) {
      console.log("[ensure-ffmpeg-sidecar] local binary verified recently, skipping re-verification")
      return
    }
    const check = await checkAgainstPins(destPath, target.asset)
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
    if (platform() !== "win32") chmodSync(destPath, 0o755)
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
    if (platform() !== "win32") chmodSync(destPath, 0o755)
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

async function main() {
  if (["1", "true"].includes(process.env.XT_SKIP_FFMPEG_SIDECAR)) {
    console.log("[ensure-ffmpeg-sidecar] skipped (XT_SKIP_FFMPEG_SIDECAR set)")
    return
  }

  const targets = resolveTargets()
  if (targets.length === 0) return

  mkdirSync(binariesDir, { recursive: true })

  const overridePath = process.env.XT_FFMPEG_SIDECAR_PATH
  if (overridePath) {
    // Only ever used as a copy source, never handed to a shell.
    const resolvedOverride = resolvePath(overridePath.trim())
    if (!existsSync(resolvedOverride) || !statSync(resolvedOverride).isFile()) {
      console.error(
        `[ensure-ffmpeg-sidecar] XT_FFMPEG_SIDECAR_PATH is set but ${resolvedOverride} is not an existing file`
      )
      process.exit(1)
    }
    for (const target of targets) {
      removeStaleOldNamedBinary(target)
      const destPath = join(binariesDir, `infinitv-ffmpeg-${target.triple}${target.ext}`)
      copyFileSync(resolvedOverride, destPath)
      if (platform() !== "win32") chmodSync(destPath, 0o755)
      const overrideHash = await sha256File(destPath)
      writeMarker(markerPathFor(destPath), { tag: RELEASE_TAG, sha256: overrideHash, verifiedAt: Date.now() })
      console.log(`[ensure-ffmpeg-sidecar] using XT_FFMPEG_SIDECAR_PATH override: ${resolvedOverride} -> ${destPath}`)
    }
    return
  }

  for (const target of targets) {
    await ensureSidecar(target)
  }
}

const cliArgs = process.argv.slice(2)

if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
  printUsage()
} else if (cliArgs.includes("--update-pins")) {
  await updatePins()
} else if (cliArgs.includes("--print-pin")) {
  printPin(cliArgs[cliArgs.indexOf("--print-pin") + 1])
} else {
  await main()
}
