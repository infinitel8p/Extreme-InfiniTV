// Ensures the embedded-mpv sidecar binary exists before tauri dev/build. Windows only.
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { platform } from "node:os"
import { readFileSync } from "node:fs"
import { runSidecarCli } from "./sidecar-fetch.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, "..", "..")

function resolveTargets() {
  if (platform() !== "win32") return []
  if (process.arch === "x64") return [{ triple: "x86_64-pc-windows-msvc", ext: ".exe" }]
  if (process.arch === "arm64") return [{ triple: "aarch64-pc-windows-msvc", ext: ".exe" }]
  return []
}

const config = {
  logPrefix: "ensure-mpv-runtime",
  scriptFileName: "src/scripts/ensure-mpv-runtime.mjs",
  githubRepo: "infinitel8p/Extreme-InfiniTV",
  releaseTag: "mpv-runtime-v1",
  pinsFilePath: join(__dirname, "mpv-runtime-checksums.json"),
  pinsFileRelative: "src/scripts/mpv-runtime-checksums.json",
  binariesDir: join(repoRoot, "src-tauri", "binaries"),
  assetBaseName: "mpv",
  resolveTargets,
  pathBinaryName: "mpv",
  skipEnvVar: "XT_SKIP_MPV_RUNTIME",
  overrideEnvVar: "XT_MPV_RUNTIME_OVERRIDE_PATH",
  buildInfoAssetName: "BUILD-INFO-windows.txt",
  buildInfoFields: [
    { label: "mpv version", key: "mpvVersion" },
    { label: "source", key: "sourceUrl" },
    { label: "rehosted", key: "builtAt" },
    { label: "workflow commit", key: "workflowCommit" },
  ],
  pinnedAssetsForUpdateCheck: [
    "mpv-x86_64-pc-windows-msvc.exe",
    "mpv-aarch64-pc-windows-msvc.exe",
    "BUILD-INFO-windows.txt",
    "BUILD-INFO-windows-arm64.txt",
    "Copyright",
  ],
  noBinaryHelp: (destPath) =>
    "[ensure-mpv-runtime] no mpv sidecar available. Fix one of:\n" +
    "  1. Run the mpv-runtime-v1 release workflow once so the binary exists on GitHub.\n" +
    "  2. Install mpv and make sure it's on your PATH.\n" +
    "  3. Set XT_MPV_RUNTIME_OVERRIDE_PATH to a local mpv binary.\n" +
    `  4. Drop a mpv binary manually at ${destPath}.`,
}

const cliArgs = process.argv.slice(2)

// -1 = unreadable, so the normal fail-closed path in sidecar-fetch handles it.
function pinnedAssetCount() {
  try {
    const pins = JSON.parse(readFileSync(config.pinsFilePath, "utf8"))
    return Object.keys(pins?.sha256 ?? {}).length
  } catch {
    return -1
  }
}

// Only the never-published state is tolerated; a partial or wrong pin still fails closed.
function skipUntilFirstPublish() {
  if (cliArgs.length > 0) return false
  if (process.env[config.overrideEnvVar]) return false
  if (resolveTargets().length === 0) return false
  return pinnedAssetCount() === 0
}

// Lets the release pipelines branch on "published yet?" without reparsing the pins format.
if (cliArgs.includes("--has-pins")) {
  process.exit(pinnedAssetCount() > 0 ? 0 : 1)
} else if (skipUntilFirstPublish()) {
  console.warn(
    `[${config.logPrefix}] no checksums pinned in ${config.pinsFileRelative} yet, skipping the mpv sidecar. ` +
      `Run the "mpv Runtime" workflow, then "node ${config.scriptFileName} --update-pins" and commit the result.`
  )
} else {
  await runSidecarCli(config)
}
