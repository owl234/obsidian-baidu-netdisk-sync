import { SyncEngine, SyncState } from "../sync/engine";

export class StatusBarManager {
  private statusBarEl: HTMLElement;

  constructor(
    statusBarItem: HTMLElement,
    private engine: SyncEngine,
    private onClick: () => void
  ) {
    this.statusBarEl = statusBarItem;
    this.statusBarEl.addClass("baidu-sync-status-bar");
    this.statusBarEl.addEventListener("click", () => this.onClick());

    this.engine.onStateChange((state, msg) => {
      this.updateState(state, msg);
    });

    this.updateState("idle", "空闲");
  }

  updateState(state: SyncState, message?: string): void {
    let icon = "☁️";
    let text = message || "就绪";

    switch (state) {
      case "idle":
        icon = "☁️";
        break;
      case "preparing":
      case "diffing":
      case "syncing":
        icon = "🔄";
        break;
      case "error":
        icon = "⚠️";
        break;
    }

    this.statusBarEl.setText(`${icon} 网盘: ${text}`);
  }
}
