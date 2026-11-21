# Baidu Netdisk Sync (百度网盘多端同步)

[![Obsidian Plugin](https://img.shields.io/badge/Obsidian-Community%20Plugin-7C3AED?logo=obsidian&logoColor=white)](https://obsidian.md/plugins?id=baidu-netdisk-sync)
[![Cost](https://img.shields.io/badge/Cost-100%25%20Free%20%2F%200%E5%85%83-brightgreen)](https://github.com/owl234/obsidian-baidu-netdisk-sync)
[![Platforms](https://img.shields.io/badge/Platforms-iOS%20%7C%20Android%20%7C%20macOS%20%7C%20Windows%20%7C%20Linux-blue)](https://github.com/owl234/obsidian-baidu-netdisk-sync)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Sponsor on Afdian](https://img.shields.io/badge/Sponsor-%E7%88%B1%E5%8F%91%E7%94%B5%20Afdian-946CE6?logo=lightning&logoColor=white)](https://ifdian.net/a/owl234)
[![Sponsor on Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20Author-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/owl234)

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
   - 内置**可配置单文件体积上限（默认 100 MB）**，避免移动端同步超大附件引发 WebView 内存溢出闪退。
3. **⚡ 独创一键跨端配置迁移 (Multi-Device Fast Pairing)**
   - 仅需在电脑端完成一次百度网盘授权，点击即可生成受 **AES-256-GCM 独立临时密码保护的配对码**。
   - 手机/平板端一键粘贴导入，无需在移动端重复申请开发者账号或跳转浏览器授权，秒级完成多端组网。
4. **🔒 高性能工业级端到端加密 (E2EE v2)**
   - 可选零知识端到端加密（**E2EE v2**：PBKDF2-SHA256 600,000 次会话主密钥内存缓存 + 每文件独立 HKDF-SHA256 密钥 + AES-256-GCM + Header AAD 完整性认证），移动端大库批量加解密速度提升百倍，同时完全向下兼容解密历史 v1（含 10 万次迭代）密文。
   - > ⚠️ **v1.1.0 E2EE 升级提示**：新版本写入采用 E2EE v2 格式（向下完全兼容读取 v1），如已开启端到端加密，请确保**所有同步设备均升级至 v1.1.0 及以上版本**。

---

### 🌟 核心特性

- 📱 **全平台兼容与双语自适应 (Cross-Platform & Bilingual i18n)**：纯 TypeScript + Obsidian 官方跨平台 API 打造，无 Node.js 底层依赖，插件界面自动跟随 Obsidian 系统语言切换中文 / English。
- ⚡ **高速协议调度、真并发与极速秒传**：支持 1~5 路真并发传输、`listall` 递归拉取（带 `list` 自动降级回退）、100 条批量 `filemetas` 与批量删除、4MB 动态切片与 `content-md5`/`slice-md5` 云端秒传，同时具备 64 位 `fs_id` 精度保护与 OAuth 单飞刷新重试。
- 🛡️ **零数据丢失冲突保护 (Conflict Copy + LWW)**：内置 3-Way 差异规划引擎与无清单明文 MD5 去重；多设备并发编辑冲突时**默认自动保留冲突副本**（`*.conflict-YYYYMMDD-HHmmss.*`）防止静默覆盖丢稿，也可按需在设置中切换为 LWW 最新时间覆盖。
- ♻️ **双向防误删保护 (Dual Trash)**：本地删除移入 Obsidian 回收站 (`.trash`)，云端删除进入百度网盘回收站，杜绝误操作丢失资产。
- 🧩 **精细配置同步与过滤**：自由选择同步 `.obsidian/` 下的插件、主题与 CSS 片段 (`snippets/`)，精确排除本插件敏感目录及 `workspace*.json` 设备缓存，不误伤普通笔记。
- 🚀 **多样触发矩阵**：支持侧边栏图标、状态栏、快捷命令、启动自动同步、定时后台轮询，以及覆盖修改/创建/删除/重命名的防抖自动同步（含回写抑制防 ping-pong 循环）。

---

### 📲 多设备快速同步配置指南 (推荐姿势)

只需在首台设备（如电脑）配置一次，后续所有设备（手机/平板/办公电脑）均可 10 秒导入！

#### 步骤一：主设备（电脑端）完成基础绑定
1. 在 Obsidian 社区插件市场搜索并安装 **Baidu Netdisk Sync**；
2. 登录 [百度网盘开放平台 (pan.baidu.com/union)](https://pan.baidu.com/union)，在管理中心创建个人应用（获取 `AppKey` 与 `AppSecret`）；
3. 在插件设置中填入 Key 与 Secret，点击打开授权页换取 Token。

#### 步骤二：一键迁移到手机 / 平板 / 第二台设备
1. 在电脑端插件设置中，找到 **“2. 多设备快速配对与配置迁移”**；
2. 点击 **“导出配置至其他设备”**，设置独立的临时配对密码（PIN），生成并复制加密配对码；
3. 打开手机/平板上的 Obsidian，在社区插件市场安装并启用本插件；
4. 进入插件设置，点击 **“导入外部设备配置”**，粘贴配对码并输入密码，点击应用；
5. **搞定！** 移动端立即连接成功，无需在手机上重复申请应用或登录授权。

---

### 🛠️ 安装方式

#### 方式 1：Obsidian 官方社区插件市场（推荐）
1. 打开 Obsidian -> **设置** -> **第三方插件** -> 关闭“受限模式”；
2. 点击 **社区插件浏览**，在搜索栏输入 `Baidu Netdisk Sync`；
3. 点击 **安装 (Install)**，安装完成后点击 **启用 (Enable)**。

#### 方式 2：GitHub 手动安装
1. 从 [Latest Releases](https://github.com/owl234/obsidian-baidu-netdisk-sync/releases) 下载 `main.js`、`manifest.json`、`styles.css`；
2. 将文件存入知识库的 `.obsidian/plugins/baidu-netdisk-sync/` 目录下；
3. 在 Obsidian 设置中刷新并启用插件。

---

### 💻 本地构建与校验

```bash
# 安装依赖
npm install

# TypeScript 严格类型检查
npm run typecheck

# Obsidian 官方社区插件 ESLint 规范检查
npm run lint

# 运行全套单元与端到端集成测试（MD5、i18n、过滤器、冲突副本、真并发队列、E2EE v2/v1、百度协议、同步引擎）
npm test

# 生产环境编译打包
npm run build
```

---

### ☕ 赞助与支持

本插件坚持 **100% 免费开源（MIT 协议）**，无任何付费墙或功能限制。如果这个插件帮你在手机、平板与电脑间省去了同步烦恼，欢迎自愿请作者喝杯咖啡，助力项目长期维护与迭代：

- ⚡ **[爱发电 Afdian (ifdian.net/a/owl234)](https://ifdian.net/a/owl234)**（国内推荐：支持微信 / 支付宝，可自选金额单次发电）
- ☕ **[Ko-fi (ko-fi.com/owl234)](https://ko-fi.com/owl234)**（海外推荐：支持 PayPal / 国际银行卡，0% 平台抽成）

---

## English

### 💡 Why Baidu Netdisk Sync?

1. **💰 100% Free, Zero Infrastructure Cost**
   - Say goodbye to expensive cloud sync subscriptions ($4–$10/month).
   - No rented VPS servers, complex S3 bucket egress fees, or NAS port forwarding. Standard personal Baidu accounts provide massive storage (up to 2TB) at zero monetary cost.
2. **📱 True Cross-Platform, Mobile-First Design**
   - Seamlessly supports **iOS (iPhone/iPad), Android, macOS, Windows, and Linux**.
   - Built-in **configurable single-file size guard (default 100 MB)** protects mobile WebViews from out-of-memory crashes when vaults contain oversized media files.
3. **⚡ One-Click Multi-Device Pairing**
   - Authorize once on your PC, then click **Export configuration** to generate an **AES-256-GCM encrypted pairing code** protected by a separate temporary PIN.
   - Paste into your phone or tablet to link devices in seconds without repeated OAuth logins on mobile screens.
4. **🔒 High-Performance End-to-End Encryption (E2EE v2)**
   - Optional zero-knowledge client-side encryption (**E2EE v2**: cached PBKDF2-SHA256 600k master key + per-file HKDF-SHA256 AES-256-GCM keys + authenticated 56-byte header AAD), delivering orders-of-magnitude faster mobile batch sync while remaining fully backward-compatible with legacy v1 (600k & 100k) ciphertexts.
   - > ⚠️ **v1.1.0 E2EE upgrade note**: v1.1.0 writes E2EE v2 format (while seamlessly decrypting legacy v1 files). If E2EE is enabled, please **upgrade all synced devices to v1.1.0+** so every device can decrypt newly uploaded files.

---

### 🌟 Key Features

- 📱 **Cross-Platform & Auto Bilingual UI**: Pure TypeScript with Obsidian cross-platform APIs (`app.vault.adapter` & `requestUrl`), automatically adapting UI language between English and Chinese based on Obsidian's locale.
- ⚡ **High-Speed Protocol, True Concurrency & Rapid Upload**: 1–5 concurrent transfer workers, recursive `listall` listing (with automatic `list` BFS fallback), batched `filemetas` & remote deletes (100 items/call), 4MB chunked uploads with `content-md5`/`slice-md5` rapid upload, 64-bit `fs_id` precision safety, and deduplicated OAuth refresh-and-retry.
- 🛡️ **Zero-Data-Loss Conflict Protection**: 3-Way diff planner with manifestless plaintext MD5 deduplication. Concurrent edits **default to preserving conflict backup copies** (`*.conflict-YYYYMMDD-HHmmss.*`), with an option to switch back to Last-Write-Wins (LWW).
- ♻️ **Dual Trash Protection**: Local deletions go to Obsidian's `.trash`; remote deletions go to Baidu Netdisk's Recycle Bin.
- 🧩 **Granular Config Sync**: Selectively sync `.obsidian/` plugins, themes, and CSS `snippets/` while excluding workspace caches and plugin credentials.
- 🚀 **Rich Trigger Options**: Ribbon icon, status bar, command palette, startup sync, periodic polling, and debounced save sync (covering modify, create, delete, and rename with echo suppression).

---

### 📲 Quick Multi-Device Setup Guide

1. **Primary Device (e.g. Desktop)**:
   - Configure your personal developer AppKey/Secret and complete OAuth in plugin settings.
   - Go to **Section 2: Multi-device quick pairing**, click **Export configuration**, set a temporary PIN, and copy the pairing code.
2. **Secondary Device (e.g. iPhone, iPad, Android)**:
   - Install **Baidu Netdisk Sync** from the Obsidian Community Store.
   - Open plugin settings -> click **Import configuration**, paste the code, enter your PIN, and submit.
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

### 💻 Local Development & Verification

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

---

### ☕ Support the Project

This plugin is **100% free and open-source (MIT License)** with no paywalls or subscriptions. If it saves you time syncing across your devices, you can optionally support ongoing maintenance and development:

- ☕ **[Support on Ko-fi (ko-fi.com/owl234)](https://ko-fi.com/owl234)** (PayPal / Card, 0% platform fee)
- ⚡ **[Sponsor on Afdian (ifdian.net/a/owl234)](https://ifdian.net/a/owl234)** (WeChat Pay / Alipay)

---

## 📄 License

[MIT License](LICENSE)
