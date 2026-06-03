import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { exec, execFile } from 'child_process'
import { existsSync } from 'fs'
import icon from '../../resources/icon.png?asset'

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  app.setName('ColorPicker')

  const locale = app.getLocale()
  const isZh = locale.startsWith('zh')
  const { Menu } = require('electron')

  const template: any[] = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: isZh ? '关于 ColorPicker' : 'About ColorPicker' },
        { type: 'separator' },
        { role: 'services', label: isZh ? '服务' : 'Services' },
        { type: 'separator' },
        { role: 'hide', label: isZh ? '隐藏 ColorPicker' : 'Hide ColorPicker' },
        { role: 'hideOthers', label: isZh ? '隐藏其他' : 'Hide Others' },
        { role: 'unhide', label: isZh ? '显示全部' : 'Show All' },
        { type: 'separator' },
        { role: 'quit', label: isZh ? '退出 ColorPicker' : 'Quit ColorPicker' }
      ]
    }] : []),
    {
      label: isZh ? '文件' : 'File',
      submenu: [
        process.platform === 'darwin' ? { role: 'close', label: isZh ? '关闭窗口' : 'Close Window' } : { role: 'quit', label: isZh ? '退出' : 'Quit' }
      ]
    },
    {
      label: isZh ? '编辑' : 'Edit',
      submenu: [
        { role: 'undo', label: isZh ? '撤销' : 'Undo' },
        { role: 'redo', label: isZh ? '重做' : 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: isZh ? '剪切' : 'Cut' },
        { role: 'copy', label: isZh ? '复制' : 'Copy' },
        { role: 'paste', label: isZh ? '粘贴' : 'Paste' }
      ]
    },
    {
      label: isZh ? '视图' : 'View',
      submenu: [
        { role: 'reload', label: isZh ? '重新加载' : 'Reload' },
        { role: 'forceReload', label: isZh ? '强制重新加载' : 'Force Reload' },
        { role: 'toggleDevTools', label: isZh ? '切换开发者工具' : 'Toggle Developer Tools' },
        { type: 'separator' },
        { role: 'resetZoom', label: isZh ? '实际大小' : 'Actual Size' },
        { role: 'zoomIn', label: isZh ? '放大' : 'Zoom In' },
        { role: 'zoomOut', label: isZh ? '缩小' : 'Zoom Out' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: isZh ? '切换全屏' : 'Toggle Full Screen' }
      ]
    }
  ]
  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Compile move_cursor.swift on startup in development
  if (is.dev && process.platform === 'darwin') {
    const srcPath = join(app.getAppPath(), 'src/main/move_cursor.swift')
    const destPath = join(app.getAppPath(), 'resources/move_cursor')
    if (existsSync(srcPath)) {
      exec(`swiftc -O "${srcPath}" -o "${destPath}"`, (err) => {
        if (err) console.error('Failed to compile move_cursor.swift:', err)
        else console.log('Successfully compiled move_cursor.swift')
      })
    }
  }

  // IPC to move mouse cursor (receives viewport-relative coordinates and converts to screen-space)
  ipcMain.on('move-cursor', (event, clientX: number, clientY: number) => {
    if (process.platform !== 'darwin') return
    
    const webContents = event.sender
    const win = BrowserWindow.fromWebContents(webContents)
    if (!win) return

    const contentBounds = win.getContentBounds()
    const screenX = Math.round(contentBounds.x + clientX)
    const screenY = Math.round(contentBounds.y + clientY)

    // Write logs to debug.log for inspection
    try {
      const { appendFileSync } = require('fs')
      appendFileSync(join(app.getAppPath(), 'debug.log'), `[Main] move-cursor: clientX=${clientX}, clientY=${clientY}, screenX=${screenX}, screenY=${screenY}, contentBounds=${JSON.stringify(contentBounds)}\n`)
    } catch (e) {
      console.error(e)
    }

    let binaryPath = join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'move_cursor')
    if (!existsSync(binaryPath)) {
      binaryPath = join(app.getAppPath(), 'resources', 'move_cursor')
    }
    if (!existsSync(binaryPath)) {
      binaryPath = join(app.getAppPath(), '..', 'resources', 'move_cursor')
    }

    if (existsSync(binaryPath)) {
      execFile(binaryPath, [screenX.toString(), screenY.toString()], (error) => {
        if (error) {
          console.error('Failed to execute move_cursor binary:', error)
        }
      })
    } else {
      console.error('move_cursor binary not found at', binaryPath)
    }
  })

  // IPC for general logging
  ipcMain.on('log-message', (_event, msg: string) => {
    try {
      const { appendFileSync } = require('fs')
      appendFileSync(join(app.getAppPath(), 'debug.log'), msg + '\n')
    } catch (e) {
      console.error(e)
    }
  })

  // IPC to get cursor position relative to window content viewport
  ipcMain.handle('get-cursor-position', (event) => {
    const { screen } = require('electron')
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null

    const cursorPoint = screen.getCursorScreenPoint()
    const contentBounds = win.getContentBounds()

    return {
      x: cursorPoint.x - contentBounds.x,
      y: cursorPoint.y - contentBounds.y
    }
  })

  // IPC to show save dialog
  ipcMain.handle('show-save-dialog', async (event, defaultName: string) => {
    const { dialog } = require('electron')
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null

    const result = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters: [
        { name: 'PNG Image', extensions: ['png'] },
        { name: 'JPEG Image', extensions: ['jpg', 'jpeg'] },
        { name: 'WebP Image', extensions: ['webp'] }
      ]
    })
    return result.filePath || null
  })

  // IPC to write base64 image data to file path
  ipcMain.handle('save-image-file', async (_event, filePath: string, base64Data: string) => {
    try {
      const { writeFileSync } = require('fs')
      const base64Clean = base64Data.replace(/^data:image\/\w+;base64,/, "")
      const buffer = Buffer.from(base64Clean, 'base64')
      writeFileSync(filePath, buffer)
      
      // Get file size
      const { statSync } = require('fs')
      const stats = statSync(filePath)
      return { success: true, size: stats.size }
    } catch (err: any) {
      console.error('Failed to save image:', err)
      return { success: false, error: err.message }
    }
  })

  // IPC to copy image to clipboard
  ipcMain.on('copy-image-to-clipboard', (_event, base64Data: string) => {
    const { clipboard, nativeImage } = require('electron')
    const base64Clean = base64Data.replace(/^data:image\/\w+;base64,/, "")
    const image = nativeImage.createFromBuffer(Buffer.from(base64Clean, 'base64'))
    clipboard.writeImage(image)
  })

  // IPC to show open dialog and return files base64 data & paths
  ipcMain.handle('show-open-dialog', async (event) => {
    const { dialog } = require('electron')
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null

    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }
      ]
    })
    
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const fs = require('fs')
    const path = require('path')
    
    return result.filePaths.map(filePath => {
      const stats = fs.statSync(filePath)
      const data = fs.readFileSync(filePath)
      const ext = path.extname(filePath).toLowerCase()
      let mimeType = 'image/png'
      if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg'
      else if (ext === '.webp') mimeType = 'image/webp'
      else if (ext === '.gif') mimeType = 'image/gif'
      else if (ext === '.bmp') mimeType = 'image/bmp'

      return {
        path: filePath,
        name: path.basename(filePath),
        size: stats.size,
        dataUrl: `data:${mimeType};base64,${data.toString('base64')}`
      }
    })
  })

  // IPC to rename file on disk in-place
  ipcMain.handle('rename-file-on-disk', async (_event, oldPath: string, newName: string) => {
    const fs = require('fs')
    const path = require('path')
    try {
      const dir = path.dirname(oldPath)
      const ext = path.extname(oldPath)
      
      const finalName = newName.toLowerCase().endsWith(ext.toLowerCase()) ? newName : newName + ext
      const newPath = path.join(dir, finalName)

      if (!fs.existsSync(oldPath)) {
        return { success: false, error: '原文件不存在' }
      }

      if (fs.existsSync(newPath) && oldPath.toLowerCase() !== newPath.toLowerCase()) {
        return { success: false, error: '目标文件名已存在' }
      }

      fs.renameSync(oldPath, newPath)
      return { success: true, newPath }
    } catch (err: any) {
      console.error('Failed to rename file on disk:', err)
      return { success: false, error: err.message }
    }
  })

  // IPC to capture adb screen
  ipcMain.handle('capture-adb-screen', async () => {
    return new Promise((resolve) => {
      const { exec } = require('child_process')
      // Ensure we get raw buffer output, not a string
      exec('adb exec-out screencap -p', { encoding: 'buffer', maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
        if (error) {
          resolve({ success: false, error: error.message || (stderr ? stderr.toString() : 'Unknown error') })
          return
        }
        if (!stdout || stdout.length === 0) {
          resolve({ success: false, error: 'Empty output from adb. Please check if device is connected.' })
          return
        }
        
        try {
          const fs = require('fs')
          const path = require('path')
          const os = require('os')
          const saveDir = path.join(os.homedir(), 'Pictures', 'colorpicker')
          if (!fs.existsSync(saveDir)) {
            fs.mkdirSync(saveDir, { recursive: true })
          }
          
          const date = new Date()
          const pad = (n: number) => n.toString().padStart(2, '0')
          const filename = `adb_screenshot_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.png`
          const savePath = path.join(saveDir, filename)
          
          fs.writeFileSync(savePath, stdout)
          
          resolve({
            success: true,
            dataUrl: `data:image/png;base64,${stdout.toString('base64')}`,
            size: stdout.length,
            path: savePath,
            name: filename
          })
        } catch (err: any) {
          resolve({ success: false, error: 'Failed to save screenshot: ' + err.message })
        }
      })
    })
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
