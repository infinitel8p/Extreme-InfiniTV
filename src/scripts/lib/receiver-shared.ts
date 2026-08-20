// Shared types + tiny formatters for the TV receiver mode (settings card + receiver screen).

export interface ReceiverPairedDevice {
  key: string
  deviceName: string
  createdAt: string
}

export interface ReceiverStatus {
  enabled: boolean
  port?: number
  ips: string[]
  name: string
  id?: string
  pairCode?: string
  pairCodeExpiresInSeconds?: number
  pairedDevices: ReceiverPairedDevice[]
}

export function formatReceiverAddress(ip: string, port?: number): string {
  return port ? `${ip}:${port}` : ip
}

export function formatReceiverPairCode(code: string | undefined): string {
  const value = code ?? ""
  return value.length === 6 ? `${value.slice(0, 3)} ${value.slice(3)}` : value
}

const IPV4_PATTERN = /^\d+\.\d+\.\d+\.\d+$/

function addressRank(ip: string): number {
  if (ip.startsWith("169.254.")) return 5
  if (ip.startsWith("192.168.")) return 0
  if (ip.startsWith("10.")) return 1
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
  if (IPV4_PATTERN.test(ip)) return 3
  return 4
}

export function rankReceiverIps(ips: string[]): string[] {
  return [...ips].sort((first, second) => addressRank(first) - addressRank(second))
}
