import { App, Modal, Setting, Notice } from "obsidian";
import type BaiduSyncPlugin from "../main";
import { exportEncryptedConfig, importEncryptedConfig } from "../crypto/configShare";
import { clearKeyCache } from "../crypto/e2ee";
import { t } from "../i18n";

export class ExportConfigModal extends Modal {
  private plugin: BaiduSyncPlugin;
  private pin: string = "";
  private generatedCode: string = "";

  constructor(app: App, plugin: BaiduSyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.setTitle(t("modal.export.title"));
    const { contentEl } = this;
    contentEl.empty();

    const desc = contentEl.createDiv({
      cls: "setting-item-description baidu-sync-modal-desc"
    });
    desc.setText(t("modal.export.desc"));

    let codeAreaEl: HTMLTextAreaElement | null = null;
    let copyBtnEl: HTMLButtonElement | null = null;

    new Setting(contentEl)
      .setName(t("modal.export.pinName"))
      .setDesc(t("modal.export.pinDesc"))
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder(t("modal.export.pinPlaceholder"));
        text.onChange((val) => {
          this.pin = val.trim();
        });
      });

    new Setting(contentEl).addButton((btn) => {
      btn
        .setButtonText(t("modal.export.generateBtn"))
        .setCta()
        .onClick(async () => {
          if (!this.pin) {
            new Notice(t("modal.export.missingPinNotice"));
            return;
          }
          if (!this.plugin.settings.accessToken) {
            new Notice(t("modal.export.notAuthorizedNotice"));
            return;
          }

          try {
            btn.setDisabled(true);
            new Notice(t("modal.export.generatingNotice"));
            const code = await exportEncryptedConfig(this.plugin.settings, this.pin);
            this.generatedCode = code;

            if (codeAreaEl) {
              codeAreaEl.value = code;
            }
            if (copyBtnEl) {
              copyBtnEl.disabled = false;
            }

            try {
              await navigator.clipboard.writeText(code);
              new Notice(t("modal.export.copiedNotice"));
            } catch {
              new Notice(t("modal.export.manualCopyNotice"));
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(t("modal.export.failNotice", { msg }));
          } finally {
            btn.setDisabled(false);
          }
        });
    });

    const outputContainer = contentEl.createDiv({ cls: "baidu-sync-export-output" });

    const textarea = outputContainer.createEl("textarea", { cls: "baidu-sync-code-area" });
    textarea.rows = 5;
    textarea.placeholder = t("modal.export.outputPlaceholder");
    textarea.readOnly = true;
    codeAreaEl = textarea;

    new Setting(contentEl).addButton((btn) => {
      copyBtnEl = btn.buttonEl;
      btn.buttonEl.disabled = true;
      btn.setButtonText(t("modal.export.copyBtn")).onClick(async () => {
        if (!this.generatedCode) return;
        try {
          await navigator.clipboard.writeText(this.generatedCode);
          new Notice(t("modal.export.copySuccess"));
        } catch {
          codeAreaEl?.select();
          new Notice(t("modal.export.copyFail"));
        }
      });
    });
  }

  onClose(): void {
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

  onOpen(): void {
    this.setTitle(t("modal.import.title"));
    const { contentEl } = this;
    contentEl.empty();

    const desc = contentEl.createDiv({
      cls: "setting-item-description baidu-sync-modal-desc"
    });
    desc.setText(t("modal.import.desc"));

    new Setting(contentEl)
      .setName(t("modal.import.codeName"))
      .setDesc(t("modal.import.codeDesc"))
      .addTextArea((area) => {
        area.inputEl.rows = 4;
        area.inputEl.addClass("baidu-sync-code-area");
        area.setPlaceholder("BDSYNC:v1:...");
        area.onChange((val) => {
          this.pairingCode = val.trim();
        });
      });

    new Setting(contentEl)
      .setName(t("modal.import.pinName"))
      .setDesc(t("modal.import.pinDesc"))
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder(t("modal.import.pinPlaceholder"));
        text.onChange((val) => {
          this.pin = val.trim();
        });
      });

    new Setting(contentEl).addButton((btn) => {
      btn
        .setButtonText(t("modal.import.applyBtn"))
        .setCta()
        .onClick(async () => {
          if (!this.pairingCode) {
            new Notice(t("modal.import.missingCodeNotice"));
            return;
          }
          if (!this.pin) {
            new Notice(t("modal.import.missingPinNotice"));
            return;
          }

          try {
            btn.setDisabled(true);
            btn.setButtonText(t("modal.import.applyingBtn"));
            const config = await importEncryptedConfig(this.pairingCode, this.pin);

            if (config.appKey) this.plugin.settings.appKey = config.appKey;
            if (config.appSecret) this.plugin.settings.appSecret = config.appSecret;
            if (config.accessToken) this.plugin.settings.accessToken = config.accessToken;
            if (config.refreshToken) this.plugin.settings.refreshToken = config.refreshToken;
            if (typeof config.tokenExpiresAt === "number") {
              this.plugin.settings.tokenExpiresAt = config.tokenExpiresAt;
            }
            if (config.remoteBasePath) this.plugin.settings.remoteBasePath = config.remoteBasePath;
            if (config.conflictStrategy === "copy" || config.conflictStrategy === "lww") {
              this.plugin.settings.conflictStrategy = config.conflictStrategy;
            }
            if (config.syncObsidianConfig !== undefined) {
              this.plugin.settings.syncObsidianConfig = config.syncObsidianConfig;
            }
            if (config.syncPlugins !== undefined) {
              this.plugin.settings.syncPlugins = config.syncPlugins;
            }
            if (config.syncThemes !== undefined) {
              this.plugin.settings.syncThemes = config.syncThemes;
            }
            if (config.ignoredPatterns !== undefined) {
              this.plugin.settings.ignoredPatterns = config.ignoredPatterns;
            }
            if (typeof config.concurrency === "number") {
              this.plugin.settings.concurrency = config.concurrency;
            }
            if (typeof config.maxFileSizeMB === "number") {
              this.plugin.settings.maxFileSizeMB = config.maxFileSizeMB;
            }
            if (config.enableE2EE !== undefined) {
              this.plugin.settings.enableE2EE = config.enableE2EE;
            }
            if (config.e2eePassword !== undefined) {
              this.plugin.settings.e2eePassword = config.e2eePassword;
              clearKeyCache();
            }

            await this.plugin.saveSettings();
            this.plugin.resetInterval();

            new Notice(t("modal.import.successNotice"));
            this.close();
            this.onImportSuccess();
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(t("modal.import.failNotice", { msg }));
          } finally {
            btn.setDisabled(false);
            btn.setButtonText(t("modal.import.applyBtn"));
          }
        });
    });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
