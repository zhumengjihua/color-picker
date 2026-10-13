import { app, BrowserWindow, dialog, ipcMain, net } from 'electron'
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { homedir } from 'os'
import { delimiter, dirname, join, resolve, sep } from 'path'
import { inflateRawSync } from 'zlib'

/**
 * adb 查找顺序：
 * 1. 设置中手动指定的路径
 * 2. ANDROID_SDK_ROOT / ANDROID_HOME（当前进程与登录 shell）
 * 3. PATH（登录 shell 与当前进程）
 * 4. Android Studio 默认 SDK 目录、Homebrew 固定路径
 * 5. 本应用下载到 userData 的 platform-tools
 * 都找不到时由界面询问用户是否下载。
 */

export type AdbSource = 'custom' | 'env' | 'path' | 'android-studio' | 'homebrew' | 'downloaded'

export interface AdbLocation {
  path: string
  source: AdbSource
}

export interface AdbStatus {
  location: AdbLocation | null
  version: string | null
  customPath: string | null
  customPathValid: boolean
  downloadedPath: string | null
}

export interface AdbDownloadProgress {
  phase: 'manifest' | 'download' | 'verify' | 'extract'
  received?: number
  total?: number
}

interface AdbSettings {
  customPath?: string | null
}

interface ArchiveInfo {
  url: string
  sha1: string | null
  size: number | null
  version: string | null
}

const ADB_NAME = process.platform === 'win32' ? 'adb.exe' : 'adb'
const REPO_BASE = 'https://dl.google.com/android/repository/'
const MANIFEST_HOST_OS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'macosx',
  win32: 'windows',
  linux: 'linux'
}
const LATEST_ZIP_SUFFIX: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'darwin',
  win32: 'windows',
  linux: 'linux'
}

/* ---------------- 设置 ---------------- */

function settingsFile(): string {
  return join(app.getPath('userData'), 'adb-settings.json')
}

function readSettings(): AdbSettings {
  try {
    return JSON.parse(readFileSync(settingsFile(), 'utf8')) as AdbSettings
  } catch {
    return {}
  }
}

function writeSettings(settings: AdbSettings): void {
  mkdirSync(dirname(settingsFile()), { recursive: true })
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2))
}

/* ---------------- 查找 ---------------- */

function isExecutableFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false
    if (process.platform !== 'win32') accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function downloadRoot(): string {
  return join(app.getPath('userData'), 'adb')
}

function downloadedAdbPath(): string {
  return join(downloadRoot(), 'platform-tools', ADB_NAME)
}

let shellEnvPromise: Promise<Record<string, string>> | null = null

/**
 * 从 Finder / Dock 启动的应用拿不到 .zshrc 等配置里的环境变量，
 * 这里启动一次登录交互 shell 读取真实环境，结果缓存到下次重新检测。
 */
function loadShellEnv(): Promise<Record<string, string>> {
  if (process.platform === 'win32') return Promise.resolve({})
  if (!shellEnvPromise) {
    shellEnvPromise = new Promise((resolvePromise) => {
      const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
      const marker = '__COLOR_PICKER_SHELL_ENV__'
      execFile(
        shell,
        ['-ilc', `echo ${marker}; env; echo ${marker}`],
        {
          timeout: 5000,
          maxBuffer: 1024 * 1024,
          // 避免 oh-my-zsh 自动更新、tmux 自动启动等阻塞
          env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTART: 'false' }
        },
        (_error, stdout) => {
          const parts = String(stdout ?? '').split(marker)
          const env: Record<string, string> = {}
          if (parts.length >= 3) {
            for (const line of parts[1].split('\n')) {
              const index = line.indexOf('=')
              if (index > 0) env[line.slice(0, index)] = line.slice(index + 1)
            }
          } else {
            console.warn('Failed to read login shell environment')
          }
          resolvePromise(env)
        }
      )
    })
  }
  return shellEnvPromise
}

