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

// -1 / 0 / 1 like a comparator: positive when `left` is newer than `right`.
export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let i = 0; i < length; i++) {
    const diff = (leftParts[i] || 0) - (rightParts[i] || 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}
