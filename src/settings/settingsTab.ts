import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type BaiduSyncPlugin from "../main";
import { BaiduSyncSettings } from "./settings";

export class BaiduSyncSettingTab extends PluginSettingTab {
  plugin: BaiduSyncPlugin;

  constructor(app: App, plugin: BaiduSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "百度网盘同步设置" });

    // Section 1: Authentication
    containerEl.createEl("h3", { text: "1. 百度网盘账号授权 (OAuth 2.0)" });

    const authDesc = containerEl.createDiv({ cls: "setting-item-description" });
    authDesc.innerHTML = `
      1. 访问 <a href="https://pan.baidu.com/union" target="_blank">百度网盘开放平台</a> 登录并创建个人开发者应用。<br>
      2. 获取应用的 <b>AppKey</b> 与 <b>AppSecret</b> 并填入下方。<br>
      3. 点击“获取网页授权码”，在弹出的页面登录并授权，将网页返回的授权码粘贴至下方换取 Token。
    `;

    new Setting(containerEl)
      .setName("AppKey (Client ID)")
      .setDesc("开放平台应用凭证 AppKey")
      .addText((text) =>
        text
          .setPlaceholder("请输入 AppKey")
          .setValue(this.plugin.settings.appKey)
          .onChange(async (value) => {
            this.plugin.settings.appKey = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("AppSecret (Client Secret)")
      .setDesc("开放平台应用密钥 AppSecret")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("请输入 AppSecret")
          .setValue(this.plugin.settings.appSecret)
          .onChange(async (value) => {
            this.plugin.settings.appSecret = value.trim();
            await this.plugin.saveSettings();
          });
      });

    let authCodeInput = "";
    new Setting(containerEl)
      .setName("获取授权并换取 Token")
      .setDesc(
        this.plugin.settings.accessToken
          ? "✅ 已授权网盘账号"
          : "⚠️ 尚未绑定百度网盘"
      )
      .addButton((btn) =>
        btn.setButtonText("第一步：打开授权网页").onClick(() => {
          try {
            const url = this.plugin.oauth.getOAuthUrl();
            window.open(url);
            new Notice("请在浏览器完成授权，并复制网页中的授权码！");
          } catch (err: any) {
            new Notice(err.message || "请先填写 AppKey");
          }
        })
      );

    new Setting(containerEl)
      .setName("填入授权码 (Authorization Code)")
      .setDesc("将网页中获取的 Code 粘贴在此处换取持久凭据")
      .addText((text) =>
        text
          .setPlaceholder("粘贴授权码...")
          .onChange((value) => {
            authCodeInput = value.trim();
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("第二步：确认换取 Token")
          .setCta()
          .onClick(async () => {
            if (!authCodeInput) {
              new Notice("请先输入网页返回的授权码");
              return;
            }
            try {
              btn.setDisabled(true);
              btn.setButtonText("正在换取...");
              await this.plugin.oauth.exchangeCodeForToken(authCodeInput);
              new Notice("🎉 百度网盘账号绑定成功！");
              this.display(); // Refresh tab view
            } catch (err: any) {
              new Notice(`绑定失败: ${err.message}`);
            } finally {
              btn.setDisabled(false);
              btn.setButtonText("第二步：确认换取 Token");
            }
          })
      );

    // Section 2: Storage Path
    containerEl.createEl("h3", { text: "2. 存储与目录规划" });

    new Setting(containerEl)
      .setName("网盘端根目录")
      .setDesc("网盘中存放此知识库的绝对路径 (默认: /apps/obsidian_vault)")
      .addText((text) =>
        text
          .setPlaceholder("/apps/obsidian_vault")
          .setValue(this.plugin.settings.remoteBasePath)
          .onChange(async (val) => {
            this.plugin.settings.remoteBasePath = val.trim();
            await this.plugin.saveSettings();
          })
      );

    // Section 3: Scope and Filtering
    containerEl.createEl("h3", { text: "3. 配置同步与文件过滤" });

    new Setting(containerEl)
      .setName("同步 .obsidian 配置目录")
      .setDesc("开启后将同步 Obsidian 的插件、外观与全局配置（自动排除 workspace.json 布局缓存）")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncObsidianConfig)
          .onChange(async (val) => {
            this.plugin.settings.syncObsidianConfig = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("同步第三方插件 (.obsidian/plugins)")
      .setDesc("开启后将在多端同步已安装的社区插件")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncPlugins)
          .onChange(async (val) => {
            this.plugin.settings.syncPlugins = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("同步外观与主题 (.obsidian/themes)")
      .setDesc("开启后同步已下载的主题与 CSS 片段")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncThemes)
          .onChange(async (val) => {
            this.plugin.settings.syncThemes = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("排除规则 (Ignored Patterns)")
      .setDesc("每行一条 Glob 匹配规则，匹配的文件将完全不参与同步")
      .addTextArea((area) => {
        area.inputEl.rows = 6;
        area.inputEl.style.width = "100%";
        area
          .setValue(this.plugin.settings.ignoredPatterns)
          .onChange(async (val) => {
            this.plugin.settings.ignoredPatterns = val;
            await this.plugin.saveSettings();
          });
      });

    // Section 4: Trigger Settings
    containerEl.createEl("h3", { text: "4. 同步触发机制" });

    new Setting(containerEl)
      .setName("启动时自动同步")
      .setDesc("打开 Obsidian 时自动在后台执行一次静默同步")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncOnStartup)
          .onChange(async (val) => {
            this.plugin.settings.syncOnStartup = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("定时自动同步周期 (分钟)")
      .setDesc("设定后台定时静默同步的时间间隔，设为 0 则禁用定时同步")
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (val) => {
            const num = parseInt(val, 10);
            this.plugin.settings.syncIntervalMinutes = isNaN(num) ? 0 : Math.max(0, num);
            await this.plugin.saveSettings();
            this.plugin.resetInterval();
          })
      );

    new Setting(containerEl)
      .setName("保存/修改后防抖自动同步")
      .setDesc("文件保存或编辑停止一段时间后自动触发同步")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncOnSave)
          .onChange(async (val) => {
            this.plugin.settings.syncOnSave = val;
            await this.plugin.saveSettings();
          })
      );

    // Section 5: Concurrency & Performance
    containerEl.createEl("h3", { text: "5. 传输调度与网络并发" });

    new Setting(containerEl)
      .setName("并发传输请求数 (1~5)")
      .setDesc("同时上传/下载的任务数，推荐设为 2~3 避免触发百度网盘 QPS 频率限制")
      .addSlider((slider) =>
        slider
          .setLimits(1, 5, 1)
          .setValue(this.plugin.settings.concurrency)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.concurrency = val;
            await this.plugin.saveSettings();
          })
      );

    // Section 6: End-to-End Encryption
    containerEl.createEl("h3", { text: "6. 端到端隐私加密 (E2EE)" });

    new Setting(containerEl)
      .setName("开启 AES-256-GCM 端到端加密")
      .setDesc("开启后所有文件在上传到百度网盘前均会进行高强度加密，网盘端无法查看明文。注意：多端同步必须配置完全相同的密码！")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableE2EE)
          .onChange(async (val) => {
            this.plugin.settings.enableE2EE = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("E2EE 解密与加密密码")
      .setDesc("用于生成派生秘钥的主密码")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("请输入加密密码")
          .setValue(this.plugin.settings.e2eePassword)
          .onChange(async (val) => {
            this.plugin.settings.e2eePassword = val;
            await this.plugin.saveSettings();
          });
      });
  }
}
