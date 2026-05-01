// Ambient global types for browser-side code that touches Tauri runtime
// internals, the spatial-navigation polyfill, and Android intent bridges.

interface AndroidPipBridge {
  enter?: () => void
  exit?: () => void
}

interface SpatialNavigationApi {
  init: () => void
  uninit: () => void
  add: (config: Record<string, unknown>) => void
  remove: (sectionId: string) => void
  focus: (sectionId?: string) => boolean
  move: (direction: string) => boolean
  makeFocusable: (sectionId?: string) => void
  setDefaultSection: (sectionId: string) => void
  pause: () => void
  resume: () => void
  enable: (sectionId?: string) => void
  disable: (sectionId?: string) => void
  isFocusable: (element: Element, sectionId?: string) => boolean
  set: (sectionId: string, config: Record<string, unknown>) => void
}

declare global {
  interface Window {
    __TAURI__?: unknown
    __TAURI_INTERNALS__?: unknown
    SpatialNavigation?: SpatialNavigationApi
    AndroidPip?: AndroidPipBridge
  }
}

export {}
