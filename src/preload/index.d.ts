import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      onOpenSettings: (callback: () => void) => () => void
      onMenuAction: (callback: (action: 'open-image' | 'capture-adb') => void) => () => void
    }
  }
}
