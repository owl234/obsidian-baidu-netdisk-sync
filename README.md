# Baidu Netdisk Sync

A cross-platform bi-directional synchronization plugin with Baidu Netdisk for your personal vaults, supporting macOS, Windows, Linux, iOS, and Android.

[English](#english) | [中文说明](#中文说明)

---

## English

### 🌟 Key Features

- 📱 **Cross-Platform Compatibility**: Built with pure TypeScript and standard Obsidian APIs (`app.vault.adapter` and `requestUrl`), completely free of Node.js native dependencies, running seamlessly across Desktop (macOS, Windows, Linux) and Mobile (iOS, Android).
- 🔐 **Official OpenAPI Compliance**: Powered by the Baidu Netdisk Open Platform OAuth 2.0 flow, supporting convenient out-of-band (OOB) web authorization code exchange and silent automatic token refresh.
- ⚡ **Resumable Chunked Uploads & Instant Upload**: Slices large files into 4MB chunks per Baidu PCS specifications, supporting interrupted transfer resumption and cloud deduplication instant uploads.
- ⏱️ **Last-Write-Wins (LWW) Conflict Resolution**: 3-Way diff planning engine compares local, remote, and baseline states. Concurrent modifications resolve by latest timestamp to ensure version convergence.
- 🛡️ **Dual Trash Protection**: Local file deletions move to the Obsidian trash (`.trash`), while cloud file deletions move to the Baidu Netdisk cloud recycle bin, preventing accidental permanent data loss.
- 🧩 **Selective Configuration Sync**: Sync installed plugins and appearance themes under `.obsidian/`, while automatically ignoring ephemeral device-specific layout caches like `workspace*.json`.
- 🔒 **Optional End-to-End Encryption (E2EE)**: Protect note privacy with AES-256-GCM authenticated encryption. When enabled, notes and attachments are encrypted before leaving your device.
- 🚀 **Flexible Trigger Modes**: Supports ribbon icon click, status bar interaction, command palette shortcuts, startup auto-sync, periodic background polling, and debounced sync-on-save.

### 🛠️ Installation

1. Download the three release assets from [Latest Releases](https://github.com/owl234/obsidian-baidu-netdisk-sync/releases):
   - `main.js`
   - `manifest.json`
   - `styles.css`
2. In your vault directory, open or create `.obsidian/plugins/baidu-netdisk-sync/`.
3. Place `main.js`, `manifest.json`, and `styles.css` inside this directory.
4. Open Obsidian -> **Settings** -> **Community plugins** -> Reload and enable **Baidu Netdisk Sync**.

### 🔑 Baidu Netdisk Open Platform Setup Guide

To ensure dedicated API quota and personal privacy, configure your personal developer credentials:

1. Log in to the [Baidu Netdisk Open Platform (pan.baidu.com/union)](https://pan.baidu.com/union).
2. Go to **Developer Console** -> **Application Management** -> **Create Application** (Select "Software" or "Tools", default basic netdisk permissions are sufficient).
3. Once created, copy the **AppKey (Client ID)** and **AppSecret (Client Secret)** from the application overview page.
4. In Obsidian, go to **Settings** -> **Baidu Netdisk Sync**:
   - Enter your **AppKey** and **AppSecret**.
   - Click **Step 1: Open Authorization Page** to log in and approve permissions in your browser.
   - Copy the **Authorization Code** shown on the page.
   - Paste it into the plugin settings and click **Step 2: Confirm and Exchange Token**.
   - Once verified, cloud synchronization is ready to use!

### ⚙️ Configuration Notes

- **Remote Base Path**: Default is `/apps/obsidian同步插件` or `/apps/obsidian_vault` (located under `全部文件 > 我的应用数据` in Baidu Netdisk).
- **Configuration Sync**: Toggle whether to sync plugins and themes under `.obsidian/`. Workspace layout caches are automatically excluded.
- **Sync Interval**: Interval in minutes for silent periodic background synchronization (set to `0` to disable).
- **Concurrency**: Number of concurrent slice uploads (default is `3`, avoiding Baidu API QPS rate limits).
- **End-to-End Encryption (E2EE)**: When enabled, enter your master password. All devices syncing this vault must configure the exact same password.

---

## 中文说明

### 🌟 核心特性

- 📱 **全平台兼容 (Cross-Platform)**：采用纯 TypeScript + Obsidian 官方 API (`app.vault.adapter` 与 `requestUrl`) 开发，无 Node.js 原生底层依赖，支持桌面端与 iOS / Android 移动端。
- 🔐 **官方 OpenAPI 规范接入**：基于百度网盘开放平台 OAuth 2.0 授权机制，支持一键打开网页授权码 (OOB) 交互，Token 自动保活与静默刷新。
- ⚡ **智能切片与极速秒传**：严格适配百度 PCS 协议，大文件 4MB 动态切片上传、断点续传，命中云端特征时自动触发极速秒传。
- ⏱️ **LWW 冲突仲裁 (Last-Write-Wins)**：3-Way 差异规划引擎，两端并发修改时以最新修改时间戳为准自动覆盖，保障版本收敛一致性。
- 🛡️ **双向安全删除 (Trash Protection)**：本地删除移入 Obsidian 回收站 (`.trash`)，云端删除移入网盘回收站，彻底杜绝误删丢弃。
- 🧩 **配置选择性同步**：支持同步 `.obsidian/` 下的插件与主题外观，默认严格排除 `workspace.json` 等设备专用布局缓存。
- 🔒 **可选端到端加密 (E2EE)**：支持 AES-256-GCM 高强度端到端加密，开启后网盘端仅存储密文，零知识保护隐私。
- 🚀 **丰富触发矩阵**：支持侧边栏图标点击、状态栏点击、命令面板快捷键、启动自动同步、定时轮询以及文件保存防抖自动同步。

### 🛠️ 安装方法

1. 从 [Releases 页面](https://github.com/owl234/obsidian-baidu-netdisk-sync/releases) 下载 3 个核心产物文件：
   - `main.js`
   - `manifest.json`
   - `styles.css`
2. 进入知识库的 `.obsidian/plugins/` 目录，创建文件夹 `baidu-netdisk-sync`；
3. 将上述 3 个文件复制到该文件夹中；
4. 打开 Obsidian 设置 -> **第三方插件 (Community plugins)** -> 刷新并启用 **Baidu Netdisk Sync**。

### 🔑 百度网盘开放平台接入配置指南

1. 登录 [百度网盘开放平台官网 (pan.baidu.com/union)](https://pan.baidu.com/union)；
2. 进入 **开发者管理中心** -> 创建个人应用（分类选择“软件”或“办公/工具”，勾选基础权限）；
3. 在应用详情页面获取 **AppKey (Client ID)** 与 **AppSecret (Client Secret)**；
4. 打开 Obsidian 设置 -> **百度网盘同步设置**：
   - 填入 **AppKey** 与 **AppSecret**；
   - 点击 **第一步：打开授权网页**，登录网盘并同意授权，复制页面返回的授权码 (Code)；
   - 粘贴授权码，点击 **第二步：确认换取 Token**；
   - 绑定成功后即可开始实时双向同步！

### 💻 本地构建与测试

```bash
# 安装依赖
npm install

# 运行自动化单元测试
npm test

# 构建生产版本 (输出 main.js)
npm run build
```

---

## 📄 License

[MIT License](LICENSE)
