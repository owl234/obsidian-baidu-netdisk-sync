import { App, Modal, Setting, ButtonComponent, Notice } from "obsidian";
import { SyncEngine, SyncLogEntry, SyncState } from "../sync/engine";
import { t } from "../i18n";

const CONFIRM_ARM_TIMEOUT_MS = 8000;

export class SyncLogModal extends Modal {
  private logContainerEl: HTMLElement | null = null;
  private recoveryContainerEl: HTMLElement | null = null;
  private statusDescEl: HTMLElement | null = null;
  private syncBtn: ButtonComponent | null = null;
  private forceDeleteBtn: ButtonComponent | null = null;
  private trustCloudBtn: ButtonComponent | null = null;
  private mergeUploadBtn: ButtonComponent | null = null;
  private resetBaselineBtn: ButtonComponent | null = null;
  private forceDeleteArmed = false;
  private trustCloudArmed = false;
  private mergeUploadArmed = false;
  private resetBaselineArmed = false;
  private forceDeleteTimer: number | null = null;
  private trustCloudTimer: number | null = null;
  private mergeUploadTimer: number | null = null;
  private resetBaselineTimer: number | null = null;
  private lastRecoverySignature = "";
  private unsubscribeLog?: () => void;
  private unsubscribeState?: () => void;

  constructor(
    app: App,
    private engine: SyncEngine,
    private onCloseCallback?: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(t("modal.log.title"));
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("baidu-sync-log-modal");

    const syncSetting = new Setting(contentEl)
      .setName(t("modal.log.syncNowName"))
      .setDesc(t("modal.log.syncNowDesc"))
      .addButton((btn) => {
        this.syncBtn = btn;
        btn
          .setButtonText(t("modal.log.syncBtn"))
          .setCta()
          .onClick(async () => {
            btn.setDisabled(true);
            btn.setButtonText(t("modal.log.syncingBtn"));
            try {
              await this.engine.startSync(false);
            } finally {
              this.applyState(this.engine.getState(), this.engine.getLastStatusMessage());
            }
          });
      });

    this.statusDescEl = syncSetting.descEl;

    this.recoveryContainerEl = contentEl.createDiv({ cls: "baidu-sync-recovery-section" });
    this.renderRecoveryControls();

    // Immediately reflect live engine state if modal is opened mid-sync
    this.applyState(this.engine.getState(), this.engine.getLastStatusMessage());

    this.logContainerEl = contentEl.createDiv({ cls: "baidu-sync-log-container" });
    this.renderLogs(this.logContainerEl);

    // Subscribe to real-time log events
    this.unsubscribeLog = this.engine.onLog((entry: SyncLogEntry) => {
      if (this.logContainerEl) {
        this.appendLogEntry(this.logContainerEl, entry);
      }
    });

    // Subscribe to state changes
    this.unsubscribeState = this.engine.onStateChange((state: SyncState, message?: string) => {
      this.renderRecoveryControls();
      this.applyState(state, message);
    });
  }

  private clearArmTimers(): void {
    if (this.forceDeleteTimer !== null) {
      window.clearTimeout(this.forceDeleteTimer);
      this.forceDeleteTimer = null;
    }
    if (this.trustCloudTimer !== null) {
      window.clearTimeout(this.trustCloudTimer);
      this.trustCloudTimer = null;
    }
    if (this.mergeUploadTimer !== null) {
      window.clearTimeout(this.mergeUploadTimer);
      this.mergeUploadTimer = null;
    }
    if (this.resetBaselineTimer !== null) {
      window.clearTimeout(this.resetBaselineTimer);
      this.resetBaselineTimer = null;
    }
    this.forceDeleteArmed = false;
    this.trustCloudArmed = false;
    this.mergeUploadArmed = false;
    this.resetBaselineArmed = false;
  }