export async function findAdb(): Promise<AdbLocation | null> {
  const shellEnv = await loadShellEnv()
  const home = homedir()
  const candidates: AdbLocation[] = []

  const customPath = readSettings().customPath
  if (customPath) candidates.push({ path: customPath, source: 'custom' })

  const sdkRoots = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    shellEnv.ANDROID_SDK_ROOT,
    shellEnv.ANDROID_HOME
  ]
  for (const sdkRoot of sdkRoots) {
    if (sdkRoot) candidates.push({ path: join(sdkRoot, 'platform-tools', ADB_NAME), source: 'env' })
  }

  const pathDirs = [
    ...(shellEnv.PATH ?? '').split(delimiter),
    ...(process.env.PATH ?? '').split(delimiter)
  ]
  for (const dir of pathDirs) {
    if (dir) candidates.push({ path: join(dir, ADB_NAME), source: 'path' })
  }

  const androidStudioSdk =
    process.platform === 'darwin'
      ? join(home, 'Library', 'Android', 'sdk')
      : process.platform === 'win32'
        ? process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk')
        : join(home, 'Android', 'Sdk')
  if (androidStudioSdk) {
    candidates.push({
      path: join(androidStudioSdk, 'platform-tools', ADB_NAME),
      source: 'android-studio'
    })
  }

  if (process.platform === 'darwin') {
    candidates.push({ path: '/opt/homebrew/bin/adb', source: 'homebrew' })
    candidates.push({ path: '/usr/local/bin/adb', source: 'homebrew' })
  }

  candidates.push({ path: downloadedAdbPath(), source: 'downloaded' })

  return candidates.find((candidate) => isExecutableFile(candidate.path)) ?? null
}

function getAdbVersion(adbPath: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(adbPath, ['version'], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        resolvePromise(null)
        return
      }
      const output = String(stdout)
      // 例："Version 35.0.2-12147458"（platform-tools 版本），旧版只有 "Android Debug Bridge version 1.0.41"
      const version =
        output.match(/^Version\s+(\S+)/m)?.[1] ??
        output.match(/Android Debug Bridge version\s+(\S+)/)?.[1] ??
        null
      resolvePromise(version)
    })
  })
}

export async function getAdbStatus(refresh = false): Promise<AdbStatus> {
  if (refresh) shellEnvPromise = null
  const location = await findAdb()
  const customPath = readSettings().customPath ?? null
  return {
    location,
    version: location ? await getAdbVersion(location.path) : null,
    customPath,
    customPathValid: customPath ? isExecutableFile(customPath) : false,
    downloadedPath: isExecutableFile(downloadedAdbPath()) ? downloadedAdbPath() : null
  }
}

/* ---------------- 下载 ---------------- */

