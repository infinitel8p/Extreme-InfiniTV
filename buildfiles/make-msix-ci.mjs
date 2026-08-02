// Headless MSIX build for CI: stages the built exe + ffmpeg sidecar + logo
// assets and packs them with the Windows SDK tools (makepri, makeappx).
// The Microsoft Store re-signs on ingestion, so the package stays unsigned.
//
// Usage:
//   pnpm msix:ci                          # version from package.json
//   pnpm msix:ci --version 1.7.1          # explicit x.y.z
//   pnpm msix:ci --out dist/msix          # custom output directory
//
// This is the CI counterpart to `pnpm msix` (make-msix-template.mjs), which
// drives the interactive MsixPackagingTool GUI and stays as the manual
// fallback. Windows-only.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const BUILDFILES = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(BUILDFILES, "..")
const PKG = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"))

const args = process.argv.slice(2)
function argValue(flag) {
  const index = args.indexOf(flag)
  return index === -1 ? null : args[index + 1]
}

const version = argValue("--version") || PKG.version
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Bad --version "${version}". Expected x.y.z (e.g. 1.7.1).`)
  process.exit(1)
}
const msixVersion = `${version}.0`
const outDir = path.resolve(ROOT, argValue("--out") || path.join("src-tauri", "target", "release", "bundle", "msix"))

const exePath = path.join(ROOT, "src-tauri", "target", "release", "extreme-infinitv.exe")
if (!existsSync(exePath)) {
  console.error(`Missing ${exePath}. Run \`pnpm tauri build\` first.`)
  process.exit(1)
}

const ffmpegBuiltPath = path.join(ROOT, "src-tauri", "target", "release", "infinitv-ffmpeg.exe")
const ffmpegBinariesPath = path.join(ROOT, "src-tauri", "binaries", "infinitv-ffmpeg-x86_64-pc-windows-msvc.exe")
const ffmpegSourcePath = existsSync(ffmpegBuiltPath) ? ffmpegBuiltPath : ffmpegBinariesPath
if (!existsSync(ffmpegSourcePath)) {
  console.error(`Missing ffmpeg sidecar. Looked at:\n  ${ffmpegBuiltPath}\n  ${ffmpegBinariesPath}`)
  console.error("Run `pnpm fetch-ffmpeg` and `pnpm tauri build` first.")
  process.exit(1)
}

// Reuses the tauri-generated icons instead of a captured Assets/ folder, so
// the MSIX always ships the current app branding.
const iconsSourceDir = path.join(ROOT, "src-tauri", "icons")
const manifestIcons = ["StoreLogo.png", "Square44x44Logo.png", "Square71x71Logo.png", "Square150x150Logo.png"]
for (const iconName of manifestIcons) {
  if (!existsSync(path.join(iconsSourceDir, iconName))) {
    console.error(`Missing ${path.join(iconsSourceDir, iconName)}.`)
    process.exit(1)
  }
}

const manifestTemplatePath = path.join(BUILDFILES, "msix", "AppxManifest.template.xml")
if (!existsSync(manifestTemplatePath)) {
  console.error(`Missing ${manifestTemplatePath}.`)
  process.exit(1)
}

const sdkTools = resolveSdkTools()
if (!sdkTools) {
  console.error("Windows 10/11 SDK not found.")
  console.error(String.raw`Looked for makepri.exe and makeappx.exe under C:\Program Files (x86)\Windows Kits\10\bin\10.*\x64\.`)
  console.error("Install the Windows 10 SDK (App Certification Kit component) via the Visual Studio Installer.")
  process.exit(1)
}
console.log(`Using Windows SDK tools from ${sdkTools.dir}`)

const stagingDir = mkdtempSync(path.join(tmpdir(), "xtream-msix-"))
console.log(`Staging in ${stagingDir}`)

cpSync(exePath, path.join(stagingDir, "extreme-infinitv.exe"))
cpSync(ffmpegSourcePath, path.join(stagingDir, "infinitv-ffmpeg.exe"))
mkdirSync(path.join(stagingDir, "Assets"), { recursive: true })
for (const iconName of manifestIcons) {
  cpSync(path.join(iconsSourceDir, iconName), path.join(stagingDir, "Assets", iconName))
}

const manifestXml = readFileSync(manifestTemplatePath, "utf8").replace("__VERSION__", msixVersion)
writeFileSync(path.join(stagingDir, "AppxManifest.xml"), manifestXml)
console.log(`Wrote AppxManifest.xml (version ${msixVersion})`)

// Config lives outside stagingDir so it doesn't get packed as payload.
const priConfigDir = mkdtempSync(path.join(tmpdir(), "xtream-msix-cfg-"))
const priConfigPath = path.join(priConfigDir, "priconfig.xml")
run(sdkTools.makepri, ["createconfig", "/cf", priConfigPath, "/dq", "en-US", "/o"])

// The default config auto-splits resources into per-scale .pri files for
// bundle-style delivery; the Store package ships a single Resources.pri.
const priConfigXml = readFileSync(priConfigPath, "utf8").replace(/<packaging>[\s\S]*?<\/packaging>/, "")
writeFileSync(priConfigPath, priConfigXml)

const priOutputPath = path.join(stagingDir, "Resources.pri")
run(sdkTools.makepri, ["new", "/pr", stagingDir, "/cf", priConfigPath, "/of", priOutputPath, "/o"])

mkdirSync(outDir, { recursive: true })
const msixPath = path.join(outDir, `InfiniteL8p.XtreamIPTVPlayerLiveTV_${msixVersion}_x64.msix`)
run(sdkTools.makeappx, ["pack", "/d", stagingDir, "/p", msixPath, "/o"])

console.log(`MSIX written to ${msixPath}`)

function run(tool, toolArgs) {
  console.log(`> ${tool} ${toolArgs.join(" ")}`)
  try {
    execFileSync(tool, toolArgs, { stdio: "inherit" })
  } catch (runError) {
    console.error(`${path.basename(tool)} failed: ${runError.message}`)
    process.exit(1)
  }
}

function resolveSdkTools() {
  const kitsBinDir = String.raw`C:\Program Files (x86)\Windows Kits\10\bin`
  if (!existsSync(kitsBinDir)) return null
  const versionDirs = readdirSync(kitsBinDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^10\.\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => {
      const partsA = a.split(".").map(Number)
      const partsB = b.split(".").map(Number)
      for (let i = 0; i < partsA.length; i++) if (partsA[i] !== partsB[i]) return partsB[i] - partsA[i]
      return 0
    })
  for (const versionDir of versionDirs) {
    const toolsDir = path.join(kitsBinDir, versionDir, "x64")
    const makepri = path.join(toolsDir, "makepri.exe")
    const makeappx = path.join(toolsDir, "makeappx.exe")
    if (existsSync(makepri) && existsSync(makeappx)) return { dir: toolsDir, makepri, makeappx }
  }
  return null
}
