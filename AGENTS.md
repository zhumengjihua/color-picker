# AGENTS.md

## 项目概览

这是一个 Electron + Vue 3 + TypeScript 图片取色工具。界面文案支持中英文，但项目文档和协作说明使用中文。

## 目录职责

- `src/main/`：Electron 主进程、原生文件操作、ADB 和 macOS 光标控制。
- `src/preload/`：只放主进程与渲染进程之间的桥接接口。
- `src/renderer/src/`：Vue 界面、取色逻辑、样式和国际化资源。
- `resources/`、`build/`：运行时资源和打包资源。

## 开发约定

- 使用 TypeScript、Vue Composition API 和现有代码风格。
- 涉及文件系统、剪贴板、对话框或外部命令的逻辑放在主进程，通过 IPC 调用。
- 新增界面文案时，同时更新 `zh-CN.ts` 和 `en-US.ts`。
- 不提交 `node_modules/`、`out/`、`dist/` 或调试日志。
- 保留用户已有改动，不做与任务无关的重构。

## 常用命令

```bash
pnpm install
pnpm dev
pnpm lint
pnpm typecheck
pnpm build
```

## 交付前检查

至少运行 `pnpm lint` 和 `pnpm typecheck`。修改构建、主进程或打包配置时，再运行 `pnpm build`。涉及 ADB、文件保存或 macOS 光标控制的功能还需在对应平台手动验证。
