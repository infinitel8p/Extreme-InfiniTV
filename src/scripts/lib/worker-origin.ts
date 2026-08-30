// Defense-in-depth postMessage origin check for dedicated Web Workers.

export function isTrustedWorkerMessage(event: MessageEvent): boolean {
  // Dedicated-worker delivery from its own owner reports an empty origin.
  return event.origin === "" || event.origin === self.location.origin
}
