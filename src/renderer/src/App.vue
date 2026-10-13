<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { locales, setLocale, type AppLocale } from './i18n'
import AdbConnectDialog from './components/AdbConnectDialog.vue'

interface ImageTab {
  id: string
  name: string
  url: string
  width: number
  height: number
  size: number
  canvas: HTMLCanvasElement | null
  ctx: CanvasRenderingContext2D | null
  path: string | null
}

const tabs = ref<ImageTab[]>([])
const activeTabId = ref<string | null>(null)
const colorFormat = ref<'hex' | 'rgb'>('hex')

const { t, locale } = useI18n()
const selectedLocale = computed({
  get: () => locale.value,
  set: (value: string) => {
    if (locales.some(({ code }) => code === value)) {
      setLocale(value as AppLocale)
      void window.electron?.ipcRenderer.invoke('set-app-locale', value)
    }
  }
})
const settingsVisible = ref(false)
// macOS 的设置入口在应用菜单；Windows / Linux 的菜单栏默认隐藏，在工具栏提供设置按钮
const isMac = window.electron?.process?.platform === 'darwin'
const pickerHintOpen = ref(false)

/* 侧栏宽度：拖动左边缘调整，记住在本机 */
const SIDEBAR_WIDTH_STORAGE_KEY = 'color-picker.sidebarWidth'
const SIDEBAR_DEFAULT_WIDTH = 300
const SIDEBAR_MIN_WIDTH = 240
const SIDEBAR_MAX_WIDTH = 560
// 截图区至少保留的宽度
const WORKSPACE_MIN_WIDTH = 320

const clampSidebarWidth = (width: number): number => {
  const max = Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, window.innerWidth - WORKSPACE_MIN_WIDTH)
  )
  return Math.round(Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, width)))
}

const loadSidebarWidth = (): number => {
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
    return saved ? clampSidebarWidth(saved) : SIDEBAR_DEFAULT_WIDTH
  } catch {
    return SIDEBAR_DEFAULT_WIDTH
  }
}

const sidebarWidth = ref(loadSidebarWidth())
const isResizingSidebar = ref(false)

watch(sidebarWidth, (width) => {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width))
  } catch {
    // 存储不可用时只影响下次启动的宽度
  }
})

const startSidebarResize = (event: PointerEvent): void => {
  if (event.button !== 0) return
  event.preventDefault()
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture(event.pointerId)
  isResizingSidebar.value = true
  const startX = event.clientX
  const startWidth = sidebarWidth.value

  // 侧栏在右侧，手柄向左拖动时变宽
  const handleMove = (moveEvent: PointerEvent): void => {
    sidebarWidth.value = clampSidebarWidth(startWidth + startX - moveEvent.clientX)
  }
  const handleEnd = (): void => {
    isResizingSidebar.value = false
    handle.removeEventListener('pointermove', handleMove)
    handle.removeEventListener('pointerup', handleEnd)
    handle.removeEventListener('pointercancel', handleEnd)
  }
  handle.addEventListener('pointermove', handleMove)
  handle.addEventListener('pointerup', handleEnd)
  handle.addEventListener('pointercancel', handleEnd)
}

const handleSidebarResizerKey = (event: KeyboardEvent): void => {
  const step = event.shiftKey ? 40 : 10
  if (event.key === 'ArrowLeft') sidebarWidth.value = clampSidebarWidth(sidebarWidth.value + step)
  else if (event.key === 'ArrowRight') {
    sidebarWidth.value = clampSidebarWidth(sidebarWidth.value - step)
  } else return
  // 阻止全局方向键逐像素移动
  event.preventDefault()
  event.stopPropagation()
}

const resetSidebarWidth = (): void => {
  sidebarWidth.value = clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH)
}

const handleWindowResize = (): void => {
  sidebarWidth.value = clampSidebarWidth(sidebarWidth.value)
}
let removeSettingsListener: (() => void) | undefined
let removeMenuActionListener: (() => void) | undefined

// Mouse state
const mouseX = ref<number | null>(null)
const mouseY = ref<number | null>(null)
const mouseColorHex = ref<string>('#ffffffff')
const mouseColorRgba = ref<string>('rgba(255, 255, 255, 1.000)')

const fileInputRef = ref<HTMLInputElement | null>(null)
const imageRef = ref<HTMLImageElement | null>(null)
const viewportRef = ref<HTMLElement | null>(null)
const lastWarpTime = ref<number>(0)
const lastWarpX = ref<number | null>(null)
const lastWarpY = ref<number | null>(null)

const cursorX = ref<number | null>(null)
const cursorY = ref<number | null>(null)
const loupeCanvasRef = ref<HTMLCanvasElement | null>(null)

const updateLoupe = (x: number, y: number, tab: ImageTab): void => {
  if (!loupeCanvasRef.value || !tab.canvas) return
  const loupeCtx = loupeCanvasRef.value.getContext('2d')
  if (!loupeCtx) return

  const size = 11
  const half = Math.floor(size / 2)
  const sx = x - half
  const sy = y - half

  loupeCtx.clearRect(0, 0, 110, 110)
  loupeCtx.imageSmoothingEnabled = false
  loupeCtx.drawImage(tab.canvas, sx, sy, size, size, 0, 0, 110, 110)

  loupeCtx.lineWidth = 1
  // 中灰网格线在亮色和暗色像素上都能看清
  loupeCtx.strokeStyle = 'rgba(128, 128, 128, 0.45)'
  for (let i = 0; i <= size; i++) {
    loupeCtx.beginPath()
    loupeCtx.moveTo(i * 10, 0)
    loupeCtx.lineTo(i * 10, 110)
    loupeCtx.stroke()

    loupeCtx.beginPath()
    loupeCtx.moveTo(0, i * 10)
    loupeCtx.lineTo(110, i * 10)
    loupeCtx.stroke()
  }
}

// 放大镜尺寸：110px 画布，下方坐标标签约 24px，距光标 15px
const LOUPE_OFFSET = 15
const LOUPE_WIDTH = 110
const LOUPE_HEIGHT = 110 + 24