function parseManifest(xml: string, hostOs: string): ArchiveInfo | null {
  const blocks = xml.match(/<remotePackage\s+path="platform-tools"[\s\S]*?<\/remotePackage>/g) ?? []
  // channel-0 为稳定版
  const block = blocks.find((item) => /<channelRef\s+ref="channel-0"\s*\/>/.test(item)) ?? blocks[0]
  if (!block) return null

  const revision = block.match(/<revision>([\s\S]*?)<\/revision>/)?.[1] ?? ''
  const versionParts = ['major', 'minor', 'micro']
    .map((name) => revision.match(new RegExp(`<${name}>(\\d+)</${name}>`))?.[1])
    .filter((part): part is string => part !== undefined)
  const version = versionParts.length > 0 ? versionParts.join('.') : null

  for (const archive of block.match(/<archive>[\s\S]*?<\/archive>/g) ?? []) {
    if (archive.match(/<host-os>\s*([\w-]+)\s*<\/host-os>/)?.[1] !== hostOs) continue
    const url = archive.match(/<url>\s*([^<\s]+)\s*<\/url>/)?.[1]
    if (!url) continue
    const sha1 =
      archive
        .match(/<checksum(?:\s+type="sha1")?\s*>\s*([0-9a-fA-F]{40})\s*<\/checksum>/)?.[1]
        ?.toLowerCase() ?? null
    const size = Number(archive.match(/<size>\s*(\d+)\s*<\/size>/)?.[1]) || null
    return { url: /^https?:\/\//.test(url) ? url : REPO_BASE + url, sha1, size, version }
  }
  return null
}

async function resolveArchive(): Promise<ArchiveInfo> {
  const hostOs = MANIFEST_HOST_OS[process.platform]
  const latestSuffix = LATEST_ZIP_SUFFIX[process.platform]
  if (!hostOs || !latestSuffix) throw new Error(`Unsupported platform: ${process.platform}`)

  try {
    const response = await net.fetch(REPO_BASE + 'repository2-3.xml')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const info = parseManifest(await response.text(), hostOs)
    if (info) return info
    console.warn('platform-tools not found in SDK manifest, falling back to latest zip')
  } catch (err) {
    console.warn('Failed to read SDK manifest, falling back to latest zip:', err)
  }

  // 清单不可用时退回固定的 latest 地址（无法校验 SHA1）
  return {
    url: `${REPO_BASE}platform-tools-latest-${latestSuffix}.zip`,
    sha1: null,
    size: null,
    version: null
  }
}

async function downloadBuffer(
  url: string,
  expectedSize: number | null,
  onProgress: (progress: AdbDownloadProgress) => void
): Promise<Buffer> {
  // net.fetch 走 Chromium 网络栈，会使用系统代理设置
  const response = await net.fetch(url)
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)

  const total = Number(response.headers.get('content-length')) || expectedSize || 0
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let received = 0
  let lastReport = 0

  onProgress({ phase: 'download', received, total })
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(Buffer.from(value))
    received += value.length
    const now = Date.now()
    if (now - lastReport > 100) {
      lastReport = now
      onProgress({ phase: 'download', received, total })
    }
  }
  onProgress({ phase: 'download', received, total })
  return Buffer.concat(chunks)
}

/** 最小 ZIP 解压实现（store / deflate，不支持 ZIP64 与加密），避免为此新增依赖。 */
function extractZip(zip: Buffer, destDir: string): void {
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Invalid zip file')

  const entryCount = zip.readUInt16LE(eocd + 10)
  let offset = zip.readUInt32LE(eocd + 16)
  if (entryCount === 0xffff || offset === 0xffffffff) throw new Error('ZIP64 is not supported')

  const root = resolve(destDir)
  const isInside = (target: string): boolean => target === root || target.startsWith(root + sep)

  for (let n = 0; n < entryCount; n++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid zip central directory')
    const madeBy = zip.readUInt16LE(offset + 4)
    const flags = zip.readUInt16LE(offset + 8)
    const method = zip.readUInt16LE(offset + 10)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const uncompressedSize = zip.readUInt32LE(offset + 24)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const externalAttributes = zip.readUInt32LE(offset + 38)
    const localOffset = zip.readUInt32LE(offset + 42)
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength

    const target = resolve(root, name)
    if (!isInside(target)) throw new Error(`Unsafe zip entry: ${name}`)
    if (name.endsWith('/')) {
      mkdirSync(target, { recursive: true })
      continue
    }
    if (flags & 0x1) throw new Error(`Encrypted zip entry: ${name}`)
    if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Invalid zip local header')

    const dataStart =
      localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28)
    const raw = zip.subarray(dataStart, dataStart + compressedSize)
    let data: Buffer
    if (method === 0) data = raw
    else if (method === 8) data = inflateRawSync(raw)
    else throw new Error(`Unsupported zip compression method ${method}: ${name}`)
    if (data.length !== uncompressedSize) throw new Error(`Corrupted zip entry: ${name}`)

    mkdirSync(dirname(target), { recursive: true })
    // 高 16 位为 Unix 文件模式（仅当压缩包在 Unix 上创建）
    const unixMode = madeBy >> 8 === 3 ? (externalAttributes >>> 16) & 0xffff : 0
    if ((unixMode & 0o170000) === 0o120000) {
      if (process.platform === 'win32') continue
      const linkTarget = data.toString('utf8')
      if (!isInside(resolve(dirname(target), linkTarget))) {
        throw new Error(`Unsafe zip symlink: ${name}`)
      }
      symlinkSync(linkTarget, target)
      continue
    }
    writeFileSync(target, data)
    if (process.platform !== 'win32') chmodSync(target, unixMode & 0o777 || 0o644)
  }
}

