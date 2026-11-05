import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const exportAllMock = vi.fn()
vi.mock("@/scripts/lib/backup.js", () => ({
  exportAll: (...args: unknown[]) => exportAllMock(...args),
  suggestedFilename: () => "backup.json",
}))

const platform = vi.hoisted(() => ({ tauri: false, android: false }))
vi.mock("@/scripts/lib/creds.js", () => ({
  get isTauri() {
    return platform.tauri
  },
}))

const saveJsonFileMock = vi.fn()
const savePublicJsonFileMock = vi.fn()
vi.mock("@/scripts/lib/android-fs.js", () => ({
  isAndroidFsActive: () => platform.android,
  saveJsonFile: (...args: unknown[]) => saveJsonFileMock(...args),
  savePublicJsonFile: (...args: unknown[]) => savePublicJsonFileMock(...args),
}))

const saveBackupSnapshotMock = vi.fn()
vi.mock("@/scripts/lib/backup-snapshot.ts", () => ({
  saveBackupSnapshot: (...args: unknown[]) => saveBackupSnapshotMock(...args),
}))

const toastSuccessMock = vi.fn()
const toastErrorMock = vi.fn()
vi.mock("@/scripts/lib/toast.js", () => ({
  toastSuccess: (...args: unknown[]) => toastSuccessMock(...args),
  toastError: (...args: unknown[]) => toastErrorMock(...args),
}))

vi.mock("@/scripts/lib/i18n.js", () => ({
  t: (key: string) => key,
}))

vi.mock("@/scripts/lib/log.js", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const snapshot = { creds: { entries: [{ _id: "a" }, { _id: "b" }] } }
const options = { logTag: "test" }

async function loadModule(target: "android" | "web") {
  vi.resetModules()
  platform.tauri = target === "android"
  platform.android = target === "android"
  return await import("@/scripts/lib/export-backup.ts")
}

beforeEach(() => {
  vi.clearAllMocks()
  exportAllMock.mockResolvedValue(snapshot)
  saveBackupSnapshotMock.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("exportBackupToFile: Android", () => {
  it("writes via SAF, refreshes the snapshot and reports the playlist count", async () => {
    saveJsonFileMock.mockResolvedValue(true)
    const { exportBackupToFile } = await loadModule("android")

    const outcome = await exportBackupToFile(options)

    expect(outcome).toEqual({ cancelled: false, savedTo: "", playlistCount: 2 })
    expect(saveJsonFileMock).toHaveBeenCalledWith("backup.json", JSON.stringify(snapshot, null, 2))
    expect(savePublicJsonFileMock).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(saveBackupSnapshotMock).toHaveBeenCalledTimes(1))
  })

  it("reports cancelled and skips the snapshot when the picker is dismissed", async () => {
    saveJsonFileMock.mockResolvedValue(false)
    const { exportBackupToFile } = await loadModule("android")

    const outcome = await exportBackupToFile(options)

    expect(outcome).toEqual({ cancelled: true, savedTo: "", playlistCount: 2 })
    expect(saveBackupSnapshotMock).not.toHaveBeenCalled()
  })

  it("falls back to the public Download path when SAF throws", async () => {
    saveJsonFileMock.mockRejectedValue(new Error("picker failed"))
    savePublicJsonFileMock.mockResolvedValue("/storage/Download/backup.json")
    const { exportBackupToFile } = await loadModule("android")

    const outcome = await exportBackupToFile(options)

    expect(outcome).toEqual({
      cancelled: false,
      savedTo: "/storage/Download/backup.json",
      playlistCount: 2,
    })
    await vi.waitFor(() => expect(saveBackupSnapshotMock).toHaveBeenCalledTimes(1))
  })

  it("rejects when SAF throws and the public save returns null", async () => {
    saveJsonFileMock.mockRejectedValue(new Error("picker failed"))
    savePublicJsonFileMock.mockResolvedValue(null)
    const { exportBackupToFile } = await loadModule("android")

    await expect(exportBackupToFile(options)).rejects.toThrow("settings.toast.backupSaveUnavailable")
    expect(saveBackupSnapshotMock).not.toHaveBeenCalled()
  })

  it("still succeeds when the snapshot refresh fails", async () => {
    saveJsonFileMock.mockResolvedValue(true)
    saveBackupSnapshotMock.mockRejectedValue(new Error("disk full"))
    const { exportBackupToFile } = await loadModule("android")

    const outcome = await exportBackupToFile(options)

    expect(outcome.cancelled).toBe(false)
    await vi.waitFor(() => expect(saveBackupSnapshotMock).toHaveBeenCalledTimes(1))
  })
})

describe("exportBackupWithToasts", () => {
  it("shows a success toast and returns true", async () => {
    saveJsonFileMock.mockResolvedValue(true)
    const { exportBackupWithToasts } = await loadModule("android")

    expect(await exportBackupWithToasts(options)).toBe(true)
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "settings.toast.backupExported",
      expect.objectContaining({ description: "2 playlist(s)." })
    )
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it("includes the saved path in the toast description on fallback", async () => {
    saveJsonFileMock.mockRejectedValue(new Error("picker failed"))
    savePublicJsonFileMock.mockResolvedValue("/storage/Download/backup.json")
    const { exportBackupWithToasts } = await loadModule("android")

    expect(await exportBackupWithToasts(options)).toBe(true)
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "settings.toast.backupExported",
      expect.objectContaining({ description: "2 playlist(s) - /storage/Download/backup.json" })
    )
  })

  it("returns false with no toast when cancelled", async () => {
    saveJsonFileMock.mockResolvedValue(false)
    const { exportBackupWithToasts } = await loadModule("android")

    expect(await exportBackupWithToasts(options)).toBe(false)
    expect(toastSuccessMock).not.toHaveBeenCalled()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it("shows an error toast and returns false when every save path fails", async () => {
    saveJsonFileMock.mockRejectedValue(new Error("picker failed"))
    savePublicJsonFileMock.mockResolvedValue(null)
    const { exportBackupWithToasts } = await loadModule("android")

    expect(await exportBackupWithToasts(options)).toBe(false)
    expect(toastErrorMock).toHaveBeenCalledWith(
      "settings.toast.backupExportFail",
      expect.objectContaining({ description: "settings.toast.backupSaveUnavailable" })
    )
    expect(toastSuccessMock).not.toHaveBeenCalled()
  })
})

describe("exportBackupToFile: web", () => {
  it("triggers a blob download through an anchor click", async () => {
    const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() }
    const appendChild = vi.fn()
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
      body: { appendChild },
    })
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake")
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
    const { exportBackupToFile } = await loadModule("web")

    const outcome = await exportBackupToFile(options)

    expect(outcome).toEqual({ cancelled: false, savedTo: "", playlistCount: 2 })
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(anchor.href).toBe("blob:fake")
    expect(anchor.download).toBe("backup.json")
    expect(appendChild).toHaveBeenCalledWith(anchor)
    expect(anchor.click).toHaveBeenCalledTimes(1)
    expect(saveJsonFileMock).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(saveBackupSnapshotMock).toHaveBeenCalledTimes(1))
  })
})
