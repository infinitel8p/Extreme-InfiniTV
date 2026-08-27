import { describe, it, expect } from "vitest"
import {
  TV_ROUTE_TABLE,
  CLASSIC_ROUTE_TABLE,
  TV_NAV_HREFS,
  normalizePathname,
  isTvPath,
  tvRouteFor,
  classicRouteFor,
  lookupRoute,
  tvNavActiveHref,
} from "../src/scripts/lib/tv-routes"

describe("normalizePathname", () => {
  it("collapses a single trailing slash", () => {
    expect(normalizePathname("/movies/")).toBe("/movies")
  })

  it("collapses multiple trailing slashes", () => {
    expect(normalizePathname("/movies///")).toBe("/movies")
  })

  it("keeps the root path as-is", () => {
    expect(normalizePathname("/")).toBe("/")
  })

  it("does not lowercase the pathname", () => {
    expect(normalizePathname("/Movies")).toBe("/Movies")
  })
})

describe("isTvPath", () => {
  it("matches the bare tv root", () => {
    expect(isTvPath("/tv")).toBe(true)
  })

  it("matches nested tv paths", () => {
    expect(isTvPath("/tv/movies/detail")).toBe(true)
  })

  it("rejects classic paths", () => {
    expect(isTvPath("/movies")).toBe(false)
  })

  it("rejects a path that merely starts with tv but is not a tv route", () => {
    expect(isTvPath("/tvguide")).toBe(false)
  })
})

describe("lookupRoute", () => {
  it("normalizes then does an exact lookup", () => {
    expect(lookupRoute(TV_ROUTE_TABLE, "/movies/")).toBe("/tv/movies")
  })

  it("returns null for a key not in the table", () => {
    expect(lookupRoute(TV_ROUTE_TABLE, "/docs")).toBeNull()
  })
})

describe("tvRouteFor", () => {
  it("maps every classic route to its tv twin", () => {
    for (const [classicPath, tvPath] of Object.entries(TV_ROUTE_TABLE)) {
      expect(tvRouteFor(classicPath)).toBe(tvPath)
    }
  })

  it("normalizes a trailing slash before lookup", () => {
    expect(tvRouteFor("/movies/")).toBe("/tv/movies")
  })

  it("preserves the query string for detail and search routes", () => {
    expect(tvRouteFor("/movies/detail", "?id=42")).toBe("/tv/movies/detail?id=42")
    expect(tvRouteFor("/series/detail", "id=7")).toBe("/tv/series/detail?id=7")
    expect(tvRouteFor("/search", "?q=news")).toBe("/tv/search?q=news")
  })

  it("drops the query string for routes that do not preserve it", () => {
    expect(tvRouteFor("/livetv", "?q=news")).toBe("/tv/live")
    expect(tvRouteFor("/", "?foo=bar")).toBe("/tv")
  })

  it("returns null for a path already under tv", () => {
    expect(tvRouteFor("/tv")).toBeNull()
    expect(tvRouteFor("/tv/movies")).toBeNull()
  })

  it("returns null for the receiver route", () => {
    expect(tvRouteFor("/receiver")).toBeNull()
  })

  it("returns null for an unknown path", () => {
    expect(tvRouteFor("/docs")).toBeNull()
  })
})

describe("classicRouteFor", () => {
  it("maps every tv route to its classic twin", () => {
    for (const [tvPath, classicPath] of Object.entries(CLASSIC_ROUTE_TABLE)) {
      expect(classicRouteFor(tvPath)).toBe(classicPath)
    }
  })

  it("normalizes a trailing slash before lookup", () => {
    expect(classicRouteFor("/tv/movies/")).toBe("/movies")
  })

  it("preserves the query string for detail and search routes", () => {
    expect(classicRouteFor("/tv/movies/detail", "?id=42")).toBe("/movies/detail?id=42")
    expect(classicRouteFor("/tv/series/detail", "id=7")).toBe("/series/detail?id=7")
    expect(classicRouteFor("/tv/search", "?q=news")).toBe("/search?q=news")
  })

  it("drops the query string for routes that do not preserve it", () => {
    expect(classicRouteFor("/tv/live", "?q=news")).toBe("/livetv")
  })

  it("falls back to the hub for an unknown tv path", () => {
    expect(classicRouteFor("/tv/whatever")).toBe("/")
  })

  it("returns null for a non-tv path", () => {
    expect(classicRouteFor("/movies")).toBeNull()
  })
})

describe("tvNavActiveHref", () => {
  it("matches every exact nav href", () => {
    for (const href of TV_NAV_HREFS) {
      expect(tvNavActiveHref(href)).toBe(href)
    }
  })

  it("maps a movies detail path to the movies nav href", () => {
    expect(tvNavActiveHref("/tv/movies/detail")).toBe("/tv/movies")
  })

  it("maps a series detail path to the series nav href", () => {
    expect(tvNavActiveHref("/tv/series/detail")).toBe("/tv/series")
  })

  it("normalizes a trailing slash before matching", () => {
    expect(tvNavActiveHref("/tv/live/")).toBe("/tv/live")
  })

  it("returns null for an unknown tv path", () => {
    expect(tvNavActiveHref("/tv/login")).toBeNull()
  })

  it("returns null for a non-tv path", () => {
    expect(tvNavActiveHref("/movies")).toBeNull()
  })
})

describe("route tables", () => {
  it("are plain string records that round-trip through JSON", () => {
    expect(JSON.parse(JSON.stringify(TV_ROUTE_TABLE))).toEqual(TV_ROUTE_TABLE)
    expect(JSON.parse(JSON.stringify(CLASSIC_ROUTE_TABLE))).toEqual(CLASSIC_ROUTE_TABLE)
  })
})
