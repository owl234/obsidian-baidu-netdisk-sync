import { App, PluginSettingTab, Setting, Notice, SettingDefinitionItem } from "obsidian";
import type BaiduSyncPlugin from "../main";
import { ExportConfigModal, ImportConfigModal } from "../ui/configShareModal";
import { DecryptMigrationModal } from "../ui/decryptMigrationModal";
import { clearKeyCache } from "../crypto/e2ee";
import { t } from "../i18n";

export class BaiduSyncSettingTab extends PluginSettingTab {
  plugin: BaiduSyncPlugin;

  constructor(app: App, plugin: BaiduSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * Declarative settings definition interface for Obsidian 1.13.0+ search.
   * Returning an empty array allows backward/forward-compatible fallback to display().
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [];
  }

  display(): void {
    this.renderSettings();
  }

  private renderSettings(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Section 1: Authentication
    new Setting(containerEl).setName(t("settings.sec1.heading")).setHeading();

    const authDesc = containerEl.createDiv({ cls: "setting-item-description baidu-sync-setting-desc" });
    const p1 = authDesc.createDiv();
    p1.appendText(`${t("settings.sec1.step1")} `);
    const link = p1.createEl("a", {
      text: t("settings.sec1.platformLink"),
      href: "https://pan.baidu.com/union"
    });
    link.setAttr("target", "_blank");

    authDesc.createDiv({ text: t("settings.sec1.step2") });
    authDesc.createDiv({ text: t("settings.sec1.step3") });

    new Setting(containerEl)
      .setName(t("settings.appKey.name"))
      .setDesc(t("settings.appKey.desc"))
      .addText((text) =>
        text
          .setPlaceholder(t("settings.appKey.placeholder"))
          .setValue(this.plugin.settings.appKey)
          .onChange(async (value) => {
            this.plugin.settings.appKey = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.appSecret.name"))
      .setDesc(t("settings.appSecret.desc"))
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder(t("settings.appSecret.placeholder"))
          .setValue(this.plugin.settings.appSecret)
          .onChange(async (value) => {
            this.plugin.settings.appSecret = value.trim();
            await this.plugin.saveSettings();
          });
      });

    let authCodeInput = "";
    new Setting(containerEl)
      .setName(t("settings.authStatus.name"))
      .setDesc(
        this.plugin.settings.accessToken
          ? t("settings.authStatus.connected")
          : t("settings.authStatus.disconnected")
      )
      .addButton((btn) =>
        btn.setButtonText(t("settings.authStatus.openBtn")).onClick(() => {
          try {
            const url = this.plugin.oauth.getOAuthUrl();
            window.open(url);
            new Notice(t("settings.authStatus.openNotice"));
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : t("oauth.missingAppKey");
            new Notice(msg);
          }
        })
      );

    new Setting(containerEl)
      .setName(t("settings.authCode.name"))
      .setDesc(t("settings.authCode.desc"))
      .addText((text) =>
        text
          .setPlaceholder(t("settings.authCode.placeholder"))
          .onChange((value) => {
            authCodeInput = value.trim();
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText(t("settings.authCode.exchangeBtn"))
          .setCta()
          .onClick(async () => {
            if (!authCodeInput) {
              new Notice(t("settings.authCode.missingNotice"));
              return;
            }
            try {
              btn.setDisabled(true);
              btn.setButtonText(t("settings.authCode.exchangingBtn"));
              await this.plugin.oauth.exchangeCodeForToken(authCodeInput);
              new Notice(t("settings.authCode.successNotice"));
              this.renderSettings();
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              new Notice(t("settings.authCode.failNotice", { msg }));
            } finally {
              btn.setDisabled(false);
              btn.setButtonText(t("settings.authCode.exchangeBtn"));
            }
          })
      );

    // Section 2: Multi-Device Quick Pairing & Config Migration
    new Setting(containerEl).setName(t("settings.sec2.heading")).setHeading();

    const pairDesc = containerEl.createDiv({
      cls: "setting-item-description baidu-sync-setting-desc"
    });
    pairDesc.setText(t("settings.sec2.desc"));

    new Setting(containerEl)
      .setName(t("settings.pairing.name"))
      .setDesc(t("settings.pairing.desc"))
      .addButton((btn) =>
        btn
          .setButtonText(t("settings.pairing.exportBtn"))
          .setCta()
          .onClick(() => {
            new ExportConfigModal(this.app, this.plugin).open();
          })
      )
      .addButton((btn) =>
        btn.setButtonText(t("settings.pairing.importBtn")).onClick(() => {
          new ImportConfigModal(this.app, this.plugin, () => {
            this.renderSettings();
          }).open();
        })
      );

    // Section 3: Storage Path & Conflict Policy
    new Setting(containerEl).setName(t("settings.sec3.heading")).setHeading();

    new Setting(containerEl)
      .setName(t("settings.remotePath.name"))
      .setDesc(t("settings.remotePath.desc"))
      .addText((text) =>
        text
          .setPlaceholder("/apps/obsidian_vault")
          .setValue(this.plugin.settings.remoteBasePath)
          .onChange(async (val) => {
            this.plugin.settings.remoteBasePath = val.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.conflict.name"))
      .setDesc(t("settings.conflict.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("copy", t("settings.conflict.optCopy"))
          .addOption("lww", t("settings.conflict.optLww"))
          .setValue(this.plugin.settings.conflictStrategy || "copy")
          .onChange(async (val) => {
            this.plugin.settings.conflictStrategy = val === "lww" ? "lww" : "copy";
            await this.plugin.saveSettings();
          })
      );

    // Section 4: Scope and Filtering
    new Setting(containerEl).setName(t("settings.sec4.heading")).setHeading();

    const configDirName = this.app.vault.configDir;
    new Setting(containerEl)
      .setName(t("settings.syncConfig.name", { configDir: configDirName }))
      .setDesc(t("settings.syncConfig.desc", { configDir: configDirName }))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncObsidianConfig)
          .onChange(async (val) => {
            this.plugin.settings.syncObsidianConfig = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.syncPlugins.name", { configDir: configDirName }))
      .setDesc(t("settings.syncPlugins.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncPlugins)
          .onChange(async (val) => {
            this.plugin.settings.syncPlugins = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.syncThemes.name", { configDir: configDirName }))
      .setDesc(t("settings.syncThemes.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncThemes)
          .onChange(async (val) => {
            this.plugin.settings.syncThemes = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.ignoredPatterns.name"))
      .setDesc(t("settings.ignoredPatterns.desc"))
      .addTextArea((area) => {
        area.inputEl.rows = 6;
        area.inputEl.addClass("baidu-sync-textarea");
        area
          .setValue(this.plugin.settings.ignoredPatterns)
          .onChange(async (val) => {
            this.plugin.settings.ignoredPatterns = val;
            await this.plugin.saveSettings();
          });
      });

    let localIgnoreAreaEl: HTMLTextAreaElement | null = null;
    const presetLocalPatterns = [
      "**/attachments/**",
      "**/assets/**",
      "**/*.mp4",
      "**/*.mov",
      "**/*.zip"
    ];

    new Setting(containerEl)
      .setName(t("settings.localIgnoredPatterns.name"))
      .setDesc(t("settings.localIgnoredPatterns.desc"))
      .addTextArea((area) => {
        area.inputEl.rows = 4;
        area.inputEl.addClass("baidu-sync-textarea");
        localIgnoreAreaEl = area.inputEl;
        area
          .setPlaceholder(t("settings.localIgnoredPatterns.placeholder"))
          .setValue(this.plugin.settings.localIgnoredPatterns || "")
          .onChange(async (val) => {
            this.plugin.settings.localIgnoredPatterns = val;
            await this.plugin.saveSettings();
          });
      })
      .addButton((btn) =>
        btn.setButtonText(t("settings.localIgnoredPatterns.presetBtn")).onClick(async () => {
          const existingLines = (this.plugin.settings.localIgnoredPatterns || "")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          const existingSet = new Set(existingLines);
          const toAdd = presetLocalPatterns.filter((p) => !existingSet.has(p));

          if (toAdd.length === 0) {
            new Notice(t("settings.localIgnoredPatterns.presetAlreadyPresentNotice"));
            return;
          }

          const updated = [...existingLines, ...toAdd].join("\n");
          this.plugin.settings.localIgnoredPatterns = updated;
          await this.plugin.saveSettings();
          if (localIgnoreAreaEl) {
            localIgnoreAreaEl.value = updated;
          }
          new Notice(t("settings.localIgnoredPatterns.presetAddedNotice"));
        })
      );

    // Section 5: Trigger Settings
    new Setting(containerEl).setName(t("settings.sec5.heading")).setHeading();

    new Setting(containerEl)
      .setName(t("settings.syncOnStartup.name"))
      .setDesc(t("settings.syncOnStartup.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncOnStartup)
          .onChange(async (val) => {
            this.plugin.settings.syncOnStartup = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.syncInterval.name"))
      .setDesc(t("settings.syncInterval.desc"))
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
      .setName(t("settings.syncOnSave.name"))
      .setDesc(t("settings.syncOnSave.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncOnSave)
          .onChange(async (val) => {
            this.plugin.settings.syncOnSave = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.syncDebounce.name"))
      .setDesc(t("settings.syncDebounce.desc"))
      .addText((text) =>
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.syncDebounceSeconds || 5))
          .onChange(async (val) => {
            const num = parseInt(val, 10);
            this.plugin.settings.syncDebounceSeconds = isNaN(num) ? 5 : Math.max(1, num);
            await this.plugin.saveSettings();
          })
      );

    // Section 6: Concurrency & Safety Limits
    new Setting(containerEl).setName(t("settings.sec6.heading")).setHeading();

    new Setting(containerEl)
      .setName(t("settings.concurrency.name"))
      .setDesc(t("settings.concurrency.desc"))
      .addSlider((slider) =>
        slider
          .setLimits(1, 5, 1)
          .setValue(this.plugin.settings.concurrency)
          .onChange(async (val) => {
            this.plugin.settings.concurrency = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.maxFileSize.name"))
      .setDesc(t("settings.maxFileSize.desc"))
      .addText((text) =>
        text
          .setPlaceholder("100")
          .setValue(String(this.plugin.settings.maxFileSizeMB))
          .onChange(async (val) => {
            const num = parseInt(val, 10);
            this.plugin.settings.maxFileSizeMB = isNaN(num) ? 100 : Math.max(0, num);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.staleSyncThresholdDays.name"))
      .setDesc(t("settings.staleSyncThresholdDays.desc"))
      .addText((text) =>
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.staleSyncThresholdDays ?? 30))
          .onChange(async (val) => {
            const num = parseInt(val, 10);
            this.plugin.settings.staleSyncThresholdDays = isNaN(num) ? 30 : Math.max(0, num);
            await this.plugin.saveSettings();
          })
      );

    // Section 7: End-to-End Encryption
    new Setting(containerEl).setName(t("settings.sec7.heading")).setHeading();

    new Setting(containerEl)
      .setName(t("settings.enableE2EE.name"))
      .setDesc(t("settings.enableE2EE.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableE2EE)
          .onChange(async (val) => {
            this.plugin.settings.enableE2EE = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.e2eePassword.name"))
      .setDesc(t("settings.e2eePassword.desc"))
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder(t("settings.e2eePassword.placeholder"))
          .setValue(this.plugin.settings.e2eePassword)
          .onChange(async (val) => {
            this.plugin.settings.e2eePassword = val;
            clearKeyCache();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("settings.migration.name"))
      .setDesc(t("settings.migration.desc"))
      .addButton((btn) => {
        btn.setButtonText(t("settings.migration.btn")).onClick(() => {
          new DecryptMigrationModal(this.app, this.plugin, () => {
            this.renderSettings();
          }).open();
        });
      });
  }
}
