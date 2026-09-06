// Pure single-pass top-K selection: keeps a k-sized sorted buffer instead of sorting the
// whole input, so picking the top 20 out of a 20k-row catalog stays close to O(n) instead
// of O(n log n). `compare` uses Array.prototype.sort semantics: negative means `a` ranks
// ahead of `b`. Returned items are sorted best-first.
export function selectTopK<T>(items: T[], k: number, compare: (a: T, b: T) => number): T[] {
  if (k <= 0) return []
  const top: T[] = []
  for (const item of items) {
    if (top.length === k && compare(item, top[top.length - 1]) >= 0) continue
    let insertAt = top.length
    while (insertAt > 0 && compare(item, top[insertAt - 1]) < 0) insertAt--
    top.splice(insertAt, 0, item)
    if (top.length > k) top.pop()
  }
  return top
}
