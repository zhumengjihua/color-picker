<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'

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

// i18n
const isZh = navigator.language.startsWith('zh')
const t = {
  openImage: isZh ? '打开图片' : 'Open Image',
  adbScreen: isZh ? 'ADB 截图' : 'ADB Screen',
  capturing: isZh ? '截图中...' : 'Capturing...',
  dragHint: isZh ? '拖拽图片到这里，或点击选择图片' : 'Drag images here, or click to select',
  dragSub: isZh ? '支持多张图片同时打开，支持 Ctrl + V 直接粘贴图片' : 'Supports multiple images and Ctrl + V pasting',
  imgProps: isZh ? '图片属性' : 'Image Properties',
  resolution: isZh ? '分辨率' : 'Resolution',
  picker: isZh ? '取色器' : 'Color Picker',
  coords: isZh ? '坐标' : 'Coordinates',
  recordsList: isZh ? '记录列表' : 'Records List',
  clearAll: isZh ? '清空全部' : 'Clear All',
  closeCurrent: isZh ? '关闭当前 (X)' : 'Close Current (X)',
  closeOthers: isZh ? '关闭其他 (O)' : 'Close Others (O)',
  closeAll: isZh ? '关闭所有 (A)' : 'Close All (A)',
  rename: isZh ? '重命名 (R)' : 'Rename (R)',
  copyImage: isZh ? '复制 (C)' : 'Copy (C)',
  renameTitle: isZh ? '重命名图片' : 'Rename Image',
  renameSub: isZh ? '请输入新的图片名称。如果是剪贴板复制没有路径的图片，点击确定后需选择保存路径。' : 'Enter new image name. For clipboard images without paths, you must select a save path after confirming.',
  inputNewName: isZh ? '请输入新名称...' : 'Enter new name...',
  cancel: isZh ? '取消' : 'Cancel',
  confirm: isZh ? '确定' : 'Confirm',
  toggleFormat: isZh ? '点击切换颜色格式' : 'Click to toggle color format',
  current: isZh ? '当前' : 'Current',
  clearRecord: isZh ? '清空此条记录' : 'Clear this record',
  failedRename: isZh ? '重命名文件失败: ' : 'Failed to rename file: ',
  unknownErr: isZh ? '未知错误' : 'Unknown error',
  operationFailed: isZh ? '操作失败: ' : 'Operation failed: ',
  failedSave: isZh ? '保存图片文件失败: ' : 'Failed to save image file: ',
  failedAdb: isZh ? 'ADB 截图失败: ' : 'ADB capture failed: ',
  adbEnsure: isZh ? '请确保手机已连接并授权 USB 调试' : 'Please ensure phone is connected and USB debugging is authorized',
  onlyClient: isZh ? '该功能仅在客户端下可用' : 'This feature is only available in the desktop client'
}

// Mouse state
const mouseX = ref<number | null>(null)
const mouseY = ref<number | null>(null)
const mouseColorHex = ref<string>('#ffffffff')
const mouseColorRgba = ref<string>('rgba(255, 255, 255, 1.000)')

const fileInputRef = ref<HTMLInputElement | null>(null)
const imageRef = ref<HTMLImageElement | null>(null)
const lastWarpTime = ref<number>(0)
const lastWarpX = ref<number | null>(null)
const lastWarpY = ref<number | null>(null)

const cursorX = ref<number | null>(null)
const cursorY = ref<number | null>(null)
const loupeCanvasRef = ref<HTMLCanvasElement | null>(null)

