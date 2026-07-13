// Pure semver-ish comparison used by the "What's new" gate.

// Parse a "v1.6.3" / "1.6.3-beta.2" tag into comparable numeric parts. Any
// non-numeric suffix (pre-release tags) is dropped for the comparison.
export function parseVersion(raw: string): number[] {
  return raw
    .replace(/^v/i, "")
    .split(/[.\-+]/)
    .map((part) => parseInt(part, 10))
    .filter((part) => Number.isFinite(part))
}

interface ParsedForCompare {
  core: number[]
  prerelease: string[]
}

// Parse a tag into a numeric core and semver-style prerelease identifiers.
// Non-numeric core segments fall back to 0 so garbage tags don't throw.
function parseForCompare(raw: string): ParsedForCompare {
  const withoutBuildMeta = raw.replace(/^v/i, "").split("+")[0]
  const hyphenIndex = withoutBuildMeta.indexOf("-")
  const coreString =
    hyphenIndex === -1 ? withoutBuildMeta : withoutBuildMeta.slice(0, hyphenIndex)
  const prereleaseString =
    hyphenIndex === -1 ? "" : withoutBuildMeta.slice(hyphenIndex + 1)
  const core = coreString.split(".").map((segment) => {
    const numeric = parseInt(segment, 10)
    return Number.isFinite(numeric) ? numeric : 0
  })
  const prerelease =
    prereleaseString === ""
      ? []
      : prereleaseString.split(".").flatMap((identifier) => {
          const alphaNumericMatch = /^([a-zA-Z]+)(\d+)$/.exec(identifier)
          return alphaNumericMatch ? [alphaNumericMatch[1], alphaNumericMatch[2]] : [identifier]
        })
  return { core, prerelease }
}

function compareCores(leftCore: number[], rightCore: number[]): number {
  const length = Math.max(leftCore.length, rightCore.length)
  for (let i = 0; i < length; i++) {
    const diff = (leftCore[i] || 0) - (rightCore[i] || 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

// Semver precedence: numeric identifiers compare numerically and always
// rank below alphanumeric ones; alphanumeric identifiers compare lexically.
function compareIdentifier(leftIdentifier: string, rightIdentifier: string): number {
  const leftIsNumeric = /^\d+$/.test(leftIdentifier)
  const rightIsNumeric = /^\d+$/.test(rightIdentifier)
  if (leftIsNumeric && rightIsNumeric) {
    const diff = parseInt(leftIdentifier, 10) - parseInt(rightIdentifier, 10)
    return diff === 0 ? 0 : diff > 0 ? 1 : -1
  }
  if (leftIsNumeric !== rightIsNumeric) return leftIsNumeric ? -1 : 1
  if (leftIdentifier === rightIdentifier) return 0
  return leftIdentifier > rightIdentifier ? 1 : -1
}

function comparePrereleases(leftPrerelease: string[], rightPrerelease: string[]): number {
  const length = Math.min(leftPrerelease.length, rightPrerelease.length)
  for (let i = 0; i < length; i++) {
    const diff = compareIdentifier(leftPrerelease[i], rightPrerelease[i])
    if (diff !== 0) return diff
  }
  if (leftPrerelease.length !== rightPrerelease.length) {
    return leftPrerelease.length > rightPrerelease.length ? 1 : -1
  }
  return 0
}

// -1 / 0 / 1 like a comparator: positive when `left` is newer than `right`.
export function compareVersions(left: string, right: string): number {
  const leftVersion = parseForCompare(left)
  const rightVersion = parseForCompare(right)

  const coreDiff = compareCores(leftVersion.core, rightVersion.core)
  if (coreDiff !== 0) return coreDiff

  const leftHasPrerelease = leftVersion.prerelease.length > 0
  const rightHasPrerelease = rightVersion.prerelease.length > 0
  if (leftHasPrerelease !== rightHasPrerelease) return leftHasPrerelease ? -1 : 1
  if (!leftHasPrerelease) return 0

  return comparePrereleases(leftVersion.prerelease, rightVersion.prerelease)
}
