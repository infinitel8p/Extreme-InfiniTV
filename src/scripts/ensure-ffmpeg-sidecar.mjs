// Makes sure a ffmpeg sidecar binary is present for Tauri's externalBin bundling before
// `tauri dev` / `tauri build` runs. Windows and Linux desktop only; no-op elsewhere.
import { existsSync, mkdirSync, renameSync, copyFileSync, chmodSync, unlinkSync, createWriteStream } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { platform } from "node:os"
import { execFileSync } from "node:child_process"
import https from "node:https"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, "..", "..")
const binariesDir = join(repoRoot, "src-tauri", "binaries")

const RELEASE_BASE_URL =
  "https://github.com/infinitel8p/Extreme-InfiniTV/releases/download/ffmpeg-sidecar-v1"

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
  if (existsSync(destPath)) return

  const tmpPath = `${destPath}.tmp`

  try {
    await download(`${RELEASE_BASE_URL}/${target.asset}`, tmpPath)
    renameSync(tmpPath, destPath)
    if (platform() === "linux") chmodSync(destPath, 0o755)
    console.log(`[ensure-ffmpeg-sidecar] downloaded ${target.asset} -> ${destPath}`)
    return
  } catch (downloadError) {
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
      "  1. Run the ffmpeg-sidecar-v1 release workflow once so the binary exists on GitHub.\n" +
      "  2. Install ffmpeg and make sure it's on your PATH.\n" +
      `  3. Drop a ffmpeg binary manually at ${destPath}.`
  )
  process.exit(1)
}

await main()
