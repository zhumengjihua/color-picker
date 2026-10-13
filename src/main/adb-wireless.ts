import { ipcMain, type WebContents } from 'electron'
import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { findAdb } from './adb'

/**
 * Android 11+ 无线调试：设备列表、二维码配对、配对码配对和连接。
 *
 * 二维码配对流程（与 Android Studio 相同）：
 * 1. 生成随机服务名和密码，二维码内容为 WIFI:T:ADB;S:<服务名>;P:<密码>;;
 * 2. 手机扫码后在局域网通过 mDNS 广播同名的 _adb-tls-pairing._tcp 服务
 * 3. 轮询 `adb mdns services` 找到该服务地址，执行 `adb pair`
 * 4. 配对后 adb 通常会经 mDNS 自动连接；未自动连接时查找 _adb-tls-connect 服务并 `adb connect`
 */

export interface AdbDevice {
  serial: string
  state: string
  model: string | null
  wireless: boolean
}

export type AdbPairingPhase =
  | 'waiting'
  | 'pairing'
  | 'connecting'
  | 'connected'
  | 'failed'
  | 'timeout'

export interface AdbPairingStatus {
  sessionId: string
  phase: AdbPairingPhase
  device?: string
  error?: string
}

interface MdnsService {
  name: string
  type: string
  address: string
}

class AdbNotFoundError extends Error {
  constructor() {
    super('ADB not found')
  }
}

