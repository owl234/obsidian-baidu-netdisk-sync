# Obsidian 百度网盘全平台同步插件 (Baidu Netdisk Sync)

面向 Obsidian 的跨平台百度网盘全量/增量双向同步插件，支持 macOS、Windows、Linux、iOS 与 Android 全终端。

---

## 🌟 核心特性

- 📱 **全平台兼容 (Cross-Platform)**：采用纯 TypeScript + Obsidian 官方 API (`app.vault.adapter` 与 `requestUrl`) 开发，无 Node.js 原生底层依赖，全端无缝运行。
- 🔐 **官方 OpenAPI 规范接入**：基于百度网盘开放平台 OAuth 2.0 授权机制，支持一键打开网页授权码 (OOB) 交互，Token 自动保活与静默刷新。
- ⚡ **智能切片与极速秒传**：严格适配百度 PCS 协议，大文件 4MB 动态切片上传、断点续传，命中云端特征时自动触发极速秒传。
- ⏱️ **LWW 冲突仲裁 (Last-Write-Wins)**：3-Way 差异规划引擎，两端并发修改时以最新修改时间戳为准自动覆盖，保障版本收敛一致性。
- 🛡️ **双向安全删除 (Trash Protection)**：本地删除移入 Obsidian 回收站 (`.trash`)，云端删除移入网盘回收站，彻底杜绝误删丢弃。
- 🧩 **配置选择性同步**：支持同步 `.obsidian/` 下的插件与主题外观，默认严格排除 `workspace.json` 等设备专用布局缓存。
- 🔒 **可选端到端加密 (E2EE)**：支持 AES-256-GCM 高强度端到端加密，开启后网盘端仅存储密文，零知识保护隐私。
- 🚀 **丰富触发矩阵**：支持侧边栏图标点击、状态栏点击、命令面板快捷键、Obsidian 启动自动同步、定时轮询以及文件保存防抖自动同步。

---

## 🛠️ 安装方法

### 手动安装
1. 下载或构建生成的 3 个核心产物文件：
   - `main.js`
   - `manifest.json`
   - `styles.css`
2. 进入你的 Obsidian 知识库目录，打开 `.obsidian/plugins/`。
3. 创建文件夹 `obsidian-baidu-netdisk-sync`，将上述 3 个文件复制到该文件夹中。
4. 打开 Obsidian 设置 -> **第三方插件 (Community plugins)** -> 刷新并启用 **Baidu Netdisk Sync**。

---

## 🔑 百度网盘开放平台接入配置指南

由于插件为纯客户端本地运行，为了保证接口配额独立与隐私安全，推荐使用个人的开发者凭证：

1. 登录 [百度网盘开放平台 (pan.baidu.com/union)](https://pan.baidu.com/union)。
2. 进入 **开发者管理中心** -> 创建应用（分类可选择“其他”或“软件”，应用权限默认勾选网盘基础功能即可）。
3. 创建成功后，获取该应用的 **AppKey (Client ID)** 与 **AppSecret (Client Secret)**。
4. 打开 Obsidian -> 设置 -> **百度网盘同步设置**：
   - 填入 **AppKey** 与 **AppSecret**。
   - 点击 **第一步：打开授权网页**，在浏览器中登录网盘并同意授权。
   - 页面会显示一串授权码（Authorization Code），复制该授权码。
   - 回到 Obsidian 设置面板，将授权码粘贴到输入框中，点击 **第二步：确认换取 Token**。
   - 提示绑定成功后，即可开启双向同步！

---

## ⚙️ 进阶配置说明

- **网盘端根目录**：默认存放在 `/apps/obsidian_vault`（百度网盘 OpenAPI 授权目录位于 `/apps/<应用名>/` 下）。
- **同步 .obsidian 配置**：
  - 勾选后可同步插件与主题样式。
  - 插件内置硬规则过滤 `workspace*.json`、`cache/` 等瞬态文件，防止多端窗口坐标冲突。
- **定时同步周期**：可设置每 N 分钟自动静默同步一次（设为 0 即禁用后台轮询）。
- **并发请求数**：默认限制为 3，有效防止并发超限触发网盘 QPS 频率拦截。
- **端到端加密 (E2EE)**：
  - 开启后输入自定义主密码。
  - 所有文件（文本、图片、PDF 等）在上传前均会被派生密钥加密。
  - 注意：在其他设备同步时，必须配置**完全相同的加密密码**方可正常解密。

---

## 💻 本地开发与构建

```bash
# 1. 安装依赖
npm install

# 2. 运行自动化单元测试 (MD5、过滤规则、3-Way Diff LWW 裁决)
npm test

# 3. 生产环境构建打包 (输出 main.js)
npm run build

# 4. 开发监听模式
npm run dev
```

---

## 📄 许可证

[MIT License](LICENSE)
