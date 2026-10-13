# 拾色

拾色是一款基于 Electron、Vue 3 和 TypeScript 开发的桌面图片取色工具。它可以同时打开多张图片，查看像素坐标和颜色，并保存常用取色记录；还支持直接抓取已连接 Android 设备的屏幕。

## 功能

- 通过文件选择、拖放或剪贴板粘贴导入图片
- 同时打开多张图片，并通过标签页切换
- 实时显示鼠标所在像素的坐标和颜色
- 使用像素放大镜精确定位目标像素
- 在 HEXA 与 RGBA 格式之间切换
- 点击图片或按回车记录颜色，最多保存 10 条临时记录
- 使用方向键逐像素移动取色位置
- 复制图片、关闭标签页以及重命名图片
- 对本地图片重命名时同步修改磁盘文件
- 将剪贴板图片命名并保存为 PNG、JPEG 或 WebP 文件
- 通过 ADB 获取 Android 设备截图，支持二维码或配对码无线连接手机
- 支持简体中文与英文界面，设置会保存在本机

## 使用方法

### 导入图片

可以使用以下任意方式：

- 点击“打开图片”，或使用 `Command/Ctrl + O`
- 将一张或多张图片拖入窗口
- 复制图片后使用 `Command/Ctrl + V` 粘贴

支持 PNG、JPEG、WebP、BMP 和 GIF 文件。

### 取色与记录

将鼠标移到图片上即可查看像素坐标、放大预览和颜色值。点击右侧颜色值可切换 HEXA 与 RGBA 格式。

- 点击图片：将当前像素加入记录列表
- `Enter`：记录当前像素
- 方向键：逐像素移动取色位置
- 记录列表最多保存 10 条数据，可单独删除或全部清空

HEXA 使用 `#RRGGBBAA` 格式，末尾两位表示透明度。

> 在 macOS 上，方向键移动取色位置时还会同步移动系统鼠标指针。首次使用可能需要授予辅助功能权限。

### 标签页操作

右键点击图片标签页可以打开快捷菜单：

- 关闭当前、关闭其他或关闭全部标签页
- 将当前图片复制到系统剪贴板
- 重命名图片

对磁盘中的图片重命名会直接修改原文件名。粘贴进来的图片没有原始路径，重命名时会打开保存对话框。

### ADB 截图

连接已开启 USB 调试的 Android 设备后，点击“ADB 截图”即可抓取屏幕。截图会自动保存到：

```text
<系统图片目录>/colorpicker/
```

macOS 一般是 `~/Pictures/colorpicker/`；Windows 是“图片”文件夹下的 `colorpicker`，图片文件夹被移到 OneDrive 等位置时跟随移动。

应用按以下顺序查找 adb，使用第一个可执行的：

1. 设置中手动指定的路径
2. `ANDROID_SDK_ROOT` / `ANDROID_HOME`（同时读取登录 shell 中的配置，从 Finder 启动也能生效）
3. `PATH`（登录 shell 与当前进程）
4. Android Studio 默认 SDK 目录，以及 macOS 上的 Homebrew 路径
5. 应用此前下载的 platform-tools

都找不到时，截图会询问是否从 Google 下载 Android SDK Platform-Tools。能取到 Google SDK 仓库清单时会校验下载文件的 SHA1，并保存在应用数据目录（Electron `userData`，macOS 位于 `~/Library/Application Support/` 下）的 `adb/` 中，只供本应用使用。当前使用的 adb、自定义路径和重新下载入口都在设置中。

截图前请确保设备已授权 USB 调试，可用 `adb devices` 确认。

同时连接多台设备时，在工具栏的设备下拉框中选择截图设备，选择会保存在本机。

### 无线连接手机

点击工具栏的“连接手机”（或菜单“文件 → 连接手机”），通过 Android 11 及以上的无线调试连接，手机和电脑需在同一 Wi-Fi：

- **二维码配对**：在手机上打开“开发者选项 → 无线调试 → 使用二维码配对设备”，扫描弹窗中的二维码，配对和连接自动完成。依赖局域网 mDNS 设备发现，部分公司或访客网络会拦截。
- **配对码配对**：在手机上打开“使用配对码配对设备”，填写显示的 IP 地址、端口和 6 位配对码。自动连接失败时，再填写无线调试主页面上的 IP 地址和端口（与配对端口不同）后点“仅连接”。已配对过的手机也可以直接“仅连接”。

## 开发环境

需要安装 Node.js、pnpm，以及对应平台所需的 Electron 构建工具。

```bash
pnpm install
pnpm dev
```

## 常用命令

```bash
# 代码检查
pnpm lint

# TypeScript 类型检查
pnpm typecheck

# 构建应用代码
pnpm build

# 生成未打包目录
pnpm build:unpack

# 生成各平台安装包
pnpm build:mac
pnpm build:win
pnpm build:linux

# 格式化代码
pnpm format
```

构建其他操作系统的安装包时，可能需要在对应系统中执行命令。

## 项目结构

```text
src/
├── main/                 Electron 主进程、文件操作与 ADB 截图
├── preload/              主进程与页面之间的安全桥接
└── renderer/src/         Vue 页面、样式与中英文翻译
resources/                应用图标和 macOS 光标移动辅助程序
build/                    Electron Builder 构建资源
```

## 技术栈

- Electron 39
- Vue 3
- TypeScript
- Vite / electron-vite
- Vue I18n
- Electron Builder

## 平台说明

- macOS：支持方向键同步移动系统光标；开发模式会尝试使用 Swift 编译辅助程序。设置在应用菜单中（`Command + ,`）。
- Windows：支持方向键同步移动系统光标（通过常驻的 PowerShell 进程调用系统接口）。菜单栏默认隐藏，按 `Alt` 显示；设置可从工具栏右侧的齿轮按钮、“文件 → 设置”或 `Ctrl + ,` 打开。
- Linux：可以取色和使用方向键调整像素位置，但不会移动系统光标；设置入口与 Windows 相同。
- ADB 截图需要已授权的设备连接；本机没有 adb 时可在应用内下载 Platform-Tools。

## 许可证

本项目使用 [MIT License](./LICENSE)。
