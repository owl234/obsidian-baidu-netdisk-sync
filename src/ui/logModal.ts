import { App, Modal, Setting } from "obsidian";
import { SyncEngine, SyncLogEntry, SyncState } from "../sync/engine";

export class SyncLogModal extends Modal {
  private logContainerEl: HTMLElement | null = null;
  private statusDescEl: HTMLElement | null = null;
  private unsubscribeLog?: () => void;
  private unsubscribeState?: () => void;

  constructor(app: App, private engine: SyncEngine) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("baidu-sync-log-modal");

    new Setting(contentEl).setName("百度网盘同步日志").setHeading();

    const syncSetting = new Setting(contentEl)
      .setName("立即执行同步")
      .setDesc("手动触发全量对比与增量双向同步")
      .addButton((btn) => {
        btn
          .setButtonText("开始同步")
          .setCta()
          .onClick(async () => {
            btn.setDisabled(true);
            btn.setButtonText("同步中...");
            await this.engine.startSync(false);
            btn.setDisabled(false);
            btn.setButtonText("开始同步");
          });
      });

    this.statusDescEl = syncSetting.descEl;

    this.logContainerEl = contentEl.createDiv({ cls: "baidu-sync-log-container" });
    this.renderLogs(this.logContainerEl);

    // Subscribe to real-time log events
    this.unsubscribeLog = this.engine.onLog((entry: SyncLogEntry) => {
      if (this.logContainerEl) {
        this.appendLogEntry(this.logContainerEl, entry);
      }
    });

    // Subscribe to state change
    this.unsubscribeState = this.engine.onStateChange((state: SyncState, message?: string) => {
      if (this.statusDescEl) {
        if (state === "syncing" || state === "diffing" || state === "preparing") {
          this.statusDescEl.setText(`🔄 ${message || "正在同步中..."}`);
        } else if (state === "error") {
          this.statusDescEl.setText(`⚠️ 同步异常: ${message || "发生错误"}`);
        } else {
          this.statusDescEl.setText("手动触发全量对比与增量双向同步");
        }
      }
    });
  }

  private appendLogEntry(container: HTMLElement, log: SyncLogEntry): void {
    const emptyEl = container.querySelector(".baidu-sync-log-empty");
    if (emptyEl) {
      emptyEl.remove();
    }

    const row = createDiv({ cls: `baidu-sync-log-row ${log.level}` });
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
        text: "暂无同步日志记录",
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

    const { contentEl } = this;
    contentEl.empty();
  }
}