const updateLoupe = (x: number, y: number, tab: ImageTab) => {
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
  loupeCtx.strokeStyle = 'rgba(255, 255, 255, 0.3)'
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

const loupeStyle = computed(() => {
  if (cursorX.value === null || cursorY.value === null) return { display: 'none' }
  let left = cursorX.value + 15
  let top = cursorY.value + 15
  if (imageRef.value) {
    const rect = imageRef.value.getBoundingClientRect()
    if (cursorX.value > rect.width - 130) left = cursorX.value - 125
    if (cursorY.value > rect.height - 130) top = cursorY.value - 125
  }
  return {
    left: `${left}px`,
    top: `${top}px`,
    display: 'block'
  }
})

const logToMain = (msg: string) => {
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

const filledCount = computed(() => records.value.filter(r => r.x !== null).length)

const addRecord = (x: number, y: number, hex: string, rgba: string) => {
  const emptySlot = records.value.find(r => r.x === null)
  if (emptySlot) {
    emptySlot.x = x
    emptySlot.y = y
    emptySlot.hex = hex
    emptySlot.rgba = rgba
  }
}

const clearSlot = (index: number) => {
  const slot = records.value.find(r => r.index === index)
  if (slot) {
    slot.x = null
    slot.y = null
    slot.hex = null
    slot.rgba = null
  }
}

const clearAllRecords = () => {
  records.value.forEach(slot => {
    slot.x = null
    slot.y = null
    slot.hex = null
    slot.rgba = null
  })
}

const activeTab = computed(() => {
  return tabs.value.find(tab => tab.id === activeTabId.value) || null
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

const addImages = (files: File[] | FileList) => {
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

      const name = file.name && file.name !== 'image.png' 
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
        path: (file as any).path || null
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

const addNativeImages = (files: NativeImageFile[]) => {
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

const triggerFilePicker = async () => {
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

const isCapturingAdb = ref(false)

const triggerAdbCapture = async () => {
  if (isCapturingAdb.value) return
  isCapturingAdb.value = true
  
  if (window.electron && window.electron.ipcRenderer) {
    try {
      const result = await window.electron.ipcRenderer.invoke('capture-adb-screen')
      if (result && result.success) {
        addNativeImages([{
          path: result.path || ('adb-screenshot-' + Date.now() + '.png'),
          name: result.name || ((isZh ? '手机截图 ' : 'Screenshot ') + new Date().toLocaleTimeString()),
          size: result.size,
          dataUrl: result.dataUrl
        }])
      } else {
        alert(t.failedAdb + (result?.error || t.adbEnsure))
      }
    } catch (err: any) {
      console.error('Failed to capture adb screen:', err)
      alert(t.operationFailed + err.message)
    }
  } else {
    alert(t.onlyClient)
  }
  isCapturingAdb.value = false
}

const handleFileOpen = (event: Event) => {
  const target = event.target as HTMLInputElement
  if (target.files && target.files.length > 0) {
    addImages(target.files)
    target.value = ''
  }
}

const handleDragOver = (e: DragEvent) => {
  e.preventDefault()
}

const handleDrop = (e: DragEvent) => {
  e.preventDefault()
  const files = e.dataTransfer?.files
  if (files && files.length > 0) {
    addImages(Array.from(files))
  }
}

const handlePaste = (e: ClipboardEvent) => {
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

const handleMouseMove = (event: MouseEvent) => {
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
    logToMain(`handleMouseMove GUARDED: x=${x}, y=${y}, targetX=${lastWarpX.value}, targetY=${lastWarpY.value}`)
    return
  }

  logToMain(`handleMouseMove: clientX=${event.clientX}, clientY=${event.clientY}, rectLeft=${rect.left}, rectTop=${rect.top}, x=${x}, y=${y}`)

  // Bounds check
  if (x >= 0 && x < tab.width && y >= 0 && y < tab.height) {
    try {
      const pixel = tab.ctx.getImageData(x, y, 1, 1).data
      const r = pixel[0]
      const g = pixel[1]
      const b = pixel[2]
      const a = pixel[3]
      
      const alphaVal = parseFloat((a / 255).toFixed(3))
      
      const hex = '#' + [r, g, b, a].map(v => v.toString(16).padStart(2, '0')).join('')
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

const handleMouseLeave = () => {
  mouseX.value = null
  mouseY.value = null
  cursorX.value = null
  cursorY.value = null
}

const handleWindowFocus = async () => {
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
            
            const hex = '#' + [r, g, b, a].map(v => v.toString(16).padStart(2, '0')).join('')
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

const handleTabContextMenu = (tab: ImageTab, event: MouseEvent) => {
  event.preventDefault()
  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  contextMenuTabId.value = tab.id
  contextMenuVisible.value = true

  // Listen for clicks to dismiss context menu
  const closeMenu = () => {
    contextMenuVisible.value = false
    window.removeEventListener('click', closeMenu)
  }
  setTimeout(() => {
    window.addEventListener('click', closeMenu)
  }, 0)
}

const closeCurrentTab = () => {
  if (contextMenuTabId.value) {
    closeTab(contextMenuTabId.value)
  }
  contextMenuVisible.value = false
}

const closeOtherTabs = () => {
  if (contextMenuTabId.value) {
    const keepId = contextMenuTabId.value
    // Revoke URL for other tabs
    tabs.value.forEach(tab => {
      if (tab.id !== keepId) {
        URL.revokeObjectURL(tab.url)
      }
    })
    tabs.value = tabs.value.filter(tab => tab.id === keepId)
    activeTabId.value = keepId
  }
  contextMenuVisible.value = false
}

const closeAllTabs = () => {
  tabs.value.forEach(tab => {
    URL.revokeObjectURL(tab.url)
  })
  tabs.value = []
  activeTabId.value = null
  contextMenuVisible.value = false
}

const copyImage = async () => {
  if (!contextMenuTabId.value) return
  const tab = tabs.value.find(t => t.id === contextMenuTabId.value)
  if (!tab || !tab.canvas) return
  
  if (window.electron && window.electron.ipcRenderer) {
    const base64Data = tab.canvas.toDataURL('image/png')
    window.electron.ipcRenderer.send('copy-image-to-clipboard', base64Data)
    logToMain('Copied image to clipboard via IPC')
  }
  
  contextMenuVisible.value = false
}

const openRenameModal = () => {
  if (!contextMenuTabId.value) return
  const tab = tabs.value.find(t => t.id === contextMenuTabId.value)
  if (tab) {
    renameTargetTabId.value = tab.id
    renameInputName.value = tab.name
    renameModalVisible.value = true
  }
  contextMenuVisible.value = false
}

const closeRenameModal = () => {
  renameModalVisible.value = false
  renameTargetTabId.value = null
  renameInputName.value = ''
}

const confirmRename = async () => {
  if (!renameTargetTabId.value || !renameInputName.value.trim()) return
  const tab = tabs.value.find(t => t.id === renameTargetTabId.value)
  if (!tab) return

  const newName = renameInputName.value.trim()

  if (tab.path) {
    // If it's a local file, rename the actual file on disk!
    if (window.electron && window.electron.ipcRenderer) {
      try {
        const result = await window.electron.ipcRenderer.invoke('rename-file-on-disk', tab.path, newName)
        if (result && result.success) {
          tab.path = result.newPath
          const pathParts = result.newPath.replace(/\\/g, '/').split('/')
          tab.name = pathParts[pathParts.length - 1] || newName
          logToMain(`File successfully renamed on disk to: ${result.newPath}`)
        } else {
          alert(t.failedRename + (result?.error || t.unknownErr))
        }
      } catch (err: any) {
        console.error('Failed to rename file:', err)
        alert(t.operationFailed + err.message)
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
            const saveResult = await window.electron.ipcRenderer.invoke('save-image-file', filePath, base64Data)
            if (saveResult && saveResult.success) {
              // Update tab path, name, and size
              tab.path = filePath
              const pathParts = filePath.replace(/\\/g, '/').split('/')
              tab.name = pathParts[pathParts.length - 1] || newName
              tab.size = saveResult.size
              logToMain(`Clipboard image successfully saved to path: ${filePath}`)
            } else {
              alert(t.failedSave + (saveResult?.error || t.unknownErr))
            }
          }
        }
      } catch (err: any) {
        console.error('Error during rename/save dialog:', err)
        alert(t.operationFailed + err.message)
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

const closeTab = (id: string, event?: Event) => {
  if (event) {
    event.stopPropagation()
  }
  const tabIndex = tabs.value.findIndex(tab => tab.id === id)
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

const toggleColorFormat = () => {
  colorFormat.value = colorFormat.value === 'hex' ? 'rgb' : 'hex'
}

const handleImageClick = (event: MouseEvent) => {
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
      
      const hex = '#' + [r, g, b, a].map(v => v.toString(16).padStart(2, '0')).join('')
      const rgba = `rgba(${r}, ${g}, ${b}, ${alphaVal})`
      
      addRecord(x, y, hex, rgba)
    } catch (err) {
      console.error(err)
    }
  }
}

const handleKeyDown = (e: KeyboardEvent) => {
  if (
    document.activeElement?.tagName === 'INPUT' || 
    document.activeElement?.tagName === 'TEXTAREA'
  ) {
    return
  }

  if (contextMenuVisible.value) {
    const key = e.key.toLowerCase()
    let handled = false
    if (key === 'x') { closeCurrentTab(); handled = true }
    else if (key === 'o') { closeOtherTabs(); handled = true }
    else if (key === 'a') { closeAllTabs(); handled = true }
    else if (key === 'c') { copyImage(); handled = true }
    else if (key === 'r') { openRenameModal(); handled = true }
    else if (key === 'escape') { contextMenuVisible.value = false; handled = true }
    
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
      
      const hex = '#' + [r, g, b, a].map(v => v.toString(16).padStart(2, '0')).join('')
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
        
        logToMain(`handleKeyDown moving: key=${e.key}, x=${x}, y=${y}, rectLeft=${rect.left}, rectTop=${rect.top}, renderX=${renderX}, renderY=${renderY}`)

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
  window.addEventListener('paste', handlePaste)
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('focus', handleWindowFocus)
  nextTick(() => {
    handleWindowFocus()
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('paste', handlePaste)
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('focus', handleWindowFocus)
})
</script>

<template>
  <div class="app-layout" @dragover="handleDragOver" @drop="handleDrop">
    <!-- Top Toolbar -->
    <header class="top-toolbar">
      <div class="toolbar-left">
        <button class="menu-btn" @click="triggerFilePicker">
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" class="btn-icon">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
          {{ t.openImage }}
        </button>
        <button class="menu-btn" @click="triggerAdbCapture" :disabled="isCapturingAdb" style="margin-left: 8px;">
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" class="btn-icon">
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect>
            <line x1="12" y1="18" x2="12.01" y2="18"></line>
          </svg>
          {{ isCapturingAdb ? t.capturing : t.adbScreen }}
        </button>
        <input 
          type="file" 
          ref="fileInputRef" 
          multiple 
          accept="image/*" 
          class="hidden-file-input" 
          @change="handleFileOpen"
        />
      </div>
      <div class="toolbar-center">
        <!-- Empty for now as requested -->
      </div>
      <div class="toolbar-right">
        <!-- Empty for now as requested -->
      </div>
    </header>

    <!-- Main Container -->
    <div class="main-container">
      <!-- Left workspace: Tab list + Viewport -->
      <div class="workspace-area">
        <!-- Tab List -->
        <div class="tabs-bar" v-if="tabs.length > 0">
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
        <main class="image-viewport" :class="{ 'is-empty': tabs.length === 0 }">
          <div class="image-wrapper" v-if="activeTab">
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
                <canvas ref="loupeCanvasRef" width="110" height="110"></canvas>
                <div class="loupe-crosshair"></div>
              </div>
            </div>
          </div>
          <div class="empty-state" v-else @click="triggerFilePicker">
            <div class="upload-icon-wrapper">
              <svg viewBox="0 0 24 24" width="48" height="48" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <polyline points="21 15 16 10 5 21"></polyline>
              </svg>
            </div>
            <p class="empty-title">{{ t.dragHint }}</p>
            <p class="empty-desc">{{ t.dragSub }}</p>
          </div>
        </main>
      </div>

      <!-- Right Sidebar (Inspector) -->
      <aside class="sidebar right-sidebar">
        <div class="sidebar-wrapper">
          <div class="sidebar-section">
            <div class="section-title">{{ t.picker }}</div>
            <div class="info-card picker-details">
              <div class="info-item">
                <span class="info-label">{{ t.coords }}</span>
                <span class="info-value coord-val">
                  ({{ mouseX !== null ? mouseX : 0 }}, {{ mouseY !== null ? mouseY : 0 }})
                </span>
              </div>
              <div 
                class="color-row-clickable" 
                @click="toggleColorFormat"
                :title="mouseX !== null ? `${t.toggleFormat} (${t.current}: ${colorFormat === 'hex' ? 'RGBA' : 'HEXA'})` : t.toggleFormat"
              >
                <div class="color-preview" :style="{ backgroundColor: mouseX !== null ? mouseColorHex : '#00000000' }"></div>
                <span class="color-value-text">
                  {{ mouseX !== null ? (colorFormat === 'hex' ? mouseColorHex : mouseColorRgba) : (colorFormat === 'hex' ? '#00000000' : 'rgba(0, 0, 0, 0.000)') }}
                </span>
              </div>
            </div>
          </div>

          <!-- Color Records Log List -->
          <div class="sidebar-section records-section">
            <div class="section-header">
              <span class="section-title">{{ t.recordsList }} ({{ filledCount }}/10)</span>
              <button class="clear-all-btn" @click="clearAllRecords" v-if="filledCount > 0">
                {{ t.clearAll }}
              </button>
            </div>
            <div class="records-list">
              <div 
                v-for="record in records" 
                :key="record.index" 
                class="record-item"
                :class="{ 'has-data': record.x !== null }"
              >
                <span class="record-index">{{ record.index }}</span>
                <div class="record-content" v-if="record.x !== null">
                  <div class="record-coords">X:{{ record.x }} Y:{{ record.y }}</div>
                  <div class="record-color-row">
                    <div class="record-color-preview" :style="{ backgroundColor: record.hex || undefined }"></div>
                    <span class="record-color-text" :title="(colorFormat === 'hex' ? record.hex : record.rgba) || undefined">
                      {{ colorFormat === 'hex' ? record.hex : record.rgba }}
                    </span>
                  </div>
                </div>
                <div class="record-content empty" v-else>
                  <div class="record-coords">X:0 Y:0</div>
                  <div class="record-color-row">
                    <div class="record-color-preview empty"></div>
                    <span class="record-color-text">#00000000</span>
                  </div>
                </div>
                <button 
                  class="record-clear-btn" 
                  @click="clearSlot(record.index)" 
                  v-if="record.x !== null"
                  :title="t.clearRecord"
                >
                  ×
                </button>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>

    <!-- Bottom Status Bar -->
    <footer class="bottom-bar">
      <div class="bottom-left filename-container">
        <span class="status-text filename-display-left" :title="activeTab?.name || ''">
          {{ activeTab ? activeTab.name : '' }}
        </span>
      </div>
      <div class="bottom-right">
        <span class="status-text resolution-display" v-if="activeTab">
          {{ activeTab.width }}×{{ activeTab.height }} px
        </span>
        <span class="status-divider" v-if="activeTab">|</span>
        <span class="status-text filesize-display">
          {{ activeTab ? formatSize(activeTab.size) : '0 Bytes' }}
        </span>
      </div>
    </footer>

    <!-- Custom Context Menu -->
    <div 
      v-if="contextMenuVisible" 
      class="custom-context-menu" 
      :style="{ left: `${contextMenuX}px`, top: `${contextMenuY}px` }"
    >
      <div class="context-menu-group">
        <button class="context-menu-item" @click="closeCurrentTab">{{ t.closeCurrent }}</button>
        <button class="context-menu-item" @click="closeOtherTabs">{{ t.closeOthers }}</button>
        <button class="context-menu-item" @click="closeAllTabs">{{ t.closeAll }}</button>
      </div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-group">
        <button class="context-menu-item" @click="copyImage">{{ t.copyImage }}</button>
        <button class="context-menu-item" @click="openRenameModal">{{ t.rename }}</button>
      </div>
    </div>

    <!-- Rename Modal Dialog -->
    <div v-if="renameModalVisible" class="rename-modal-overlay" @click.self="closeRenameModal">
      <div class="rename-modal">
        <div class="rename-modal-header">
          <h3 class="rename-modal-title">{{ t.renameTitle }}</h3>
          <p class="rename-modal-subtitle">{{ t.renameSub }}</p>
        </div>
        <div class="rename-modal-body">
          <input 
            v-model="renameInputName" 
            type="text" 
            class="rename-modal-input" 
            :placeholder="t.inputNewName"
            @keydown.enter="confirmRename"
            @keydown.esc="closeRenameModal"
            ref="renameInputRef"
          />
        </div>
        <div class="rename-modal-footer">
          <button class="rename-modal-btn cancel" @click="closeRenameModal">{{ t.cancel }}</button>
          <button class="rename-modal-btn confirm" @click="confirmRename">{{ t.confirm }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.loupe-container {
  position: absolute;
  width: 110px;
  height: 110px;
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 0 8px rgba(0,0,0,0.5);
  pointer-events: none;
  overflow: hidden;
  background-color: #333;
  z-index: 100;
  image-rendering: pixelated;
}
.loupe-container canvas {
  width: 100%;
  height: 100%;
  display: block;
}
.loupe-crosshair {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 10px;
  height: 10px;
  margin-top: -5px;
  margin-left: -5px;
  border: 1px solid rgba(255, 0, 0, 0.8);
  pointer-events: none;
  box-sizing: border-box;
}
</style>