const QR_WAIT_TIMEOUT = 2 * 60 * 1000
const CONNECT_WAIT_TIMEOUT = 15 * 1000
const ADDRESS_PATTERN = /^[\w.\-[\]:%]+:\d{1,5}$/
const PAIRING_CODE_PATTERN = /^\d{6}$/

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runAdb(args: string[], timeout = 10000): Promise<string> {
  const adb = await findAdb()
  if (!adb) throw new AdbNotFoundError()
  return new Promise((resolve, reject) => {
    execFile(adb.path, args, { timeout }, (error, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`.trim()
      if (error) {
        reject(new Error(output || error.message))
        return
      }
      resolve(String(stdout ?? ''))
    })
  })
}

export async function listDevices(): Promise<AdbDevice[]> {
  const output = await runAdb(['devices', '-l'])
  const devices: AdbDevice[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('List of devices') || trimmed.startsWith('*')) continue
    const [serial, state, ...rest] = trimmed.split(/\s+/)
    if (!serial || !state) continue
    const model = rest.find((item) => item.startsWith('model:'))?.slice('model:'.length)
    devices.push({
      serial,
      state,
      model: model ? model.replace(/_/g, ' ') : null,
      // mDNS 连接的序列号形如 adb-XXXX._adb-tls-connect._tcp，手动连接的形如 192.168.1.5:37123
      wireless: serial.includes('._adb-tls-connect.') || /:\d+$/.test(serial)
    })
  }
  return devices
}

async function listMdnsServices(): Promise<MdnsService[]> {
  const output = await runAdb(['mdns', 'services'])
  const services: MdnsService[] = []
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3 || line.startsWith('List of')) continue
    const address = parts[parts.length - 1]
    if (!ADDRESS_PATTERN.test(address)) continue
    services.push({ name: parts[0], type: parts[1].replace(/\.$/, ''), address })
  }
  return services
}

function hostOf(address: string): string {
  return address.slice(0, address.lastIndexOf(':'))
}

async function pair(address: string, password: string): Promise<string | null> {
  const output = await runAdb(['pair', address, password], 30000)
  if (!/Successfully paired/i.test(output)) throw new Error(output.trim() || 'Pairing failed')
  // 例：Successfully paired to 192.168.1.5:41234 [guid=adb-R58M12345-AbCdEf]
  return output.match(/guid=([^\]\s]+)/)?.[1] ?? null
}

async function connect(address: string): Promise<void> {
  const output = await runAdb(['connect', address], 15000)
  if (!/connected to/i.test(output)) throw new Error(output.trim() || 'Connection failed')
}

function matchesDevice(device: AdbDevice, guid: string | null, host: string): boolean {
  if (device.state !== 'device') return false
  if (guid && device.serial.startsWith(guid)) return true
  return device.serial.includes(':') && hostOf(device.serial) === host
}

/** 配对完成后等待设备出现在 adb devices 中，必要时通过 mDNS 查找连接地址主动连接。 */
async function waitForConnection(
  guid: string | null,
  host: string,
  isCancelled: () => boolean = () => false
): Promise<string | null> {
  const deadline = Date.now() + CONNECT_WAIT_TIMEOUT
  let triedConnect = false
  while (Date.now() < deadline && !isCancelled()) {
    const device = (await listDevices()).find((item) => matchesDevice(item, guid, host))
    if (device) return device.serial

    // 给 adb 几秒自动连接，之后主动连接
    if (!triedConnect && deadline - Date.now() < CONNECT_WAIT_TIMEOUT - 4000) {
      triedConnect = true
      const service = (await listMdnsServices()).find(
        (item) =>
          item.type.startsWith('_adb-tls-connect') &&
          ((guid && item.name === guid) || hostOf(item.address) === host)
      )
      if (service) {
        try {
          await connect(service.address)
        } catch (err) {
          console.warn('adb connect via mDNS failed:', err)
        }
      }
    }
    await sleep(1000)
  }
  return null
}

/* ---------------- 二维码配对 ---------------- */

const qrSessions = new Map<string, { cancelled: boolean }>()

function randomToken(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from(randomBytes(length), (byte) => alphabet[byte % alphabet.length]).join('')
}

function startQrPairing(sender: WebContents): { sessionId: string; qrText: string } {
  const sessionId = randomToken(12)
  const serviceName = `colorpicker-${randomToken(8)}`
  const password = randomToken(12)
  const session = { cancelled: false }
  qrSessions.set(sessionId, session)

  const report = (status: Omit<AdbPairingStatus, 'sessionId'>): void => {
    if (!session.cancelled && !sender.isDestroyed()) {
      sender.send('adb-pairing-status', { sessionId, ...status })
    }
  }

  void (async () => {
    try {
      report({ phase: 'waiting' })
      const deadline = Date.now() + QR_WAIT_TIMEOUT
      let service: MdnsService | undefined
      while (!session.cancelled && Date.now() < deadline) {
        try {
          service = (await listMdnsServices()).find(
            (item) => item.name === serviceName && item.type.startsWith('_adb-tls-pairing')
          )
        } catch (err) {
          // adb 服务刚启动等临时错误时继续轮询
          if (err instanceof AdbNotFoundError) throw err
          console.warn('adb mdns services failed:', err)
        }
        if (service) break
        await sleep(1000)
      }
      if (session.cancelled) return
      if (!service) {
        report({ phase: 'timeout' })
        return
      }

      report({ phase: 'pairing' })
      const guid = await pair(service.address, password)

      report({ phase: 'connecting' })
      const serial = await waitForConnection(guid, hostOf(service.address), () => session.cancelled)
      if (serial) report({ phase: 'connected', device: serial })
      else report({ phase: 'failed', error: 'CONNECT_FAILED' })
    } catch (err) {
      report({
        phase: 'failed',
        error: err instanceof AdbNotFoundError ? 'ADB_NOT_FOUND' : (err as Error).message
      })
    } finally {
      qrSessions.delete(sessionId)
    }
  })()

  return { sessionId, qrText: `WIFI:T:ADB;S:${serviceName};P:${password};;` }
}

/* ---------------- IPC ---------------- */

function errorResult(err: unknown): { success: false; code?: string; error: string } {
  if (err instanceof AdbNotFoundError) {
    return { success: false, code: 'ADB_NOT_FOUND', error: err.message }
  }
  return { success: false, error: (err as Error).message }
}

export function registerAdbWirelessIpcHandlers(): void {
  ipcMain.handle('adb-list-devices', async () => {
    try {
      return { success: true, devices: await listDevices() }
    } catch (err) {
      return errorResult(err)
    }
  })

  ipcMain.handle('adb-qr-start', async (event) => {
    // 先确认 adb 可用，避免二维码显示后才报错
    if (!(await findAdb())) return { success: false, code: 'ADB_NOT_FOUND' }
    return { success: true, ...startQrPairing(event.sender) }
  })

  ipcMain.handle('adb-qr-cancel', (_event, sessionId: string) => {
    const session = qrSessions.get(sessionId)
    if (session) session.cancelled = true
  })

  ipcMain.handle(
    'adb-pair-code',
    async (_event, address: string, code: string, connectAddress?: string) => {
      address = address.trim()
      code = code.trim()
      connectAddress = connectAddress?.trim()
      if (!ADDRESS_PATTERN.test(address)) return { success: false, error: 'INVALID_ADDRESS' }
      if (!PAIRING_CODE_PATTERN.test(code)) return { success: false, error: 'INVALID_CODE' }
      if (connectAddress && !ADDRESS_PATTERN.test(connectAddress)) {
        return { success: false, error: 'INVALID_CONNECT_ADDRESS' }
      }

      try {
        const guid = await pair(address, code)
        if (connectAddress) await connect(connectAddress)
        const serial = await waitForConnection(guid, hostOf(connectAddress || address))
        if (!serial) return { success: false, paired: true, error: 'CONNECT_FAILED' }
        return { success: true, device: serial }
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  ipcMain.handle('adb-connect', async (_event, address: string) => {
    address = address.trim()
    if (!ADDRESS_PATTERN.test(address)) return { success: false, error: 'INVALID_CONNECT_ADDRESS' }
    try {
      await connect(address)
      const serial = await waitForConnection(null, hostOf(address))
      if (!serial) return { success: false, error: 'CONNECT_FAILED' }
      return { success: true, device: serial }
    } catch (err) {
      return errorResult(err)
    }
  })
}
