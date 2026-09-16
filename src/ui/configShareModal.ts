import { App, Modal, Setting, Notice } from "obsidian";
import type BaiduSyncPlugin from "../main";
import { exportEncryptedConfig, importEncryptedConfig } from "../crypto/configShare";

export class ExportConfigModal extends Modal {
  private plugin: BaiduSyncPlugin;
  private pin: string = "";
  private generatedCode: string = "";

  constructor(app: App, plugin: BaiduSyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "📱 导出多设备同步配置" });

    const desc = contentEl.createDiv({ cls: "setting-item-description" });
    desc.style.marginBottom = "16px";
    desc.style.lineHeight = "1.6";
    desc.setText(
      "此功能将生成高强度 AES-256-GCM 加密的配对码（包含网盘授权 Token 及同步配置）。将配对码发送至手机、平板或其他电脑，即可免去重复申请开发者账号与繁琐授权，一键完成多端组网。"
    );

    let codeAreaEl: HTMLTextAreaElement | null = null;
    let copyBtnEl: HTMLButtonElement | null = null;

    new Setting(contentEl)
      .setName("设置配对保护密码 (PIN)")
      .setDesc("用于加密配对码，防止传输中凭证泄露（在目标设备导入时需输入该密码）")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("请输入配对保护密码...");
        if (this.plugin.settings.e2eePassword) {
          text.setValue(this.plugin.settings.e2eePassword);
          this.pin = this.plugin.settings.e2eePassword;
        }
        text.onChange((val) => {
          this.pin = val.trim();
        });
      });

    new Setting(contentEl)
      .addButton((btn) => {
        btn
          .setButtonText("🔐 生成加密配对码")
          .setCta()
          .onClick(async () => {
            if (!this.pin) {
              new Notice("请先设置配对保护密码！");
              return;
            }
            if (!this.plugin.settings.accessToken) {
              new Notice("当前设备尚未绑定网盘账号，请先完成授权！");
              return;
            }

            try {
              btn.setDisabled(true);
              this.generatedCode = await exportEncryptedConfig(this.plugin.settings, this.pin);
              if (codeAreaEl) {
                codeAreaEl.value = this.generatedCode;
              }
              if (copyBtnEl) {
                copyBtnEl.disabled = false;
              }

              // Isolated clipboard write with graceful fallback for mobile WebViews
              try {
                await navigator.clipboard.writeText(this.generatedCode);
                new Notice("✅ 配对码已生成并自动复制到剪贴板！");
              } catch {
                codeAreaEl?.select();
                new Notice("✅ 配对码已生成！(因系统限制自动复制受阻，请长按下方文本框手动复制)");
              }
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              new Notice(`生成失败: ${msg}`);
            } finally {
              btn.setDisabled(false);
            }
          });
      });

    const outputContainer = contentEl.createDiv({ cls: "baidu-sync-export-output" });
    outputContainer.style.marginTop = "16px";

    const textarea = outputContainer.createEl("textarea");
    textarea.rows = 5;
    textarea.style.width = "100%";
    textarea.style.fontFamily = "monospace";
    textarea.style.fontSize = "12px";
    textarea.style.resize = "vertical";
    textarea.style.wordBreak = "break-all";
    textarea.style.whiteSpace = "pre-wrap";
    textarea.placeholder = "点击上方“生成加密配对码”后，配对字符串将显示在此处...";
    textarea.readOnly = true;
    codeAreaEl = textarea;

    new Setting(contentEl)
      .addButton((btn) => {
        copyBtnEl = btn.buttonEl;
        btn.buttonEl.disabled = true;
        btn.setButtonText("📋 再次复制到剪贴板").onClick(async () => {
          if (!this.generatedCode) return;
          try {
            await navigator.clipboard.writeText(this.generatedCode);
            new Notice("✅ 已复制到剪贴板！");
          } catch {
            codeAreaEl?.select();
            new Notice("复制失败，请长按下方文本框手动全选复制！");
          }
        });
      });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export class ImportConfigModal extends Modal {
  private plugin: BaiduSyncPlugin;
  private pairingCode: string = "";
  private pin: string = "";
  private onImportSuccess: () => void;

  constructor(app: App, plugin: BaiduSyncPlugin, onImportSuccess: () => void) {
    super(app);
    this.plugin = plugin;
    this.onImportSuccess = onImportSuccess;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "📲 导入多设备同步配置" });

    const desc = contentEl.createDiv({ cls: "setting-item-description" });
    desc.style.marginBottom = "16px";
    desc.style.lineHeight = "1.6";
    desc.setText(
      "粘贴从已配置设备导出的加密配对码，并输入对应的配对保护密码。导入后当前设备将自动同步网盘授权凭据与同步规则，无需再配置 AppKey 或登录网页。"
    );

    new Setting(contentEl)
      .setName("配对码 (Pairing Code)")
      .setDesc("粘贴以 BDSYNC:v1: 开头的加密配对字符串")
      .addTextArea((area) => {
        area.inputEl.rows = 4;
        area.inputEl.style.width = "100%";
        area.inputEl.style.fontFamily = "monospace";
        area.inputEl.style.fontSize = "12px";
        area.inputEl.style.wordBreak = "break-all";
        area.inputEl.style.whiteSpace = "pre-wrap";
        area.setPlaceholder("BDSYNC:v1:...");
        area.onChange((val) => {
          this.pairingCode = val.trim();
        });
      });

    new Setting(contentEl)
      .setName("配对保护密码 (PIN)")
      .setDesc("导出时设置的保护密码")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("请输入配对保护密码...");
        text.onChange((val) => {
          this.pin = val.trim();
        });
      });

    new Setting(contentEl)
      .addButton((btn) => {
        btn
          .setButtonText("🚀 解密并应用配置")
          .setCta()
          .onClick(async () => {
            if (!this.pairingCode) {
              new Notice("请先粘贴配对码！");
              return;
            }
            if (!this.pin) {
              new Notice("请输入配对保护密码！");
              return;
            }

            try {
              btn.setDisabled(true);
              btn.setButtonText("正在解密与验证...");
              const config = await importEncryptedConfig(this.pairingCode, this.pin);

              // Apply imported config with safe fallbacks to prevent undefined corruption
              if (config.appKey) this.plugin.settings.appKey = config.appKey;
              if (config.appSecret) this.plugin.settings.appSecret = config.appSecret;
              if (config.accessToken) this.plugin.settings.accessToken = config.accessToken;
              if (config.refreshToken) this.plugin.settings.refreshToken = config.refreshToken;
              if (typeof config.tokenExpiresAt === "number") this.plugin.settings.tokenExpiresAt = config.tokenExpiresAt;
              if (config.remoteBasePath) this.plugin.settings.remoteBasePath = config.remoteBasePath;
              if (config.syncObsidianConfig !== undefined) this.plugin.settings.syncObsidianConfig = config.syncObsidianConfig;
              if (config.syncPlugins !== undefined) this.plugin.settings.syncPlugins = config.syncPlugins;
              if (config.syncThemes !== undefined) this.plugin.settings.syncThemes = config.syncThemes;
              if (config.ignoredPatterns !== undefined) this.plugin.settings.ignoredPatterns = config.ignoredPatterns;
              if (typeof config.concurrency === "number") this.plugin.settings.concurrency = config.concurrency;
              if (config.enableE2EE !== undefined) this.plugin.settings.enableE2EE = config.enableE2EE;
              if (config.e2eePassword !== undefined) {
                this.plugin.settings.e2eePassword = config.e2eePassword;
              }

              await this.plugin.saveSettings();
              this.plugin.resetInterval();

              new Notice("🎉 多端同步配置导入成功！已连接百度网盘。");
              this.close();
              this.onImportSuccess();
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              new Notice(`导入失败: ${msg}`);
            } finally {
              btn.setDisabled(false);
              btn.setButtonText("🚀 解密并应用配置");
            }
          });
      });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
