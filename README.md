# Baidu Netdisk Sync (百度网盘多端同步)

[![Obsidian Plugin](https://img.shields.io/badge/Obsidian-Community%20Plugin-7C3AED?logo=obsidian&logoColor=white)](https://obsidian.md/plugins?id=baidu-netdisk-sync)
[![Cost](https://img.shields.io/badge/Cost-100%25%20Free%20%2F%200%E5%85%83-brightgreen)](https://github.com/owl234/obsidian-baidu-netdisk-sync)
[![Platforms](https://img.shields.io/badge/Platforms-iOS%20%7C%20Android%20%7C%20macOS%20%7C%20Windows%20%7C%20Linux-blue)](https://github.com/owl234/obsidian-baidu-netdisk-sync)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A 100% free, cross-platform bi-directional synchronization plugin for Obsidian via Baidu Netdisk, seamlessly connecting your vaults across iOS, Android, macOS, Windows, and Linux.**

**专为 Obsidian 打造的 100% 免费、全平台多设备双向同步插件。依托百度网盘超大容量与国内高速直连，无缝打通 iOS、Android、macOS、Windows 与 Linux。**

[English](#english) | [中文说明](#中文说明)

---

## 中文说明

### 💡 为什么选择百度网盘同步？

1. **💰 100% 免费，零服务器与流量成本**
   - 告别高昂的商业同步按月/按年订阅费用。
   - 无需租用 VPS、无需自建 NAS、无需采购对象存储（S3/OSS/COS）及承担流出流量费。普通百度网盘账号即可坐拥数百 GB 至数 TB 免费空间。
2. **📱 真正的全平台覆盖与移动端友好**
   - 完美适配 **iOS (iPhone/iPad)、Android 手机/平板、macOS、Windows 和 Linux**。
   - 彻底摆脱第三方海外 WebDAV 线路受阻、网络抖动、单月上传流量限额以及移动端 Git 操作门槛高的难题。
3. **⚡ 独创一键跨端配置迁移 (Multi-Device Fast Pairing)**
   - 仅需在电脑端完成一次百度网盘授权，点击即可生成受 **AES-256-GCM 密码保护的配对码**。
   - 手机/平板端一键粘贴导入，无需在移动端重复申请开发者账号或跳转浏览器授权，秒级完成多端组网。
4. **🔒 工业级端到端加密 (E2EE)**
   - 具备可选的零知识加密机制（AES-256-GCM + PBKDF2）。文件在离开本地前完成加密，网盘端仅存放密文，兼顾网盘便捷性与笔记隐私安全。

---

### 🌟 核心特性

- 📱 **全平台兼容 (Cross-Platform)**：纯 TypeScript + Obsidian 官方跨平台 API 打造，无 Node.js 底层依赖，桌面与移动端体验丝滑如一。
- ⚡ **智能切片与极速秒传**：严格遵循百度 PCS 规范，大文件 4MB 动态切片断点续传；命中网盘云端指纹时瞬间完成极速秒传。
- ⏱️ **LWW 冲突仲裁 (Last-Write-Wins)**：内置 3-Way 差异规划引擎，多设备并发编辑冲突时自动依据最新时间戳收敛一致，并保留历史安全底线。
- 🛡️ **双向防误删保护 (Dual Trash)**：本地删除同步进入 Obsidian 知识库回收站 (`.trash`)，云端删除进入百度网盘回收站，杜绝误操作丢失资产。
- 🧩 **选择性配置同步**：支持自由选择同步 `.obsidian/` 下的插件与主题外观，默认精准排除 `workspace*.json` 等设备专用缓存。
- 🚀 **多样触发矩阵**：支持侧边栏图标、状态栏、快捷命令、启动自动同步、定时后台轮询以及编辑保存防抖自动同步。

---

### 📲 多设备快速同步配置指南 (推荐姿势)

只需在首台设备（如电脑）配置一次，后续所有设备（手机/平板/办公电脑）均可 10 秒导入！

#### 步骤一：主设备（电脑端）完成基础绑定
1. 在 Obsidian 社区插件市场搜索并安装 **Baidu Netdisk Sync**；
2. 登录 [百度网盘开放平台 (pan.baidu.com/union)](https://pan.baidu.com/union)，在管理中心创建个人应用（获取 `AppKey` 与 `AppSecret`）；
3. 在插件设置中填入 Key 与 Secret，点击打开授权页换取 Token。

#### 步骤二：一键迁移到手机 / 平板 / 第二台设备
1. 在电脑端插件设置中，找到 **“2. 多设备快速配对与配置迁移”**；
2. 点击 **“📤 导出配置至其他设备”**，输入临时配对密码，点击生成并复制加密配对码；
3. 打开手机/平板上的 Obsidian，在社区插件市场安装并启用本插件；
4. 进入插件设置，点击 **“📥 导入外部设备配置”**，粘贴配对码并输入密码，点击应用；
5. **搞定！** 移动端立即连接成功，无需在手机上重复申请应用或登录授权。

---

### 🛠️ 安装方式

#### 方式 1：Obsidian 官方社区插件市场（推荐）
1. 打开 Obsidian -> **设置** -> **第三方插件** -> 关闭“受限模式”；
2. 点击 **社区插件浏览**，在搜索栏输入 `Baidu Netdisk Sync` 或 `百度网盘`；
3. 点击 **安装 (Install)**，安装完成后点击 **启用 (Enable)**。

#### 方式 2：GitHub 手动安装
1. 从 [Latest Releases](https://github.com/owl234/obsidian-baidu-netdisk-sync/releases) 下载 `main.js`、`manifest.json`、`styles.css`；
2. 将文件存入知识库的 `.obsidian/plugins/baidu-netdisk-sync/` 目录下；
3. 在 Obsidian 设置中刷新并启用插件。

---

### 💻 本地构建与测试

```bash
# 安装依赖
npm install

# 运行全套自动化测试（包含 MD5、过滤引擎、LWW仲裁器、多设备加解密迁移）
npm test

# 生产环境编译打包
npm run build
```

---

## English

### 💡 Why Baidu Netdisk Sync?

1. **💰 100% Free, Zero Infrastructure Cost**
   - Say goodbye to expensive cloud sync subscriptions ($4–$10/month).
   - No need to manage rented VPS servers, complex S3 bucket egress fees, or NAS port forwarding. Standard personal Baidu accounts provide massive storage (up to 2TB) at zero monetary cost.
2. **📱 True Cross-Platform, Mobile-First Design**
   - Seamlessly supports **iOS (iPhone/iPad), Android, macOS, Windows, and Linux**.
   - No network throttling or complex mobile Git requirements. Enjoy dependable connectivity and high-speed domestic transfers.
3. **⚡ One-Click Multi-Device Pairing**
   - Authorize once on your PC, then click **Export Configuration** to generate an **AES-256-GCM encrypted pairing code**.
   - Paste into your phone or tablet to link devices in seconds without repeated OAuth log-ins on mobile screens.
4. **🔒 End-to-End Encryption (E2EE)**
   - Optional client-side AES-256-GCM encryption with PBKDF2 key derivation. Your notes and attachments are encrypted before leaving your hardware.

---

### 🌟 Key Features

- 📱 **Cross-Platform**: Developed strictly with pure TypeScript and Obsidian cross-platform APIs (`app.vault.adapter` and `requestUrl`), running smoothly across iOS, Android, and Desktop.
- ⚡ **Chunked Resumable Uploads & Instant Cloud Deduplication**: Implements official Baidu PCS specifications with 4MB slicing and cloud hashing for instant transfer.
- ⏱️ **LWW 3-Way Conflict Arbiter**: Last-Write-Wins logic resolves concurrent edits deterministically across multiple devices.
- 🛡️ **Dual Trash Protection**: Deletions are safeguarded into Obsidian's local `.trash` and Baidu cloud's Recycle Bin.
- 🧩 **Granular Config Sync**: Sync your plugins and CSS themes while excluding transient workspace caches.
- 🚀 **Rich Trigger Options**: Manual icon click, status bar, quick command palette, startup auto-sync, interval polling, and debounced save sync.

---

### 📲 Quick Multi-Device Setup Guide

1. **Primary Device (e.g. Desktop)**:
   - Configure your personal developer AppKey/Secret and complete OAuth in plugin settings.
   - Go to **Section 2: Multi-Device Quick Pairing**, click **Export Configuration**, set a temporary PIN, and copy the pairing code.
2. **Secondary Device (e.g. iPhone, iPad, Android)**:
   - Install **Baidu Netdisk Sync** from the Obsidian Community Store.
   - Open plugin settings -> click **Import Configuration**, paste the code, enter your PIN, and submit.
   - You're instantly connected and ready to sync across all devices!

---

### 🛠️ Installation

#### Option 1: Obsidian Community Plugin Directory (Recommended)
1. Open Obsidian -> **Settings** -> **Community plugins** -> Turn off Restricted mode.
2. Click **Browse** and search for `Baidu Netdisk Sync`.
3. Click **Install**, then **Enable**.

#### Option 2: Manual Installation
1. Download `main.js`, `manifest.json`, and `styles.css` from [Latest Releases](https://github.com/owl234/obsidian-baidu-netdisk-sync/releases).
2. Extract them into your vault at `.obsidian/plugins/baidu-netdisk-sync/`.
3. Reload community plugins and enable **Baidu Netdisk Sync**.

---

## 📄 License

[MIT License](LICENSE)
