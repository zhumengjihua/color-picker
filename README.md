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
- 通过 ADB 获取 Android 设备截图
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
~/Pictures/colorpicker/
```

使用此功能前，请安装 Android SDK Platform-Tools，并确保以下命令能够识别设备：

```bash
adb devices
```

应用会优先从 `ANDROID_SDK_ROOT`、`ANDROID_HOME` 和常见 SDK 安装目录查找 ADB。

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

- macOS：支持方向键同步移动系统光标；开发模式会尝试使用 Swift 编译辅助程序。
- Windows / Linux：可以取色和使用方向键调整像素位置，但不会移动系统光标。
- ADB 截图依赖本机安装的 Android SDK Platform-Tools 和已授权的设备连接。

## 许可证

本项目使用 [MIT License](./LICENSE)。