const loupeStyle = computed(() => {
  if (cursorX.value === null || cursorY.value === null) return { display: 'none' }
  let left = cursorX.value + LOUPE_OFFSET
  let top = cursorY.value + LOUPE_OFFSET
  if (imageRef.value && viewportRef.value) {
    // 以截图区的可见范围（不含滚动条）判断，靠近右侧或底部时翻到光标另一侧
    const imageRect = imageRef.value.getBoundingClientRect()
    const viewportRect = viewportRef.value.getBoundingClientRect()
    const visibleRight = viewportRect.left + viewportRef.value.clientWidth
    const visibleBottom = viewportRect.top + viewportRef.value.clientHeight
    const cursorClientX = imageRect.left + cursorX.value
    const cursorClientY = imageRect.top + cursorY.value
    if (cursorClientX + LOUPE_OFFSET + LOUPE_WIDTH > visibleRight) {
      left = cursorX.value - LOUPE_OFFSET - LOUPE_WIDTH
    }
    if (cursorClientY + LOUPE_OFFSET + LOUPE_HEIGHT > visibleBottom) {
      top = cursorY.value - LOUPE_OFFSET - LOUPE_HEIGHT
    }
  }
  return {
    left: `${left}px`,
    top: `${top}px`,
    display: 'block'
  }
})

const logToMain = (msg: string): void => {
  if (window.electron && window.electron.ipcRenderer) {
    window.electron.ipcRenderer.send('log-message', `[Renderer] ${msg}`)
  }
}

interface RecordSlot {
  index: number
  x: number | null
  y: number | null
  hex: string | null
  rgba: string | null
}

const records = ref<RecordSlot[]>(
  Array.from({ length: 10 }, (_, i) => ({
    index: i + 1,
    x: null,
    y: null,
    hex: null,
    rgba: null
  }))
)

const filledCount = computed(() => records.value.filter((r) => r.x !== null).length)

const addRecord = (x: number, y: number, hex: string, rgba: string): void => {
  const emptySlot = records.value.find((r) => r.x === null)
  if (emptySlot) {
    emptySlot.x = x
    emptySlot.y = y
    emptySlot.hex = hex
    emptySlot.rgba = rgba
  }
}

const clearSlot = (index: number): void => {
  const slot = records.value.find((r) => r.index === index)
  if (slot) {
    slot.x = null
    slot.y = null
    slot.hex = null
    slot.rgba = null
  }
}

const clearAllRecords = (): void => {
  records.value.forEach((slot) => {
    slot.x = null
    slot.y = null
    slot.hex = null
    slot.rgba = null
  })
}

const activeTab = computed(() => {
  return tabs.value.find((tab) => tab.id === activeTabId.value) || null
})

const formatSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

const formatFilename = (name: string | undefined, maxLength = 22): string => {
  if (!name) return '-'
  if (name.length <= maxLength) return name
  const keep = Math.floor((maxLength - 3) / 2)
  return name.substring(0, keep) + '...' + name.substring(name.length - keep)
}

const addImages = (files: File[] | FileList): void => {
  Array.from(files).forEach((file) => {
    if (!file.type.startsWith('image/')) return

    const id = Math.random().toString(36).substring(2, 9)
    const url = URL.createObjectURL(file)

    const img = new Image()
    img.src = url
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(img, 0, 0)
      }

      const name =
        file.name && file.name !== 'image.png'
          ? file.name
          : `Pasted Image (${new Date().toLocaleTimeString()})`

      const newTab: ImageTab = {
        id,
        name,
        url,
        width: img.naturalWidth,
        height: img.naturalHeight,
        size: file.size || 0,
        canvas,
        ctx,
        path: window.api?.getPathForFile(file) ?? null
      }

      tabs.value.push(newTab)
      activeTabId.value = id
    }
  })
}

interface NativeImageFile {
  path: string
  name: string
  size: number
  dataUrl: string
}

const addNativeImages = (files: NativeImageFile[]): void => {
  files.forEach((file) => {
    const id = Math.random().toString(36).substring(2, 9)

    const img = new Image()
    img.src = file.dataUrl
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(img, 0, 0)
      }

      const newTab: ImageTab = {
        id,
        name: file.name,
        url: file.dataUrl,
        width: img.naturalWidth,
        height: img.naturalHeight,
        size: file.size,
        canvas,
        ctx,
        path: file.path
      }

      tabs.value.push(newTab)
      activeTabId.value = id
    }
  })
}

const triggerFilePicker = async (): Promise<void> => {
  if (window.electron && window.electron.ipcRenderer) {
    try {
      const files = await window.electron.ipcRenderer.invoke('show-open-dialog')
      if (files && files.length > 0) {
        addNativeImages(files)
      }
    } catch (err) {
      console.error('Failed to show open dialog:', err)
    }
  } else {
    // Browser fallback
    if (fileInputRef.value) {
      fileInputRef.value.click()
    }
  }
}

interface AdbDevice {
  serial: string
  state: string
  model: string | null
  wireless: boolean
}

