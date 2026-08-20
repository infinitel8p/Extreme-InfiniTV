import { describe, it, expect } from "vitest"
import { rankReceiverIps } from "../src/scripts/lib/receiver-shared"

describe("rankReceiverIps", () => {
  it("puts 192.168.x before 10.x before 172.16-31.x before public IPv4", () => {
    expect(rankReceiverIps(["8.8.8.8", "172.20.0.5", "10.0.0.5", "192.168.1.5"])).toEqual([
      "192.168.1.5",
      "10.0.0.5",
      "172.20.0.5",
      "8.8.8.8",
    ])
  })

  it("puts 169.254.x link-local addresses last", () => {
    expect(rankReceiverIps(["169.254.1.1", "192.168.1.5", "8.8.8.8"])).toEqual([
      "192.168.1.5",
      "8.8.8.8",
      "169.254.1.1",
    ])
  })

  it("treats 172.32.x as public, not private", () => {
    expect(rankReceiverIps(["172.32.0.5", "172.16.0.5"])).toEqual(["172.16.0.5", "172.32.0.5"])
  })

  it("preserves the original order within the same rank", () => {
    expect(rankReceiverIps(["192.168.1.10", "192.168.1.2", "192.168.1.5"])).toEqual([
      "192.168.1.10",
      "192.168.1.2",
      "192.168.1.5",
    ])
  })

  it("returns an empty array for an empty input", () => {
    expect(rankReceiverIps([])).toEqual([])
  })

  it("does not mutate the input array", () => {
    const ips = ["8.8.8.8", "192.168.1.5"]
    rankReceiverIps(ips)
    expect(ips).toEqual(["8.8.8.8", "192.168.1.5"])
  })
})