  private renderRecoveryControls(force = false): void {
    const container = this.recoveryContainerEl;
    if (!container) return;

    const showForceDelete = this.engine.wasLastRunMassDeleteAborted();
    const showCorruptedHighlight = this.engine.wasLastRunManifestCorrupted();
    const showStaleGuard = this.engine.wasLastRunStaleGuardAborted();
    const staleInfo = showStaleGuard ? this.engine.getLastStaleGuardInfo() : null;
    const signature = `${showForceDelete}:${showCorruptedHighlight}:${showStaleGuard}:${staleInfo?.reason ?? ""}:${staleInfo?.uploadCount ?? 0}`;
    if (!force && signature === this.lastRecoverySignature) {
      return;
    }
    this.lastRecoverySignature = signature;

    this.clearArmTimers();
    this.forceDeleteBtn = null;
    this.trustCloudBtn = null;
    this.mergeUploadBtn = null;
    this.resetBaselineBtn = null;
    container.empty();

    const isActive = this.engine.isSyncing();

    if (showForceDelete || showCorruptedHighlight || showStaleGuard) {
      container.addClass("baidu-sync-warning-box");
    } else {
      container.removeClass("baidu-sync-warning-box");
    }

    if (showStaleGuard && staleInfo) {
      const staleDesc =
        staleInfo.reason === "empty-baseline"
          ? t("modal.log.staleGuardDescEmpty", {
              uploadCount: staleInfo.uploadCount,
              remoteCount: staleInfo.remoteCount
            })
          : t("modal.log.staleGuardDescOffline", {
              days: staleInfo.staleDays,
              uploadCount: staleInfo.uploadCount
            });

      new Setting(container)
        .setName(t("modal.log.staleGuardName"))
        .setDesc(staleDesc)
        .addButton((btn) => {
          this.trustCloudBtn = btn;
          btn.buttonEl.addClass("mod-warning");
          btn
            .setButtonText(t("modal.log.trustCloudBtn"))
            .setDisabled(isActive)
            .onClick(async () => {
              if (!this.trustCloudArmed) {
                this.trustCloudArmed = true;
                btn.setButtonText(t("modal.log.trustCloudConfirmBtn"));
                this.trustCloudTimer = window.setTimeout(() => {
                  this.trustCloudArmed = false;
                  this.trustCloudTimer = null;
                  if (this.trustCloudBtn) {
                    this.trustCloudBtn.setButtonText(t("modal.log.trustCloudBtn"));
                  }
                }, CONFIRM_ARM_TIMEOUT_MS);
                return;
              }

              this.clearArmTimers();
              btn.setDisabled(true);
              btn.setButtonText(t("modal.log.syncingBtn"));
              try {
                await this.engine.startSync(false, { staleResolution: "trust-cloud" });
              } finally {
                this.renderRecoveryControls(true);
                this.applyState(this.engine.getState(), this.engine.getLastStatusMessage());
              }
            });
        })
        .addButton((btn) => {
          this.mergeUploadBtn = btn;
          btn
            .setButtonText(t("modal.log.mergeUploadBtn"))
            .setDisabled(isActive)
            .onClick(async () => {
              if (!this.mergeUploadArmed) {
                this.mergeUploadArmed = true;
                btn.setButtonText(t("modal.log.mergeUploadConfirmBtn"));
                this.mergeUploadTimer = window.setTimeout(() => {
                  this.mergeUploadArmed = false;
                  this.mergeUploadTimer = null;
                  if (this.mergeUploadBtn) {
                    this.mergeUploadBtn.setButtonText(t("modal.log.mergeUploadBtn"));
                  }
                }, CONFIRM_ARM_TIMEOUT_MS);
                return;
              }

              this.clearArmTimers();
              btn.setDisabled(true);
              btn.setButtonText(t("modal.log.syncingBtn"));
              try {
                await this.engine.startSync(false, { staleResolution: "merge-upload" });
              } finally {
                this.renderRecoveryControls(true);
                this.applyState(this.engine.getState(), this.engine.getLastStatusMessage());
              }
            });
        });
    }

    if (showForceDelete) {
      new Setting(container)
        .setName(t("modal.log.forceDeleteName"))
        .setDesc(t("modal.log.forceDeleteDesc"))
        .addButton((btn) => {
          this.forceDeleteBtn = btn;
          btn.buttonEl.addClass("mod-warning");
          btn
            .setButtonText(t("modal.log.forceDeleteBtn"))
            .setDisabled(isActive)
            .onClick(async () => {
              if (!this.forceDeleteArmed) {
                this.forceDeleteArmed = true;
                btn.setButtonText(t("modal.log.forceDeleteConfirmBtn"));
                this.forceDeleteTimer = window.setTimeout(() => {
                  this.forceDeleteArmed = false;
                  this.forceDeleteTimer = null;
                  if (this.forceDeleteBtn) {
                    this.forceDeleteBtn.setButtonText(t("modal.log.forceDeleteBtn"));
                  }
                }, CONFIRM_ARM_TIMEOUT_MS);
                return;
              }

              this.clearArmTimers();
              btn.setDisabled(true);
              btn.setButtonText(t("modal.log.syncingBtn"));
              try {
                await this.engine.startSync(false, { bypassMassDeleteGuard: true });
              } finally {
                this.renderRecoveryControls(true);
                this.applyState(this.engine.getState(), this.engine.getLastStatusMessage());
              }
            });
        });
    }

    new Setting(container)
      .setName(t("modal.log.resetBaselineName"))
      .setDesc(t("modal.log.resetBaselineDesc"))
      .addButton((btn) => {
        this.resetBaselineBtn = btn;
        btn
          .setButtonText(t("modal.log.resetBaselineBtn"))
          .setDisabled(isActive)
          .onClick(async () => {
            if (!this.resetBaselineArmed) {
              this.resetBaselineArmed = true;
              btn.setButtonText(t("modal.log.resetBaselineConfirmBtn"));
              btn.buttonEl.addClass("mod-warning");
              this.resetBaselineTimer = window.setTimeout(() => {
                this.resetBaselineArmed = false;
                this.resetBaselineTimer = null;
                if (this.resetBaselineBtn) {
                  this.resetBaselineBtn.setButtonText(t("modal.log.resetBaselineBtn"));
                  this.resetBaselineBtn.buttonEl.removeClass("mod-warning");
                }
              }, CONFIRM_ARM_TIMEOUT_MS);
              return;
            }

            this.clearArmTimers();
            btn.setDisabled(true);
            try {
              await this.engine.resetLocalBaseline();
              new Notice(t("modal.log.resetBaselineSuccess"));
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              new Notice(t("modal.log.resetBaselineFailed", { msg }));
            } finally {
              this.renderRecoveryControls(true);
              this.applyState(this.engine.getState(), this.engine.getLastStatusMessage());
            }
          });
      });
  }