const ADB_DEVICE_STORAGE_KEY = 'color-picker.adbDevice'
const loadSavedAdbSerial = (): string => {
  try {
    return localStorage.getItem(ADB_DEVICE_STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

const adbDevices = ref<AdbDevice[]>([])
const selectedAdbSerial = ref(loadSavedAdbSerial())
const connectDialogVisible = ref(false)

watch(selectedAdbSerial, (serial) => {
  try {
    if (serial) localStorage.setItem(ADB_DEVICE_STORAGE_KEY, serial)
  } catch {
    // 存储不可用时只影响下次启动的默认选择
  }
})

const selectedAdbDeviceStatus = computed(() => {
  const device = adbDevices.value.find((item) => item.serial === selectedAdbSerial.value)
  if (!device) return ''
  return device.state === 'device' ? 'online' : 'warn'
})

const adbDeviceLabel = (device: AdbDevice): string => {
  const name = device.model || device.serial
  const parts = [device.wireless ? `${name} (${t('app.deviceWireless')})` : name]
  if (device.state === 'unauthorized') parts.push(t('app.deviceUnauthorized'))
  else if (device.state !== 'device') parts.push(device.state)
  return parts.join(' · ')
}

const refreshAdbDevices = async (): Promise<void> => {
  if (!window.electron?.ipcRenderer) return
  try {
    const result = await window.electron.ipcRenderer.invoke('adb-list-devices')
    adbDevices.value = result?.success ? result.devices : []
  } catch {
    adbDevices.value = []
  }
  const devices = adbDevices.value
  if (!devices.some((device) => device.serial === selectedAdbSerial.value)) {
    // 原选择已断开时，优先选可用设备
    const preferred = devices.find((device) => device.state === 'device') ?? devices[0]
    selectedAdbSerial.value = preferred?.serial ?? ''
  }
}

const openConnectDialog = (): void => {
  connectDialogVisible.value = true
}

const handleAdbConnected = async (serial: string): Promise<void> => {
  connectDialogVisible.value = false
  selectedAdbSerial.value = serial
  await refreshAdbDevices()
}

const handleConnectAdbMissing = (): void => {
  connectDialogVisible.value = false
  openAdbDownload(false)
}

const isCapturingAdb = ref(false)

const triggerAdbCapture = async (): Promise<void> => {
  if (isCapturingAdb.value) return
  isCapturingAdb.value = true

  if (window.electron && window.electron.ipcRenderer) {
    try {
      // 截图前刷新设备列表，避免使用已断开的设备
      await refreshAdbDevices()
      const result = await window.electron.ipcRenderer.invoke(
        'capture-adb-screen',
        selectedAdbSerial.value || undefined
      )
      if (result && result.success) {
        addNativeImages([
          {
            path: result.path || 'adb-screenshot-' + Date.now() + '.png',
            name: result.name || t('app.screenshotName', { time: new Date().toLocaleTimeString() }),
            size: result.size,
            dataUrl: result.dataUrl
          }
        ])
      } else if (result?.code === 'ADB_NOT_FOUND') {
        openAdbDownload(true)
      } else {
        alert(t('app.failedAdb') + (result?.error || t('app.adbEnsure')))
      }
    } catch (err) {
      console.error('Failed to capture adb screen:', err)
      alert(t('app.operationFailed') + (err as Error).message)
    }
  } else {
    alert(t('app.onlyClient'))
  }
  isCapturingAdb.value = false
}

type AdbDownloadProgress = Parameters<Parameters<Window['api']['onAdbDownloadProgress']>[0]>[0]
type AdbSource = 'custom' | 'env' | 'path' | 'android-studio' | 'homebrew' | 'downloaded'

interface AdbPathResult {
  canceled?: boolean
  success?: boolean
  status?: AdbStatus
  error?: string
}

interface AdbStatus {
  location: { path: string; source: AdbSource } | null
  version: string | null
  customPath: string | null
  customPathValid: boolean
  downloadedPath: string | null
}

const ADB_LICENSE_URL = 'https://developer.android.com/studio/terms'
const adbSourceLabelKeys: Record<AdbSource, string> = {
  custom: 'app.adbSourceCustom',
  env: 'app.adbSourceEnv',
  path: 'app.adbSourcePath',
  'android-studio': 'app.adbSourceAndroidStudio',
  homebrew: 'app.adbSourceHomebrew',
  downloaded: 'app.adbSourceDownloaded'
}

const adbStatus = ref<AdbStatus | null>(null)
const adbStatusLoading = ref(false)
const adbSettingsError = ref('')
const adbDownloadVisible = ref(false)
const adbDownloadForCapture = ref(false)
const adbDownloading = ref(false)
const adbDownloadProgress = ref<AdbDownloadProgress | null>(null)
const adbDownloadError = ref('')
let removeAdbProgressListener: (() => void) | undefined

const refreshAdbStatus = async (refresh = false): Promise<void> => {
  if (!window.electron?.ipcRenderer) return
  adbStatusLoading.value = true
  adbSettingsError.value = ''
  try {
    adbStatus.value = await window.electron.ipcRenderer.invoke('adb-get-status', refresh)
  } catch (err) {
    adbSettingsError.value = t('app.operationFailed') + (err as Error).message
  } finally {
    adbStatusLoading.value = false
  }
}

const handleAdbPathResult = (result: AdbPathResult | null | undefined): void => {
  if (!result || result.canceled) return
  if (result.success) {
    adbStatus.value = result.status ?? null
    adbSettingsError.value = ''
  } else {
    adbSettingsError.value =
      result.error === 'INVALID_PATH'
        ? t('app.adbInvalidPath')
        : result.error || t('app.unknownErr')
  }
}

const chooseAdbPath = async (): Promise<void> => {
  if (!window.electron?.ipcRenderer) return
  try {
    handleAdbPathResult(await window.electron.ipcRenderer.invoke('adb-choose-custom-path'))
  } catch (err) {
    adbSettingsError.value = t('app.operationFailed') + (err as Error).message
  }
}

const clearAdbPath = async (): Promise<void> => {
  if (!window.electron?.ipcRenderer) return
  try {
    handleAdbPathResult(await window.electron.ipcRenderer.invoke('adb-set-custom-path', null))
  } catch (err) {
    adbSettingsError.value = t('app.operationFailed') + (err as Error).message
  }
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const adbDownloadPercent = computed(() => {
  const progress = adbDownloadProgress.value
  if (progress?.phase !== 'download' || !progress.total) return null
  return Math.min(100, Math.round(((progress.received ?? 0) / progress.total) * 100))
})

const adbDownloadPhaseText = computed(() => {
  const progress = adbDownloadProgress.value
  if (!progress || progress.phase === 'manifest') return t('app.adbPhaseManifest')
  if (progress.phase === 'verify') return t('app.adbPhaseVerify')
  if (progress.phase === 'extract') return t('app.adbPhaseExtract')
  const received = formatBytes(progress.received ?? 0)
  return progress.total
    ? t('app.adbPhaseDownload', { received, total: formatBytes(progress.total) })
    : t('app.adbPhaseDownloadUnknown', { received })
})

const openAdbDownload = (forCapture: boolean): void => {
  adbDownloadForCapture.value = forCapture
  adbDownloadError.value = ''
  adbDownloadProgress.value = null
  adbDownloadVisible.value = true
}

const closeAdbDownload = (): void => {
  if (adbDownloading.value) return
  adbDownloadVisible.value = false
  adbDownloadForCapture.value = false
}

const startAdbDownload = async (): Promise<void> => {
  if (adbDownloading.value || !window.electron?.ipcRenderer) return
  adbDownloading.value = true
  adbDownloadError.value = ''
  adbDownloadProgress.value = null
  try {
    const result = await window.electron.ipcRenderer.invoke('adb-download')
    if (result?.success) {
      adbDownloadVisible.value = false
      if (settingsVisible.value) void refreshAdbStatus()
      void refreshAdbDevices()
      if (adbDownloadForCapture.value) {
        adbDownloadForCapture.value = false
        void triggerAdbCapture()
      }
    } else {
      adbDownloadError.value = result?.error || t('app.unknownErr')
    }
  } catch (err) {
    adbDownloadError.value = (err as Error).message
  } finally {
    adbDownloading.value = false
  }
}

watch(settingsVisible, (visible) => {
  if (visible) void refreshAdbStatus()
})

const handleFileOpen = (event: Event): void => {
  const target = event.target as HTMLInputElement
  if (target.files && target.files.length > 0) {
    addImages(target.files)
    target.value = ''
  }
}

const handleDragOver = (e: DragEvent): void => {
  e.preventDefault()
}

const handleDrop = (e: DragEvent): void => {
  e.preventDefault()
  const files = e.dataTransfer?.files
  if (files && files.length > 0) {
    addImages(Array.from(files))
  }
}

const handlePaste = (e: ClipboardEvent): void => {
  const items = e.clipboardData?.items
  if (!items) return
  const files: File[] = []
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) {
        files.push(file)
      }
    }
  }
  if (files.length > 0) {
    addImages(files)
  }
}

const handleMouseMove = (event: MouseEvent): void => {
  const tab = activeTab.value
  if (!tab || !tab.ctx) return

  const imgElement = event.target as HTMLImageElement
  const rect = imgElement.getBoundingClientRect()

  // Calculate relative coordinate based on image rendering natural dimensions
  const scaleX = tab.width / rect.width
  const scaleY = tab.height / rect.height

  const x = Math.floor((event.clientX - rect.left) * scaleX)
  const y = Math.floor((event.clientY - rect.top) * scaleY)
  cursorX.value = event.clientX - rect.left
  cursorY.value = event.clientY - rect.top

  // Guard: ignore mousemove events triggered as a side effect of warping
  if (
    Date.now() - lastWarpTime.value < 100 &&
    lastWarpX.value !== null &&
    lastWarpY.value !== null &&
    Math.abs(x - lastWarpX.value) <= 1 &&
    Math.abs(y - lastWarpY.value) <= 1
  ) {
    logToMain(
      `handleMouseMove GUARDED: x=${x}, y=${y}, targetX=${lastWarpX.value}, targetY=${lastWarpY.value}`
    )
    return
  }

  logToMain(
    `handleMouseMove: clientX=${event.clientX}, clientY=${event.clientY}, rectLeft=${rect.left}, rectTop=${rect.top}, x=${x}, y=${y}`
  )

  // Bounds check
  if (x >= 0 && x < tab.width && y >= 0 && y < tab.height) {
    try {
      const pixel = tab.ctx.getImageData(x, y, 1, 1).data
      const r = pixel[0]
      const g = pixel[1]
      const b = pixel[2]
      const a = pixel[3]

      const alphaVal = parseFloat((a / 255).toFixed(3))

      const hex = '#' + [r, g, b, a].map((v) => v.toString(16).padStart(2, '0')).join('')
      const rgba = `rgba(${r}, ${g}, ${b}, ${alphaVal})`

      mouseX.value = x
      mouseY.value = y
      mouseColorHex.value = hex
      mouseColorRgba.value = rgba

      updateLoupe(x, y, tab)
    } catch (err) {
      console.error(err)
    }
  }
}

const handleMouseLeave = (): void => {
  mouseX.value = null
  mouseY.value = null
  cursorX.value = null
  cursorY.value = null
}

const handleWindowFocus = async (): Promise<void> => {
  const tab = activeTab.value
  if (!tab || !tab.ctx || !imageRef.value) return

  if (window.electron && window.electron.ipcRenderer) {
    try {
      const pos = await window.electron.ipcRenderer.invoke('get-cursor-position')
      if (pos) {
        const rect = imageRef.value.getBoundingClientRect()
        // Check if the viewport coordinate pos.x, pos.y is inside the image bounds
        if (
          pos.x >= rect.left &&
          pos.x <= rect.right &&
          pos.y >= rect.top &&
          pos.y <= rect.bottom
        ) {
          // Calculate image relative pixel coordinates
          const scaleX = tab.width / rect.width
          const scaleY = tab.height / rect.height

          const x = Math.floor((pos.x - rect.left) * scaleX)
          const y = Math.floor((pos.y - rect.top) * scaleY)

          // Bounds check
          if (x >= 0 && x < tab.width && y >= 0 && y < tab.height) {
            const pixel = tab.ctx.getImageData(x, y, 1, 1).data
            const r = pixel[0]
            const g = pixel[1]
            const b = pixel[2]
            const a = pixel[3]
            const alphaVal = parseFloat((a / 255).toFixed(3))

            const hex = '#' + [r, g, b, a].map((v) => v.toString(16).padStart(2, '0')).join('')
            const rgba = `rgba(${r}, ${g}, ${b}, ${alphaVal})`

            mouseX.value = x
            mouseY.value = y
            mouseColorHex.value = hex
            mouseColorRgba.value = rgba
          }
        } else {
          // Mouse is outside the image bounds when focused
          mouseX.value = null
          mouseY.value = null
        }
      }
    } catch (err) {
      console.error('Failed to get cursor position on focus:', err)
    }
  }
}

watch(activeTabId, () => {
  nextTick(() => {
    handleWindowFocus()
  })
})

// Context Menu state
const contextMenuVisible = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextMenuTabId = ref<string | null>(null)

// Rename Modal state
const renameModalVisible = ref(false)
const renameTargetTabId = ref<string | null>(null)
const renameInputName = ref('')
const renameInputRef = ref<HTMLInputElement | null>(null)

const handleTabContextMenu = (tab: ImageTab, event: MouseEvent): void => {
  event.preventDefault()
  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  contextMenuTabId.value = tab.id
  contextMenuVisible.value = true

  // Listen for clicks to dismiss context menu
  const closeMenu = (): void => {
    contextMenuVisible.value = false
    window.removeEventListener('click', closeMenu)
  }
  setTimeout(() => {
    window.addEventListener('click', closeMenu)
  }, 0)
}

const closeCurrentTab = (): void => {
  if (contextMenuTabId.value) {
    closeTab(contextMenuTabId.value)
  }
  contextMenuVisible.value = false
}

const closeOtherTabs = (): void => {
  if (contextMenuTabId.value) {
    const keepId = contextMenuTabId.value
    // Revoke URL for other tabs
    tabs.value.forEach((tab) => {
      if (tab.id !== keepId) {
        URL.revokeObjectURL(tab.url)
      }
    })
    tabs.value = tabs.value.filter((tab) => tab.id === keepId)
    activeTabId.value = keepId
  }
  contextMenuVisible.value = false
}

const closeAllTabs = (): void => {
  tabs.value.forEach((tab) => {
    URL.revokeObjectURL(tab.url)
  })
  tabs.value = []
  activeTabId.value = null
  contextMenuVisible.value = false
}

const copyImage = async (): Promise<void> => {
  if (!contextMenuTabId.value) return
  const tab = tabs.value.find((t) => t.id === contextMenuTabId.value)
  if (!tab || !tab.canvas) return

  if (window.electron && window.electron.ipcRenderer) {
    const base64Data = tab.canvas.toDataURL('image/png')
    window.electron.ipcRenderer.send('copy-image-to-clipboard', base64Data)
    logToMain('Copied image to clipboard via IPC')
  }

  contextMenuVisible.value = false
}

const openRenameModal = (): void => {
  if (!contextMenuTabId.value) return
  const tab = tabs.value.find((t) => t.id === contextMenuTabId.value)
  if (tab) {
    renameTargetTabId.value = tab.id
    renameInputName.value = tab.name
    renameModalVisible.value = true
  }
  contextMenuVisible.value = false
}

const closeRenameModal = (): void => {
  renameModalVisible.value = false
  renameTargetTabId.value = null
  renameInputName.value = ''
}

const confirmRename = async (): Promise<void> => {
  if (!renameTargetTabId.value || !renameInputName.value.trim()) return
  const tab = tabs.value.find((t) => t.id === renameTargetTabId.value)
  if (!tab) return

  const newName = renameInputName.value.trim()

  if (tab.path) {
    // If it's a local file, rename the actual file on disk!
    if (window.electron && window.electron.ipcRenderer) {
      try {
        const result = await window.electron.ipcRenderer.invoke(
          'rename-file-on-disk',
          tab.path,
          newName
        )
        if (result && result.success) {
          tab.path = result.newPath
          const pathParts = result.newPath.replace(/\\/g, '/').split('/')
          tab.name = pathParts[pathParts.length - 1] || newName
          logToMain(`File successfully renamed on disk to: ${result.newPath}`)
        } else {
          alert(t('app.failedRename') + (result?.error || t('app.unknownErr')))
        }
      } catch (err) {
        console.error('Failed to rename file:', err)
        alert(t('app.operationFailed') + (err as Error).message)
      }
    } else {
      // Fallback
      tab.name = newName
    }
    closeRenameModal()
  } else {
    // If it has no path (pasted from clipboard), trigger native showSaveDialog
    if (window.electron && window.electron.ipcRenderer) {
      try {
        const filePath = await window.electron.ipcRenderer.invoke('show-save-dialog', newName)
        if (filePath) {
          // Get base64 representation of the canvas
          if (tab.canvas) {
            const base64Data = tab.canvas.toDataURL('image/png')
            const saveResult = await window.electron.ipcRenderer.invoke(
              'save-image-file',
              filePath,
              base64Data
            )
            if (saveResult && saveResult.success) {
              // Update tab path, name, and size
              tab.path = filePath
              const pathParts = filePath.replace(/\\/g, '/').split('/')
              tab.name = pathParts[pathParts.length - 1] || newName
              tab.size = saveResult.size
              logToMain(`Clipboard image successfully saved to path: ${filePath}`)
            } else {
              alert(t('app.failedSave') + (saveResult?.error || t('app.unknownErr')))
            }
          }
        }
      } catch (err) {
        console.error('Error during rename/save dialog:', err)
        alert(t('app.operationFailed') + (err as Error).message)
      }
    }
    closeRenameModal()
  }
}

watch(renameModalVisible, (visible) => {
  if (visible) {
    nextTick(() => {
      renameInputRef.value?.focus()
      renameInputRef.value?.select()
    })
  }
})

const closeTab = (id: string, event?: Event): void => {
  if (event) {
    event.stopPropagation()
  }
  const tabIndex = tabs.value.findIndex((tab) => tab.id === id)
  if (tabIndex === -1) return

  const [removedTab] = tabs.value.splice(tabIndex, 1)
  URL.revokeObjectURL(removedTab.url)

  if (activeTabId.value === id) {
    if (tabs.value.length > 0) {
      const nextActiveIndex = Math.min(tabIndex, tabs.value.length - 1)
      activeTabId.value = tabs.value[nextActiveIndex].id
    } else {
      activeTabId.value = null
    }
  }
}

const toggleColorFormat = (): void => {
  colorFormat.value = colorFormat.value === 'hex' ? 'rgb' : 'hex'
}

const handleImageClick = (event: MouseEvent): void => {
  const tab = activeTab.value
  if (!tab || !tab.ctx) return

  const imgElement = event.target as HTMLImageElement
  const rect = imgElement.getBoundingClientRect()

  const scaleX = tab.width / rect.width
  const scaleY = tab.height / rect.height

  const x = Math.floor((event.clientX - rect.left) * scaleX)
  const y = Math.floor((event.clientY - rect.top) * scaleY)

  if (x >= 0 && x < tab.width && y >= 0 && y < tab.height) {
    try {
      const pixel = tab.ctx.getImageData(x, y, 1, 1).data
      const r = pixel[0]
      const g = pixel[1]
      const b = pixel[2]
      const a = pixel[3]
      const alphaVal = parseFloat((a / 255).toFixed(3))

      const hex = '#' + [r, g, b, a].map((v) => v.toString(16).padStart(2, '0')).join('')
      const rgba = `rgba(${r}, ${g}, ${b}, ${alphaVal})`

      addRecord(x, y, hex, rgba)
    } catch (err) {
      console.error(err)
    }
  }
}

const handleKeyDown = (e: KeyboardEvent): void => {
  if (
    document.activeElement?.tagName === 'INPUT' ||
    document.activeElement?.tagName === 'TEXTAREA'
  ) {
    return
  }

  if (contextMenuVisible.value) {
    const key = e.key.toLowerCase()
    let handled = false
    if (key === 'x') {
      closeCurrentTab()
      handled = true
    } else if (key === 'o') {
      closeOtherTabs()
      handled = true
    } else if (key === 'a') {
      closeAllTabs()
      handled = true
    } else if (key === 'c') {
      copyImage()
      handled = true
    } else if (key === 'r') {
      openRenameModal()
      handled = true
    } else if (key === 'escape') {
      contextMenuVisible.value = false
      handled = true
    }

    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
    return
  }

  const tab = activeTab.value
  if (!tab || !tab.ctx) return

  let x = mouseX.value !== null ? mouseX.value : 0
  let y = mouseY.value !== null ? mouseY.value : 0

  let moved = false
  if (e.key === 'ArrowUp') {
    y = Math.max(0, y - 1)
    moved = true
    e.preventDefault()
  } else if (e.key === 'ArrowDown') {
    y = Math.min(tab.height - 1, y + 1)
    moved = true
    e.preventDefault()
  } else if (e.key === 'ArrowLeft') {
    x = Math.max(0, x - 1)
    moved = true
    e.preventDefault()
  } else if (e.key === 'ArrowRight') {
    x = Math.min(tab.width - 1, x + 1)
    moved = true
    e.preventDefault()
  } else if (e.key === 'Enter') {
    if (mouseX.value !== null && mouseY.value !== null) {
      addRecord(mouseX.value, mouseY.value, mouseColorHex.value, mouseColorRgba.value)
      e.preventDefault()
    }
  }

  if (moved) {
    try {
      const pixel = tab.ctx.getImageData(x, y, 1, 1).data
      const r = pixel[0]
      const g = pixel[1]
      const b = pixel[2]
      const a = pixel[3]
      const alphaVal = parseFloat((a / 255).toFixed(3))

      const hex = '#' + [r, g, b, a].map((v) => v.toString(16).padStart(2, '0')).join('')
      const rgba = `rgba(${r}, ${g}, ${b}, ${alphaVal})`

      mouseX.value = x
      mouseY.value = y
      mouseColorHex.value = hex
      mouseColorRgba.value = rgba

      // Move native OS mouse cursor to align with Arrow key movement
      if (imageRef.value) {
        const rect = imageRef.value.getBoundingClientRect()
        const renderX = rect.left + (x + 0.5) * (rect.width / tab.width)
        const renderY = rect.top + (y + 0.5) * (rect.height / tab.height)

        logToMain(
          `handleKeyDown moving: key=${e.key}, x=${x}, y=${y}, rectLeft=${rect.left}, rectTop=${rect.top}, renderX=${renderX}, renderY=${renderY}`
        )

        cursorX.value = renderX - rect.left
        cursorY.value = renderY - rect.top

        // Store warp state to block subsequent mousemove event handler
        lastWarpTime.value = Date.now()
        lastWarpX.value = x
        lastWarpY.value = y

        updateLoupe(x, y, tab)

        if (window.electron && window.electron.ipcRenderer) {
          // Send viewport-relative coordinate, main process adds ContentBounds origin
          window.electron.ipcRenderer.send('move-cursor', renderX, renderY)
        }
      }
    } catch (err) {
      console.error(err)
    }
  }
}

onMounted(() => {
  void window.electron?.ipcRenderer.invoke('set-app-locale', selectedLocale.value)
  removeSettingsListener = window.api?.onOpenSettings(() => {
    settingsVisible.value = true
  })
  removeAdbProgressListener = window.api?.onAdbDownloadProgress((progress) => {
    adbDownloadProgress.value = progress
  })
  removeMenuActionListener = window.api?.onMenuAction((action) => {
    if (action === 'open-image') void triggerFilePicker()
    if (action === 'capture-adb') void triggerAdbCapture()
    if (action === 'connect-adb') openConnectDialog()
  })
  window.addEventListener('paste', handlePaste)
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('focus', handleWindowFocus)
  window.addEventListener('focus', refreshAdbDevices)
  window.addEventListener('resize', handleWindowResize)
  void refreshAdbDevices()
  nextTick(() => {
    handleWindowFocus()
  })
})

onBeforeUnmount(() => {
  removeSettingsListener?.()
  removeMenuActionListener?.()
  removeAdbProgressListener?.()
  window.removeEventListener('paste', handlePaste)
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('focus', handleWindowFocus)
  window.removeEventListener('focus', refreshAdbDevices)
  window.removeEventListener('resize', handleWindowResize)
})
</script>

<template>
  <div
    class="app-layout"
    :class="{ 'is-resizing': isResizingSidebar }"
    @dragover="handleDragOver"
    @drop="handleDrop"
  >
    <!-- Top Toolbar -->
    <header class="top-toolbar">
      <button class="menu-btn" @click="triggerFilePicker">
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          stroke="currentColor"
          stroke-width="2.5"
          fill="none"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="btn-icon"
        >
          <path
            d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
          ></path>
        </svg>
        {{ t('app.openImage') }}
      </button>
      <div class="toolbar-spacer"></div>
      <div class="toolbar-device-group">
        <div class="device-picker">
          <span class="device-status-dot" :class="selectedAdbDeviceStatus"></span>
          <select
            v-model="selectedAdbSerial"
            class="device-select"
            :title="t('app.deviceSelect')"
            :aria-label="t('app.deviceSelect')"
            :disabled="adbDevices.length === 0"
            @focus="refreshAdbDevices"
          >
            <option v-if="adbDevices.length === 0" value="">{{ t('app.deviceNone') }}</option>
            <option v-for="device in adbDevices" :key="device.serial" :value="device.serial">
              {{ adbDeviceLabel(device) }}
            </option>
          </select>
        </div>
        <button class="menu-btn" @click="openConnectDialog">
          {{ t('app.connectPhone') }}
        </button>
        <button class="menu-btn primary" :disabled="isCapturingAdb" @click="triggerAdbCapture">
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            stroke="currentColor"
            stroke-width="2.5"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="btn-icon"
          >
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect>
            <line x1="12" y1="18" x2="12.01" y2="18"></line>
          </svg>
          {{ isCapturingAdb ? t('app.capturing') : t('app.adbScreen') }}
        </button>
      </div>
      <button
        v-if="!isMac"
        class="menu-btn toolbar-icon-btn"
        :title="t('app.settings')"
        :aria-label="t('app.settings')"
        @click="settingsVisible = true"
      >
        <svg
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="btn-icon"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
          />
        </svg>
      </button>
      <input
        ref="fileInputRef"
        type="file"
        multiple
        accept="image/*"
        class="hidden-file-input"
        @change="handleFileOpen"
      />
    </header>

    <!-- Main Container -->
    <div class="main-container">
      <!-- Left workspace: Tab list + Viewport -->
      <div class="workspace-area">
        <!-- Tab List -->
        <div v-if="tabs.length > 0" class="tabs-bar">
          <div
            v-for="tab in tabs"
            :key="tab.id"
            class="tab-item"
            :class="{ active: tab.id === activeTabId }"
            @click="activeTabId = tab.id"
            @contextmenu.prevent="handleTabContextMenu(tab, $event)"
          >
            <span class="tab-name" :title="tab.name">{{ formatFilename(tab.name, 16) }}</span>
            <button class="tab-close" @click="closeTab(tab.id, $event)">×</button>
          </div>
        </div>

        <!-- Image Viewport Area -->
        <main ref="viewportRef" class="image-viewport" :class="{ 'is-empty': tabs.length === 0 }">
          <div v-if="activeTab" class="image-wrapper">
            <div class="image-container-relative">
              <img
                ref="imageRef"
                :src="activeTab.url"
                class="pixel-image"
                @mousemove="handleMouseMove"
                @mouseleave="handleMouseLeave"
                @click="handleImageClick"
              />
              <div
                v-show="mouseX !== null && mouseY !== null"
                class="loupe-container"
                :style="loupeStyle"
              >
                <div class="loupe-frame">
                  <canvas ref="loupeCanvasRef" width="110" height="110"></canvas>
                  <div class="loupe-crosshair"></div>
                </div>
                <span class="loupe-tag">{{ mouseX }}, {{ mouseY }}</span>
              </div>
            </div>
          </div>
          <div v-else class="empty-state" @click="triggerFilePicker">
            <div class="upload-icon-wrapper">
              <svg
                viewBox="0 0 24 24"
                width="48"
                height="48"
                stroke="currentColor"
                stroke-width="1.5"
                fill="none"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <polyline points="21 15 16 10 5 21"></polyline>
              </svg>
            </div>
            <p class="empty-title">{{ t('app.dragHint') }}</p>
            <p class="empty-desc">{{ t('app.dragSub') }}</p>
          </div>
        </main>
      </div>

      <!-- Right Sidebar (Inspector) -->
      <div
        class="sidebar-resizer"
        :class="{ active: isResizingSidebar }"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        :aria-valuenow="sidebarWidth"
        :aria-valuemin="SIDEBAR_MIN_WIDTH"
        :aria-valuemax="SIDEBAR_MAX_WIDTH"
        :aria-label="t('app.resizeSidebar')"
        :title="t('app.resizeSidebar')"
        @pointerdown="startSidebarResize"
        @keydown="handleSidebarResizerKey"
        @dblclick="resetSidebarWidth"
      ></div>
      <aside class="sidebar" :style="{ width: `${sidebarWidth}px` }">
        <section class="readout" :aria-label="t('app.picker')">
          <div class="readout-top">
            <div class="readout-swatch">
              <span
                v-if="mouseX !== null"
                class="readout-swatch-fill"
                :style="{ backgroundColor: mouseColorHex }"
              ></span>
            </div>
            <div class="readout-side">
              <div class="readout-coords" :class="{ idle: mouseX === null }">
                <span class="readout-coord">
                  <span class="readout-axis">X</span>{{ mouseX ?? '–' }}
                </span>
                <span class="readout-coord">
                  <span class="readout-axis">Y</span>{{ mouseY ?? '–' }}
                </span>
              </div>
              <div class="readout-controls">
                <button
                  class="readout-format-btn"
                  :title="t('app.toggleFormat')"
                  :aria-label="`${t('app.toggleFormat')} (${t('app.current')}: ${colorFormat === 'hex' ? 'HEXA' : 'RGBA'})`"
                  @click="toggleColorFormat"
                >
                  <svg
                    viewBox="0 0 16 16"
                    width="12"
                    height="12"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M2 5h10l-2.5-2.5M14 11H4l2.5 2.5" />
                  </svg>
                  {{ colorFormat === 'hex' ? 'HEXA' : 'RGBA' }}
                </button>
                <div class="readout-help">
                  <button
                    class="readout-help-btn"
                    type="button"
                    :aria-label="t('app.pickerHelp')"
                    :aria-expanded="pickerHintOpen"
                    aria-describedby="readout-hint"
                    @click="pickerHintOpen = !pickerHintOpen"
                    @blur="pickerHintOpen = false"
                  >
                    ?
                  </button>
                  <p
                    id="readout-hint"
                    class="readout-hint"
                    :class="{ open: pickerHintOpen }"
                    role="tooltip"
                  >
                    {{ t('app.pickerHint') }}
                  </p>
                </div>
              </div>
            </div>
          </div>
          <div class="readout-value" :class="{ idle: mouseX === null }">
            {{ mouseX === null ? '–' : colorFormat === 'hex' ? mouseColorHex : mouseColorRgba }}
          </div>
        </section>

        <!-- Color Records Log List -->
        <section class="records-section">
          <div class="records-head">
            <h2 class="records-title">
              {{ t('app.recordsList') }}
              <span class="records-count">{{ filledCount }} / 10</span>
            </h2>
            <button v-if="filledCount > 0" class="clear-all-btn" @click="clearAllRecords">
              {{ t('app.clearAll') }}
            </button>
          </div>
          <ol class="records-list">
            <li
              v-for="record in records"
              :key="record.index"
              class="record-item"
              :class="{ 'has-data': record.x !== null }"
            >
              <span class="record-index">{{ record.index }}</span>
              <span class="record-swatch">
                <span
                  v-if="record.x !== null"
                  class="record-swatch-fill"
                  :style="{ backgroundColor: record.hex || undefined }"
                ></span>
              </span>
              <template v-if="record.x !== null">
                <span class="record-text">
                  <span class="record-coords">{{ record.x }}, {{ record.y }}</span>
                  <span
                    class="record-value"
                    :title="(colorFormat === 'hex' ? record.hex : record.rgba) || undefined"
                  >
                    {{ colorFormat === 'hex' ? record.hex : record.rgba }}
                  </span>
                </span>
                <button
                  class="record-clear-btn"
                  :title="t('app.clearRecord')"
                  :aria-label="t('app.clearRecord')"
                  @click="clearSlot(record.index)"
                >
                  ×
                </button>
              </template>
              <span v-else class="record-placeholder">–</span>
            </li>
          </ol>
        </section>
      </aside>
    </div>

    <!-- Bottom Status Bar -->
    <footer class="bottom-bar">
      <div class="bottom-left">
        <span class="filename-display-left" :title="activeTab?.name || ''">
          {{ activeTab ? activeTab.name : '' }}
        </span>
      </div>
      <div v-if="activeTab" class="bottom-right">
        <span>{{ activeTab.width }} × {{ activeTab.height }} px</span>
        <span>{{ formatSize(activeTab.size) }}</span>
      </div>
    </footer>

    <!-- Custom Context Menu -->
    <div
      v-if="contextMenuVisible"
      class="custom-context-menu"
      :style="{ left: `${contextMenuX}px`, top: `${contextMenuY}px` }"
    >
      <div class="context-menu-group">
        <button class="context-menu-item" @click="closeCurrentTab">
          {{ t('app.closeCurrent') }}
        </button>
        <button class="context-menu-item" @click="closeOtherTabs">
          {{ t('app.closeOthers') }}
        </button>
        <button class="context-menu-item" @click="closeAllTabs">{{ t('app.closeAll') }}</button>
      </div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-group">
        <button class="context-menu-item" @click="copyImage">{{ t('app.copyImage') }}</button>
        <button class="context-menu-item" @click="openRenameModal">{{ t('app.rename') }}</button>
      </div>
    </div>

    <!-- Settings Modal -->
    <div v-if="settingsVisible" class="rename-modal-overlay" @click.self="settingsVisible = false">
      <section
        class="rename-modal settings-modal"
        role="dialog"
        aria-modal="true"
        :aria-label="t('app.settingsTitle')"
      >
        <div class="rename-modal-header">
          <h3 class="rename-modal-title">{{ t('app.settingsTitle') }}</h3>
          <p class="rename-modal-subtitle">{{ t('app.settingsDescription') }}</p>
        </div>
        <div class="settings-field">
          <label class="settings-label" for="language-select">{{ t('app.language') }}</label>
          <select id="language-select" v-model="selectedLocale" class="language-select">
            <option
              v-for="supportedLocale in locales"
              :key="supportedLocale.code"
              :value="supportedLocale.code"
            >
              {{ supportedLocale.label }}
            </option>
          </select>
          <p class="settings-help">{{ t('app.languageDescription') }}</p>
        </div>
        <div class="settings-field">
          <span class="settings-label">{{ t('app.adbTitle') }}</span>
          <div class="adb-status">
            <span class="adb-status-label">{{ t('app.adbCurrent') }}</span>
            <template v-if="adbStatusLoading">{{ t('app.adbDetecting') }}</template>
            <template v-else-if="adbStatus?.location">
              <span class="adb-status-meta">
                {{ t(adbSourceLabelKeys[adbStatus.location.source]) }}
                <template v-if="adbStatus.version"> · {{ adbStatus.version }}</template>
              </span>
              <code class="adb-status-path" :title="adbStatus.location.path">
                {{ adbStatus.location.path }}
              </code>
            </template>
            <span v-else class="adb-status-missing">{{ t('app.adbNotFound') }}</span>
          </div>
          <label class="adb-sublabel" for="adb-custom-path">{{ t('app.adbCustomPath') }}</label>
          <div class="adb-path-row">
            <input
              id="adb-custom-path"
              class="rename-modal-input"
              type="text"
              readonly
              :value="adbStatus?.customPath ?? ''"
              :title="adbStatus?.customPath ?? ''"
              :placeholder="t('app.adbCustomPlaceholder')"
            />
            <button class="rename-modal-btn cancel" @click="chooseAdbPath">
              {{ t('app.adbChoose') }}
            </button>
            <button
              v-if="adbStatus?.customPath"
              class="rename-modal-btn cancel"
              @click="clearAdbPath"
            >
              {{ t('app.adbClear') }}
            </button>
          </div>
          <p v-if="adbStatus?.customPath && !adbStatus.customPathValid" class="settings-error">
            {{ t('app.adbCustomInvalid') }}
          </p>
          <p v-if="adbSettingsError" class="settings-error">{{ adbSettingsError }}</p>
          <div class="adb-actions">
            <button
              class="rename-modal-btn cancel"
              :disabled="adbStatusLoading"
              @click="refreshAdbStatus(true)"
            >
              {{ t('app.adbRedetect') }}
            </button>
            <button class="rename-modal-btn cancel" @click="openAdbDownload(false)">
              {{ adbStatus?.downloadedPath ? t('app.adbRedownload') : t('app.adbDownloadAction') }}
            </button>
          </div>
          <p class="settings-help">{{ t('app.adbSearchOrder') }}</p>
        </div>
        <div class="rename-modal-footer">
          <button class="rename-modal-btn cancel" @click="settingsVisible = false">
            {{ t('app.close') }}
          </button>
        </div>
      </section>
    </div>

    <!-- ADB Connect Dialog -->
    <AdbConnectDialog
      v-if="connectDialogVisible"
      @close="connectDialogVisible = false"
      @connected="handleAdbConnected"
      @adb-missing="handleConnectAdbMissing"
    />

    <!-- ADB Download Modal -->
    <div v-if="adbDownloadVisible" class="rename-modal-overlay" @click.self="closeAdbDownload">
      <section
        class="rename-modal"
        role="dialog"
        aria-modal="true"
        :aria-label="t('app.adbDownloadTitle')"
      >
        <div class="rename-modal-header">
          <h3 class="rename-modal-title">{{ t('app.adbDownloadTitle') }}</h3>
          <p class="rename-modal-subtitle">
            <template v-if="adbDownloadForCapture">{{ t('app.adbDownloadNotFound') }}</template>
            {{ t('app.adbDownloadSub') }}
          </p>
          <p class="rename-modal-subtitle">
            {{ t('app.adbLicense') }}
            <a :href="ADB_LICENSE_URL" target="_blank" rel="noreferrer">
              {{ t('app.adbLicenseLink') }}
            </a>
          </p>
        </div>
        <div v-if="adbDownloading" class="adb-download-progress">
          <p class="settings-help">{{ adbDownloadPhaseText }}</p>
          <div class="adb-progress-track">
            <div
              class="adb-progress-bar"
              :class="{ indeterminate: adbDownloadPercent === null }"
              :style="adbDownloadPercent === null ? undefined : { width: adbDownloadPercent + '%' }"
            ></div>
          </div>
        </div>
        <p v-if="adbDownloadError" class="settings-error">
          {{ t('app.adbDownloadFailed') + adbDownloadError }}
          <br />
          {{ t('app.adbDownloadManual') }}
        </p>
        <div class="rename-modal-footer">
          <button
            class="rename-modal-btn cancel"
            :disabled="adbDownloading"
            @click="closeAdbDownload"
          >
            {{ t('app.cancel') }}
          </button>
          <button
            class="rename-modal-btn confirm"
            :disabled="adbDownloading"
            @click="startAdbDownload"
          >
            {{ adbDownloadError ? t('app.adbRetry') : t('app.adbDownload') }}
          </button>
        </div>
      </section>
    </div>

    <!-- Rename Modal Dialog -->
    <div v-if="renameModalVisible" class="rename-modal-overlay" @click.self="closeRenameModal">
      <div class="rename-modal">
        <div class="rename-modal-header">
          <h3 class="rename-modal-title">{{ t('app.renameTitle') }}</h3>
          <p class="rename-modal-subtitle">{{ t('app.renameSub') }}</p>
        </div>
        <div class="rename-modal-body">
          <input
            ref="renameInputRef"
            v-model="renameInputName"
            type="text"
            class="rename-modal-input"
            :placeholder="t('app.inputNewName')"
            @keydown.enter="confirmRename"
            @keydown.esc="closeRenameModal"
          />
        </div>
        <div class="rename-modal-footer">
          <button class="rename-modal-btn cancel" @click="closeRenameModal">
            {{ t('app.cancel') }}
          </button>
          <button class="rename-modal-btn confirm" @click="confirmRename">
            {{ t('app.confirm') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.loupe-container {
  position: absolute;
  z-index: 100;
  width: 110px;
  pointer-events: none;
}

.loupe-frame {
  position: relative;
  width: 110px;
  height: 110px;
  overflow: hidden;
  border-radius: 4px;
  background: #2a2a2a;
  box-shadow:
    0 0 0 1px #000,
    0 6px 18px rgba(0, 0, 0, 0.45);
}

.loupe-frame canvas {
  display: block;
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
}

/* 中心像素框：白黑双层描边，在任何颜色上都看得清 */
.loupe-crosshair {
  position: absolute;
  top: 50px;
  left: 50px;
  width: 10px;
  height: 10px;
  box-shadow:
    0 0 0 1px #ffffff,
    0 0 0 2px #000000;
}

.loupe-tag {
  display: inline-block;
  margin-top: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(24, 24, 24, 0.88);
  color: #ededed;
  font-family: var(--font-value);
  font-size: 11px;
  white-space: nowrap;
}
</style>
