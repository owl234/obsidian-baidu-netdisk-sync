import { App, Modal, Setting } from "obsidian";
import { SyncEngine, SyncLogEntry } from "../sync/engine";

export class SyncLogModal extends Modal {
  constructor(app: App, private engine: SyncEngine) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("baidu-sync-log-modal");

    contentEl.createEl("h2", { text: "百度网盘同步日志" });

    new Setting(contentEl)
      .setName("立即执行同步")
      .setDesc("手动触发全量对比与增量双向同步")
      .addButton((btn) => {
        btn
          .setButtonText("开始同步")
          .setCta()
          .onClick(async () => {
            btn.setDisabled(true);
            await this.engine.startSync(false);
            btn.setDisabled(false);
            this.renderLogs(container);
          });
      });

    const container = contentEl.createDiv({ cls: "baidu-sync-log-container" });
    this.renderLogs(container);
  }

  private renderLogs(container: HTMLElement): void {
    container.empty();
    const logs = this.engine.getLogs();

    if (logs.length === 0) {
      container.createEl("p", {
        text: "暂无同步日志记录",
        cls: "baidu-sync-log-row info"
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
    const { contentEl } = this;
    contentEl.empty();
  }
}