  private applyState(state: SyncState, message?: string): void {
    const isActive = state === "syncing" || state === "diffing" || state === "preparing";

    if (this.syncBtn) {
      this.syncBtn.setDisabled(isActive);
      this.syncBtn.setButtonText(isActive ? t("modal.log.syncingBtn") : t("modal.log.syncBtn"));
    }
    if (this.forceDeleteBtn) {
      this.forceDeleteBtn.setDisabled(isActive);
    }
    if (this.trustCloudBtn) {
      this.trustCloudBtn.setDisabled(isActive);
    }
    if (this.mergeUploadBtn) {
      this.mergeUploadBtn.setDisabled(isActive);
    }
    if (this.resetBaselineBtn) {
      this.resetBaselineBtn.setDisabled(isActive);
    }

    if (this.statusDescEl) {
      if (isActive) {
        this.statusDescEl.setText(
          t("modal.log.stateSyncing", { msg: message || t("modal.log.stateSyncingDefault") })
        );
      } else if (state === "error") {
        this.statusDescEl.setText(
          t("modal.log.stateError", { msg: message || t("modal.log.stateErrorDefault") })
        );
      } else {
        this.statusDescEl.setText(t("modal.log.syncNowDesc"));
      }
    }
  }

  private appendLogEntry(container: HTMLElement, log: SyncLogEntry): void {
    const emptyEl = container.querySelector(".baidu-sync-log-empty");
    if (emptyEl) {
      emptyEl.remove();
    }

    const row = container.createDiv({ cls: `baidu-sync-log-row ${log.level}` });
    const timeStr = new Date(log.timestamp).toLocaleTimeString();
    const left = row.createDiv();
    left.createSpan({ text: `[${timeStr}] `, cls: "log-time" });
    left.createSpan({ text: log.message, cls: "log-msg" });

    if (log.detail) {
      row.createDiv({ text: log.detail, cls: "log-detail" });
    }

    container.prepend(row);
  }

  private renderLogs(container: HTMLElement): void {
    container.empty();
    const logs = this.engine.getLogs();

    if (logs.length === 0) {
      container.createEl("p", {
        text: t("modal.log.empty"),
        cls: "baidu-sync-log-row info baidu-sync-log-empty"
      });
      return;
    }

    for (const log of logs) {
      const row = container.createDiv({
        cls: `baidu-sync-log-row ${log.level}`
      });

      const timeStr = new Date(log.timestamp).toLocaleTimeString();
      const left = row.createDiv();
      left.createSpan({ text: `[${timeStr}] `, cls: "log-time" });
      left.createSpan({ text: log.message, cls: "log-msg" });

      if (log.detail) {
        row.createDiv({ text: log.detail, cls: "log-detail" });
      }
    }
  }

  onClose(): void {
    this.clearArmTimers();
    this.unsubscribeLog?.();
    this.unsubscribeState?.();
    this.unsubscribeLog = undefined;
    this.unsubscribeState = undefined;
    this.logContainerEl = null;
    this.recoveryContainerEl = null;
    this.statusDescEl = null;
    this.syncBtn = null;
    this.forceDeleteBtn = null;
    this.trustCloudBtn = null;
    this.mergeUploadBtn = null;
    this.resetBaselineBtn = null;
    this.lastRecoverySignature = "";

    const { contentEl } = this;
    contentEl.empty();
    this.onCloseCallback?.();
  }
}
