// Ambient global types for browser-side code that touches Tauri runtime
// internals, the spatial-navigation polyfill, and Android intent bridges.

interface AndroidPipBridge {
  isSupported?: () => boolean
  isInPip?: () => boolean
  enter?: () => void
  expand?: () => void
  toggle?: () => void
  setAutoEnter?: (enabled: boolean) => void
}

interface AndroidVideoBridge {
  isSupported?: () => boolean
  launchVod?: (
    contentKey: string,
    url: string,
    ua: string,
    referer: string,
    title: string,
    posterUrl: string,
    startMs: number,
  ) => boolean
  launchLive?: (
    contentKey: string,
    channelsJson: string,
    initialChannelId: string,
    ua: string,
    referer: string,
  ) => boolean
  drainEvents?: () => string
}

interface AndroidIntentBridge {
  isVlcInstalled?: () => boolean
  isMxPlayerInstalled?: () => boolean
  viewStream?: (
    url: string,
    mime: string,
    userAgent: string,
    referer: string,
    title: string,
  ) => boolean
  openInVlc?: (
    url: string,
    mime: string,
    userAgent: string,
    referer: string,
    title: string,
  ) => boolean
  /** Returns a JSON-encoded array of {pkg, label, activity}. */
  listVideoPlayerApps?: (url: string, mime: string) => string
  openInPackage?: (
    pkg: string,
    activity: string,
    url: string,
    mime: string,
    userAgent: string,
    referer: string,
    title: string,
  ) => boolean
}

interface AndroidSnifferBridge {
  startSniff?: (pageUrl: string, timeoutMs: number) => void
  cancelSniff?: () => void
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
    AndroidIntent?: AndroidIntentBridge
    AndroidVideo?: AndroidVideoBridge
    AndroidSniffer?: AndroidSnifferBridge
    /** Called from MainActivity on PiP enter to promote the playing video into HTML5 fullscreen. */
    __xtPipFullscreen?: () => void
    /** Called from MainActivity on PiP exit; undoes __xtPipFullscreen if it succeeded. */
    __xtPipExitFullscreen?: () => void
  }
}

export {}
