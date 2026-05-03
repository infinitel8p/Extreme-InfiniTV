// Generic timing helpers.

export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  ms = 180
): (...args: Args) => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: Args) => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}
