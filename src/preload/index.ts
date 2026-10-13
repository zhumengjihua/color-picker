import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { AdbDownloadProgress } from '../main/adb'
import type { AdbPairingStatus } from '../main/adb-wireless'

type MenuAction = 'open-image' | 'capture-adb' | 'connect-adb'

// Custom APIs for renderer
const api = {
  // Electron 32 起 File 对象不再带 path 属性，需通过 webUtils 获取拖入文件的本地路径；
  // 剪贴板粘贴的图片没有路径，返回 null
  getPathForFile: (file: File): string | null => {
    try {
      return webUtils.getPathForFile(file) || null
    } catch {
      return null
    }
  },
  onOpenSettings: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('open-settings', listener)
    return () => ipcRenderer.removeListener('open-settings', listener)
  },
  onMenuAction: (callback: (action: MenuAction) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: MenuAction): void =>
      callback(action)
    ipcRenderer.on('menu-action', listener)
    return () => ipcRenderer.removeListener('menu-action', listener)
  },
  onAdbDownloadProgress: (callback: (progress: AdbDownloadProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: AdbDownloadProgress): void =>
      callback(progress)
    ipcRenderer.on('adb-download-progress', listener)
    return () => ipcRenderer.removeListener('adb-download-progress', listener)
  },
  onAdbPairingStatus: (callback: (status: AdbPairingStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: AdbPairingStatus): void =>
      callback(status)
    ipcRenderer.on('adb-pairing-status', listener)
    return () => ipcRenderer.removeListener('adb-pairing-status', listener)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
