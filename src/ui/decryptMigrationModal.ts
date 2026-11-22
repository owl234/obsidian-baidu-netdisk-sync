import { App, Modal, Setting, Notice } from "obsidian";
import type BaiduSyncPlugin from "../main";
import { clearKeyCache } from "../crypto/e2ee";
import { t } from "../i18n";

export class DecryptMigrationModal extends Modal {
  private plugin: BaiduSyncPlugin;
  private onComplete?: () => void;
  private clearPasswordOnFinish: boolean = false;
  private isMigrating: boolean = false;
  private statusTextEl: HTMLElement | null = null;

  constructor(app: App, plugin: BaiduSyncPlugin, onComplete?: () => void) {
    super(app);
    this.plugin = plugin;
    this.onComplete = onComplete;
  }

  onOpen(): void {
    this.setTitle(t("modal.migration.title"));
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("baidu-sync-log-modal");

    const desc = contentEl.createDiv({
      cls: "setting-item-description baidu-sync-modal-desc"
    });
    desc.setText(t("modal.migration.desc"));

    const warnBox = contentEl.createDiv({
      cls: "setting-item-description baidu-sync-modal-desc baidu-sync-warning-box"
    });
    warnBox.setText(t("modal.migration.warning"));

    new Setting(contentEl)
      .setName(t("modal.migration.clearPwdName"))
      .setDesc(t("modal.migration.clearPwdDesc"))
      .addToggle((toggle) => {
        toggle.setValue(this.clearPasswordOnFinish).onChange((val) => {
          this.clearPasswordOnFinish = val;
        });
      });

    const statusContainer = contentEl.createDiv({ cls: "baidu-sync-migration-status" });
    this.statusTextEl = statusContainer.createDiv({
      cls: "setting-item-description",
      text: t("modal.migration.ready")
    });

    let closeBtnEl: HTMLButtonElement | null = null;

    new Setting(contentEl)
      .addButton((btn) => {
        btn
          .setButtonText(t("modal.migration.startBtn"))
          .setCta()
          .onClick(async () => {
            if (this.isMigrating) return;
            if (!this.plugin.settings.accessToken) {
              new Notice(t("modal.migration.notAuthorizedNotice"));
              return;
            }

            this.isMigrating = true;
            btn.setDisabled(true);
            btn.setButtonText(t("modal.migration.runningBtn"));
            if (closeBtnEl) closeBtnEl.disabled = true;

            try {
              if (this.statusTextEl) {
                this.statusTextEl.setText(t("modal.migration.step1Status"));
              }

              const result = await this.plugin.engine.convertVaultToPlaintext(
                (processed, total, path) => {
                  if (this.statusTextEl) {
                    this.statusTextEl.setText(
                      t("modal.migration.step2Status", { done: processed, total, path })
                    );
                  }
                }
              );

              if (result.success) {
                const hasSkipped = result.skipped > 0;
                const hasLocalIgnores = Boolean(this.plugin.settings.localIgnoredPatterns?.trim());
                this.plugin.settings.enableE2EE = false;
                if (this.clearPasswordOnFinish && !hasSkipped && !hasLocalIgnores) {
                  this.plugin.settings.e2eePassword = "";
                  clearKeyCache();
                }
                await this.plugin.saveSettings();

                if (hasSkipped) {
                  const msg = t("modal.migration.successWithSkippedStatus", {
                    total: result.total,
                    skipped: result.skipped
                  });
                  if (this.statusTextEl) {
                    this.statusTextEl.setText(msg);
                  }
                  new Notice(msg, 10000);
                } else if (this.clearPasswordOnFinish && hasLocalIgnores) {
                  const msg = t("modal.migration.successWithIgnoredPwdKept");
                  if (this.statusTextEl) {
                    this.statusTextEl.setText(msg);
                  }
                  new Notice(msg, 10000);
                } else {
                  if (this.statusTextEl) {
                    this.statusTextEl.setText(
                      t("modal.migration.successStatus", { total: result.total })
                    );
                  }
                  new Notice(t("modal.migration.successNotice"));
                }
                this.onComplete?.();
              } else {
                if (this.statusTextEl) {
                  this.statusTextEl.setText(
                    t("modal.migration.partialStatus", { errors: result.errors })
                  );
                }
                new Notice(t("modal.migration.partialNotice", { errors: result.errors }));
              }
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              if (this.statusTextEl) {
                this.statusTextEl.setText(t("modal.migration.abortedStatus", { msg }));
              }
              new Notice(t("modal.migration.failNotice", { msg }));
            } finally {
              this.isMigrating = false;
              btn.setDisabled(false);
              btn.setButtonText(t("modal.migration.retryBtn"));
              if (closeBtnEl) closeBtnEl.disabled = false;
            }
          });
      })
      .addButton((btn) => {
        closeBtnEl = btn.buttonEl;
        btn.setButtonText(t("modal.migration.closeBtn")).onClick(() => {
          if (this.isMigrating) {
            new Notice(t("modal.migration.runningCloseNotice"));
            return;
          }
          this.close();
        });
      });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
