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
  /** Starts pushing native-player events straight into the WebView instead of the SharedPreferences queue. */
  receiverSessionStart?: () => boolean
  /** Stops the event push and finishes the native player if it's still running. */
  receiverSessionEnd?: () => void
  /** Routes a remote control command into the running native player; returns whether a session was active. */
  receiverControl?: (action: string, positionMs: number) => boolean
  /** Applies a remote volume/mute change to the running native player; returns whether a session was active. */
  receiverVolume?: (level: number, muted: boolean) => boolean
  setKeepScreenOn?: (enabled: boolean) => void
  setTvOverscan?: (percent: number) => void
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

interface AndroidDeviceInfoBridge {
  isTv?: () => boolean
}

interface AndroidImeBridge {
  show?: () => void
  hide?: () => void
}

interface AndroidSnifferBridge {
  startSniff?: (pageUrl: string, timeoutMs: number) => void
  cancelSniff?: () => void
}

interface AndroidReceiverKeepAliveBridge {
  start?: (deviceName: string) => boolean
  stop?: () => boolean
}

interface AndroidLogBridge {
  shareNewestLog?: (logDirPath: string) => boolean
}

interface AndroidCastMediaBridge {
  update?: (
    title: string,
    deviceName: string,
    isPlaying: boolean,
    isLive: boolean,
    hasNext: boolean,
    hasPrev: boolean,
    artworkUrl: string,
  ) => void
  clear?: () => void
}

interface AndroidNsdBridge {
  isSupported?: () => boolean
  advertise?: (name: string, port: number, id?: string) => void
  stopAdvertise?: () => void
  /** "off" / "pending" / "registered" / "failed:<code>". */
  advertiseState?: () => string
  startDiscovery?: () => void
  stopDiscovery?: () => void
  /** Returns a JSON-encoded array of {name, host, port, id?, hosts?}. */
  drainDiscovered?: () => string
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
    AndroidDeviceInfo?: AndroidDeviceInfoBridge
    AndroidIme?: AndroidImeBridge
    AndroidPip?: AndroidPipBridge
    AndroidIntent?: AndroidIntentBridge
    AndroidVideo?: AndroidVideoBridge
    AndroidSniffer?: AndroidSnifferBridge
    AndroidNsd?: AndroidNsdBridge
    AndroidReceiverKeepAlive?: AndroidReceiverKeepAliveBridge
    AndroidCastMedia?: AndroidCastMediaBridge
    AndroidLog?: AndroidLogBridge
    /** Called from MainActivity on PiP enter to promote the playing video into HTML5 fullscreen. */
    __xtPipFullscreen?: () => void
    /** Called from MainActivity on PiP exit; undoes __xtPipFullscreen if it succeeded. */
    __xtPipExitFullscreen?: () => void
  }
}

export {}
