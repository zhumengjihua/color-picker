import { ElectronAPI } from '@electron-toolkit/preload'

export interface AdbDownloadProgress {
  phase: 'manifest' | 'download' | 'verify' | 'extract'
  received?: number
  total?: number
}

export interface AdbPairingStatus {
  sessionId: string
  phase: 'waiting' | 'pairing' | 'connecting' | 'connected' | 'failed' | 'timeout'
  device?: string
  error?: string
}

export type MenuAction = 'open-image' | 'capture-adb' | 'connect-adb'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      getPathForFile: (file: File) => string | null
      onOpenSettings: (callback: () => void) => () => void
      onMenuAction: (callback: (action: MenuAction) => void) => () => void
      onAdbDownloadProgress: (callback: (progress: AdbDownloadProgress) => void) => () => void
      onAdbPairingStatus: (callback: (status: AdbPairingStatus) => void) => () => void
    }
  }
}
