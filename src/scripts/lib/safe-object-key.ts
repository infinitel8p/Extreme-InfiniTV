const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

export function isSafeObjectKey(key: unknown): key is string {
  return typeof key === "string" && key !== "" && !UNSAFE_KEYS.has(key)
}
