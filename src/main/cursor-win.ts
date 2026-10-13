import { screen } from 'electron'
import { spawn, type ChildProcess } from 'child_process'

/**
 * Windows 下移动系统光标。
 * 常驻一个 PowerShell 进程调用 user32 的 SetCursorPos，避免每次方向键都启动新进程。
 * 脚本通过 -EncodedCommand 传入，标准输入只用于逐行传递坐标。
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace ColorPicker -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
'@
# 设为按显示器感知 DPI，SetCursorPos 才按物理像素定位
try { [ColorPicker.Native]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Split(' ')
  if ($parts.Length -eq 2) { [ColorPicker.Native]::SetCursorPos([int]$parts[0], [int]$parts[1]) | Out-Null }
}
`

let helper: ChildProcess | null = null

function getHelper(): ChildProcess {
  if (helper && helper.exitCode === null && !helper.killed) return helper
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] }
  )
  child.stderr?.on('data', (data) => console.error('cursor helper:', String(data).trim()))
  child.on('error', (err) => console.error('Failed to start cursor helper:', err))
  child.on('exit', () => {
    if (helper === child) helper = null
  })
  helper = child
  return child
}

/** x、y 为屏幕坐标（DIP），内部转换为物理像素。 */
export function moveCursorWindows(x: number, y: number): void {
  const point = screen.dipToScreenPoint({ x, y })
  getHelper().stdin?.write(`${Math.round(point.x)} ${Math.round(point.y)}\n`)
}

export function disposeCursorHelper(): void {
  helper?.kill()
  helper = null
}
