// Shared fetch/verify/cache machinery for desktop sidecar binaries (ffmpeg, mpv).
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
import { resolve as resolvePath } from "node:path"
import { platform } from "node:os"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import https from "node:https"

const DEFAULT_MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000

function httpsGet(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const request = https
      .get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume()
          if (redirectsLeft <= 0) {
            reject(new Error("too many redirects"))
            return
          }
          httpsGet(response.headers.location, redirectsLeft - 1).then(resolve, reject)
          return
        }
        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`HTTP ${response.statusCode}`))
          return
        }
        resolve(response)
      })
      .on("error", reject)
    request.setTimeout(30000, () => {
      request.destroy(new Error("download timed out after 30s"))
    })
  })
}

async function download(url, destPath) {
  const response = await httpsGet(url)
  await new Promise((resolve, reject) => {
    response.on("error", reject)
    const fileStream = createWriteStream(destPath)
    response.pipe(fileStream)
    fileStream.on("finish", () => fileStream.close(() => resolve()))
    fileStream.on("error", reject)
  })
}

async function fetchText(url) {
  const response = await httpsGet(url)
  return new Promise((resolve, reject) => {
    let body = ""
    response.setEncoding("utf8")
    response.on("data", (chunk) => (body += chunk))
    response.on("end", () => resolve(body))
    response.on("error", reject)
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

function releaseBaseUrl(config) {
  return `https://github.com/${config.githubRepo}/releases/download/${config.releaseTag}`
}

function updatePinsHint(config) {
  return `refresh them with "node ${config.scriptFileName} --update-pins", review the diff and commit it`
}

function readPins(config) {
  try {
    return JSON.parse(readFileSync(config.pinsFilePath, "utf8"))
  } catch (readError) {
    throw new ChecksumVerificationError(`could not read ${config.pinsFileRelative} (${readError.message})`)
  }
}

// The release's own sums are no trust root; the committed pins decide.
function pinnedHashFor(assetName, config) {
  const pins = readPins(config)
  if (pins?.tag !== config.releaseTag) {
    throw new ChecksumVerificationError(
      `${config.pinsFileRelative} pins tag "${pins?.tag}" but this script downloads from "${config.releaseTag}"; ${updatePinsHint(config)}`
    )
  }
  const pinnedHash = pins?.sha256?.[assetName]
  if (typeof pinnedHash !== "string" || !/^[0-9a-f]{64}$/.test(pinnedHash)) {
    throw new ChecksumVerificationError(
      `${assetName} has no pinned sha256 in ${config.pinsFileRelative}; ${updatePinsHint(config)}`
    )
  }
  return pinnedHash
}

// Deliberate asymmetry: fail closed on first install, keep-and-warn on re-verify.
async function checkAgainstPins(filePath, assetName, config) {
  let expectedHash
  try {
    expectedHash = pinnedHashFor(assetName, config)
  } catch (checkError) {
    console.warn(
      `[${config.logPrefix}] could not verify local binary against the pinned checksums (${checkError.message}), keeping it`
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

function extractBuildInfoFields(text, fields) {
  const result = {}
  for (const { label, key } of fields) {
    const match = text.match(new RegExp(`^${label}:\\s*(.+)$`, "m"))
    result[key] = match ? match[1].trim() : null
  }
  return result
}

async function fetchBuildInfo(config) {
  if (!config.buildInfoAssetName || !config.buildInfoFields) return null
  try {
    const text = await fetchText(`${releaseBaseUrl(config)}/${config.buildInfoAssetName}`)
    return extractBuildInfoFields(text, config.buildInfoFields)
  } catch {
    return null
  }
}

async function updatePins(config) {
  let sha256
  try {
    sha256 = parseSums(await fetchText(`${releaseBaseUrl(config)}/SHA256SUMS.txt`))
  } catch (fetchError) {
    console.error(
      `[${config.logPrefix}] could not download SHA256SUMS.txt from ${config.releaseTag} (${fetchError.message})`
    )
    process.exit(1)
  }
  const missing = config.pinnedAssetsForUpdateCheck.filter((assetName) => !sha256[assetName])
  if (missing.length > 0) {
    console.error(
      `[${config.logPrefix}] ${config.releaseTag} SHA256SUMS.txt is missing ${missing.join(", ")}; not rewriting ${config.pinsFileRelative}`
    )
    process.exit(1)
  }
  let previousPins = null
  try {
    previousPins = readPins(config)
  } catch {
    previousPins = null
  }
  const pins = {
    tag: config.releaseTag,
    pinnedAt: new Date().toISOString().slice(0, 10),
    sidecarBuild: (await fetchBuildInfo(config)) ?? previousPins?.sidecarBuild ?? null,
    sha256,
  }
  writeFileSync(config.pinsFilePath, `${JSON.stringify(pins, null, 2)}\n`)
  console.log(`[${config.logPrefix}] rewrote ${config.pinsFileRelative} from ${config.releaseTag}:`)
  for (const [assetName, hash] of Object.entries(sha256)) console.log(`  ${hash}  ${assetName}`)
  console.log(`[${config.logPrefix}] review the diff and commit it so CI trusts the new sidecar build`)
}

function printPin(assetName, config) {
  if (!assetName) {
    console.error(`[${config.logPrefix}] --print-pin needs an asset filename`)
    process.exit(1)
  }
  try {
    process.stdout.write(`${pinnedHashFor(assetName, config)}\n`)
  } catch (pinError) {
    console.error(`[${config.logPrefix}] ${pinError.message}`)
    process.exit(1)
  }
}

function printUsage(config) {
  console.log(
    [
      `Usage: node ${config.scriptFileName} [option]`,
      "",
      `  (no option)          ensure src-tauri/binaries holds the sidecar pinned in ${config.pinsFileRelative}`,
      "  --print-pin <asset>  print the pinned sha256 for one release asset (used by CI)",
      `  --update-pins        fetch ${config.releaseTag} checksums and rewrite ${config.pinsFileRelative}`,
      "  --help               this text",
      "",
      `Env: ${config.skipEnvVar}=1 skips everything, ${config.overrideEnvVar}=<file> installs a local binary.`,
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
async function markerIsFresh(markerPath, destPath, config) {
  const marker = readMarker(markerPath)
  if (!marker || marker.tag !== config.releaseTag) return false
  const maxAge = config.markerMaxAgeMs ?? DEFAULT_MARKER_MAX_AGE_MS
  if (typeof marker.verifiedAt !== "number" || Date.now() - marker.verifiedAt > maxAge) return false
  const actualHash = await sha256File(destPath)
  return actualHash === marker.sha256
}

// Migration cleanup for a binary named before a dest-naming scheme changed; no-op if unset.
function removeLegacyDest(target, config) {
  if (!config.legacyDestName) return
  const legacyPath = config.legacyDestName(target)
  if (!legacyPath) return
  if (existsSync(legacyPath)) unlinkSync(legacyPath)
  const legacyMarkerPath = markerPathFor(legacyPath)
  if (existsSync(legacyMarkerPath)) unlinkSync(legacyMarkerPath)
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

function destPathFor(target, config) {
  return `${config.binariesDir}/infinitv-${config.assetBaseName}-${target.triple}${target.ext}`
}

async function ensureSidecar(target, config) {
  const asset = `${config.assetBaseName}-${target.triple}${target.ext}`
  const destPath = destPathFor(target, config)
  const markerPath = markerPathFor(destPath)

  removeLegacyDest(target, config)

  if (existsSync(destPath)) {
    if (await markerIsFresh(markerPath, destPath, config)) {
      console.log(`[${config.logPrefix}] local binary verified recently, skipping re-verification`)
      return
    }
    const check = await checkAgainstPins(destPath, asset, config)
    if (check.status === "match") {
      writeMarker(markerPath, { tag: config.releaseTag, sha256: check.sha256, verifiedAt: Date.now() })
      return
    }
    if (check.status === "unverifiable") return
    console.log(`[${config.logPrefix}] local binary is out of date, re-fetching ${asset}`)
  }

  // Checked before any network call: a missing pin must fail closed, not silently fall back to PATH.
  let expectedHash
  try {
    expectedHash = pinnedHashFor(asset, config)
  } catch (pinError) {
    console.error(`[${config.logPrefix}] refusing to install ${asset}: ${pinError.message}`)
    process.exit(1)
  }

  const tmpPath = `${destPath}.tmp`

  try {
    await download(`${releaseBaseUrl(config)}/${asset}`, tmpPath)
    const actualHash = await sha256File(tmpPath)
    if (actualHash !== expectedHash) {
      throw new ChecksumVerificationError(`checksum mismatch for ${asset}: expected ${expectedHash}, got ${actualHash}`)
    }
    renameSync(tmpPath, destPath)
    if (platform() !== "win32") chmodSync(destPath, 0o755)
    writeMarker(markerPath, { tag: config.releaseTag, sha256: actualHash, verifiedAt: Date.now() })
    console.log(`[${config.logPrefix}] downloaded ${asset} -> ${destPath}`)
    return
  } catch (downloadError) {
    if (downloadError instanceof ChecksumVerificationError) {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
      console.error(`[${config.logPrefix}] refusing to install ${asset}: ${downloadError.message}`)
      process.exit(1)
    }
    if (existsSync(tmpPath)) unlinkSync(tmpPath)
    console.warn(
      `[${config.logPrefix}] release download failed (${downloadError.message}), falling back to PATH ${config.pathBinaryName ?? asset}`
    )
  }

  const pathBinary = config.pathBinaryName ? findOnPath(config.pathBinaryName) : null
  if (pathBinary) {
    copyFileSync(pathBinary, tmpPath)
    renameSync(tmpPath, destPath)
    if (platform() !== "win32") chmodSync(destPath, 0o755)
    console.log(
      `[${config.logPrefix}] dev fallback: copied PATH ${config.pathBinaryName} (${pathBinary}) -> ${destPath}. The release pipeline uses a pinned build instead.`
    )
    return
  }

  console.error(config.noBinaryHelp(destPath))
  process.exit(1)
}

async function main(config) {
  if (["1", "true"].includes(process.env[config.skipEnvVar])) {
    console.log(`[${config.logPrefix}] skipped (${config.skipEnvVar} set)`)
    return
  }

  const targets = config.resolveTargets()
  if (targets.length === 0) return

  mkdirSync(config.binariesDir, { recursive: true })

  const overridePath = process.env[config.overrideEnvVar]
  if (overridePath) {
    // Only ever used as a copy source, never handed to a shell.
    const resolvedOverride = resolvePath(overridePath.trim())
    if (!existsSync(resolvedOverride) || !statSync(resolvedOverride).isFile()) {
      console.error(`[${config.logPrefix}] ${config.overrideEnvVar} is set but ${resolvedOverride} is not an existing file`)
      process.exit(1)
    }
    for (const target of targets) {
      removeLegacyDest(target, config)
      const destPath = destPathFor(target, config)
      copyFileSync(resolvedOverride, destPath)
      if (platform() !== "win32") chmodSync(destPath, 0o755)
      const overrideHash = await sha256File(destPath)
      writeMarker(markerPathFor(destPath), { tag: config.releaseTag, sha256: overrideHash, verifiedAt: Date.now() })
      console.log(`[${config.logPrefix}] using ${config.overrideEnvVar} override: ${resolvedOverride} -> ${destPath}`)
    }
    return
  }

  for (const target of targets) {
    await ensureSidecar(target, config)
  }
}

export async function runSidecarCli(config) {
  const cliArgs = process.argv.slice(2)

  if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
    printUsage(config)
  } else if (cliArgs.includes("--update-pins")) {
    await updatePins(config)
  } else if (cliArgs.includes("--print-pin")) {
    printPin(cliArgs[cliArgs.indexOf("--print-pin") + 1], config)
  } else {
    await main(config)
  }
}
