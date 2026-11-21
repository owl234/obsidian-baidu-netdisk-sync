import { App, Modal, Setting, ButtonComponent } from "obsidian";
import { SyncEngine, SyncLogEntry, SyncState } from "../sync/engine";
import { t } from "../i18n";

export class SyncLogModal extends Modal {
  private logContainerEl: HTMLElement | null = null;
  private statusDescEl: HTMLElement | null = null;
  private syncBtn: ButtonComponent | null = null;
  private unsubscribeLog?: () => void;
  private unsubscribeState?: () => void;

  constructor(app: App, private engine: SyncEngine) {
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
      this.applyState(state, message);
    });
  }

  private applyState(state: SyncState, message?: string): void {
    const isActive = state === "syncing" || state === "diffing" || state === "preparing";

    if (this.syncBtn) {
      this.syncBtn.setDisabled(isActive);
      this.syncBtn.setButtonText(isActive ? t("modal.log.syncingBtn") : t("modal.log.syncBtn"));
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
    this.unsubscribeLog?.();
    this.unsubscribeState?.();
    this.unsubscribeLog = undefined;
    this.unsubscribeState = undefined;
    this.logContainerEl = null;
    this.statusDescEl = null;
    this.syncBtn = null;

    const { contentEl } = this;
    contentEl.empty();
  }
}
