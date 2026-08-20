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
