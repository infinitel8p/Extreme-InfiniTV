// Ensures the ffmpeg sidecar binary exists before tauri dev/build. Windows/Linux/macOS only.
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { platform } from "node:os"
import { runSidecarCli } from "./sidecar-fetch.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, "..", "..")

function toTarget(triple, ext) {
  return { triple, ext }
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

const config = {
  logPrefix: "ensure-ffmpeg-sidecar",
  scriptFileName: "src/scripts/ensure-ffmpeg-sidecar.mjs",
  githubRepo: "infinitel8p/Extreme-InfiniTV",
  releaseTag: "ffmpeg-sidecar-v2",
  pinsFilePath: join(__dirname, "ffmpeg-sidecar-checksums.json"),
  pinsFileRelative: "src/scripts/ffmpeg-sidecar-checksums.json",
  binariesDir: join(repoRoot, "src-tauri", "binaries"),
  assetBaseName: "ffmpeg",
  resolveTargets,
  pathBinaryName: "ffmpeg",
  skipEnvVar: "XT_SKIP_FFMPEG_SIDECAR",
  overrideEnvVar: "XT_FFMPEG_SIDECAR_PATH",
  // Cleans up the pre-rename destination so dev machines don't keep both.
  legacyDestName: (target) => join(repoRoot, "src-tauri", "binaries", `ffmpeg-${target.triple}${target.ext}`),
  buildInfoAssetName: "BUILD-INFO-windows.txt",
  buildInfoFields: [
    { label: "ffmpeg version", key: "ffmpegVersion" },
    { label: "built", key: "builtAt" },
    { label: "workflow commit", key: "workflowCommit" },
  ],
  pinnedAssetsForUpdateCheck: [
    "ffmpeg-x86_64-pc-windows-msvc.exe",
    "ffmpeg-x86_64-unknown-linux-gnu",
    "ffmpeg-aarch64-pc-windows-msvc.exe",
    "ffmpeg-aarch64-unknown-linux-gnu",
    "ffmpeg-aarch64-apple-darwin",
    "ffmpeg-x86_64-apple-darwin",
    "ffmpeg-universal-apple-darwin",
  ],
  noBinaryHelp: (destPath) =>
    "[ensure-ffmpeg-sidecar] no ffmpeg sidecar available. Fix one of:\n" +
    "  1. Run the ffmpeg-sidecar-v2 release workflow once so the binary exists on GitHub.\n" +
    "  2. Install ffmpeg and make sure it's on your PATH.\n" +
    "  3. Set XT_FFMPEG_SIDECAR_PATH to a local ffmpeg binary.\n" +
    `  4. Drop a ffmpeg binary manually at ${destPath}.`,
}

await runSidecarCli(config)
