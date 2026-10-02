const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

export interface TimelineProgramme {
  start: number
  stop: number
}

export interface TimelineCell<T extends TimelineProgramme = TimelineProgramme> {
  programme: T
  start: number
  stop: number
  x: number
  width: number
  clippedLeft: boolean
  clippedRight: boolean
}

export interface RulerTick {
  ts: number
  x: number
  isMidnight: boolean
}

export interface TimelineWindow {
  fromX: number
  toX: number
  fromTs: number
  toTs: number
}

export interface TimelineOptions {
  railStart: number
  railEnd: number
  pxPerHour: number
  startOfDay?: (ts: number) => number
  minCellWidth?: number
}

export function localStartOfDay(ts: number): number {
  const day = new Date(ts)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

export function createTimeline(options: TimelineOptions) {
  const { railStart, railEnd, pxPerHour } = options
  const startOfDay = options.startOfDay ?? localStartOfDay
  const minCellWidth = options.minCellWidth ?? 2
  const pxPerMs = pxPerHour / HOUR_MS
  const width = (railEnd - railStart) * pxPerMs

  const timeToX = (ts: number) => (ts - railStart) * pxPerMs
  const xToTime = (x: number) => railStart + x / pxPerMs

  const clampScroll = (scrollLeft: number, viewportWidth: number) =>
    Math.max(0, Math.min(Math.max(0, width - viewportWidth), scrollLeft))

  const visibleWindow = (
    scrollLeft: number,
    viewportWidth: number,
    overscanPx = 0
  ): TimelineWindow => {
    const fromX = Math.max(0, scrollLeft - overscanPx)
    const toX = Math.min(width, scrollLeft + viewportWidth + overscanPx)
    return { fromX, toX, fromTs: xToTime(fromX), toTs: xToTime(toX) }
  }

  const dayAt = (ts: number) => startOfDay(ts)

  const dayLabelForScroll = (scrollLeft: number, insetMs = HOUR_MS) => {
    const edge = xToTime(Math.max(0, Math.min(width, scrollLeft))) + insetMs
    return startOfDay(Math.min(edge, railEnd - 1))
  }

  const rulerTicks = (fromTs: number, toTs: number, stepMinutes: number): RulerTick[] => {
    const stepMs = stepMinutes * MINUTE_MS
    const from = Math.max(fromTs, railStart)
    const to = Math.min(toTs, railEnd)
    const ticks: RulerTick[] = []
    const firstIndex = Math.ceil((from - railStart) / stepMs)
    for (let ts = railStart + firstIndex * stepMs; ts <= to; ts += stepMs) {
      ticks.push({ ts, x: timeToX(ts), isMidnight: startOfDay(ts) === ts })
    }
    return ticks
  }

  const programmeCellsInWindow = <T extends TimelineProgramme>(
    programmes: readonly T[],
    fromTs: number,
    toTs: number
  ): TimelineCell<T>[] => {
    const cells: TimelineCell<T>[] = []
    for (const programme of programmes) {
      if (programme.stop <= fromTs || programme.start >= toTs) continue
      if (programme.stop <= railStart || programme.start >= railEnd) continue
      const x = timeToX(Math.max(programme.start, railStart))
      const right = timeToX(Math.min(programme.stop, railEnd))
      cells.push({
        programme,
        start: programme.start,
        stop: programme.stop,
        x,
        width: Math.max(minCellWidth, right - x),
        clippedLeft: programme.start < railStart,
        clippedRight: programme.stop > railEnd,
      })
    }
    return cells
  }

  return {
    railStart,
    railEnd,
    pxPerHour,
    width,
    timeToX,
    xToTime,
    clampScroll,
    visibleWindow,
    dayAt,
    dayLabelForScroll,
    rulerTicks,
    programmeCellsInWindow,
  }
}

export type EpgTimeline = ReturnType<typeof createTimeline>