let downloadTask: Promise<AdbLocation> | null = null

export function downloadPlatformTools(
  onProgress: (progress: AdbDownloadProgress) => void
): Promise<AdbLocation> {
  if (!downloadTask) {
    downloadTask = runDownload(onProgress).finally(() => {
      downloadTask = null
    })
  }
  return downloadTask
}

async function runDownload(
  onProgress: (progress: AdbDownloadProgress) => void
): Promise<AdbLocation> {
  onProgress({ phase: 'manifest' })
  const archive = await resolveArchive()
  const zip = await downloadBuffer(archive.url, archive.size, onProgress)

  onProgress({ phase: 'verify' })
  if (archive.sha1) {
    const actual = createHash('sha1').update(zip).digest('hex')
    if (actual !== archive.sha1) {
      throw new Error(`SHA1 mismatch (expected ${archive.sha1}, got ${actual})`)
    }
  }

  // 先解压到临时目录，确认 adb 可运行后再替换正式目录，避免中途失败留下损坏的文件
  onProgress({ phase: 'extract' })
  const finalDir = downloadRoot()
  const stagingDir = `${finalDir}.staging`
  rmSync(stagingDir, { recursive: true, force: true })
  try {
    extractZip(zip, stagingDir)
    const stagedAdb = join(stagingDir, 'platform-tools', ADB_NAME)
    if (!existsSync(stagedAdb)) throw new Error('adb not found in downloaded archive')
    if (process.platform !== 'win32') chmodSync(stagedAdb, 0o755)
    if (!(await getAdbVersion(stagedAdb))) throw new Error('Downloaded adb failed to run')

    try {
      rmSync(finalDir, { recursive: true, force: true })
    } catch (err) {
      throw new Error(
        `Failed to replace the previous adb (it may still be running): ${(err as Error).message}`
      )
    }
    renameSync(stagingDir, finalDir)
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }

  return { path: downloadedAdbPath(), source: 'downloaded' }
}

/* ---------------- IPC ---------------- */

export function registerAdbIpcHandlers(): void {
  // 启动时预热登录 shell 环境，首次截图不必等待
  void loadShellEnv()

  ipcMain.handle('adb-get-status', (_event, refresh?: boolean) => getAdbStatus(Boolean(refresh)))

  ipcMain.handle('adb-set-custom-path', async (_event, customPath: string | null) => {
    if (customPath && !isExecutableFile(customPath)) {
      return { success: false, error: 'INVALID_PATH' }
    }
    writeSettings({ ...readSettings(), customPath: customPath || null })
    return { success: true, status: await getAdbStatus() }
  })

  ipcMain.handle('adb-choose-custom-path', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      // ~/Library 等目录默认隐藏
      properties: ['openFile', 'showHiddenFiles'],
      filters: process.platform === 'win32' ? [{ name: 'adb', extensions: ['exe'] }] : undefined
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }

    const customPath = result.filePaths[0]
    if (!isExecutableFile(customPath)) return { success: false, error: 'INVALID_PATH' }
    writeSettings({ ...readSettings(), customPath })
    return { success: true, status: await getAdbStatus() }
  })

  ipcMain.handle('adb-download', async (event) => {
    try {
      const location = await downloadPlatformTools((progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('adb-download-progress', progress)
      })
      return { success: true, location }
    } catch (err) {
      console.error('Failed to download platform-tools:', err)
      return { success: false, error: (err as Error).message }
    }
  })
}
