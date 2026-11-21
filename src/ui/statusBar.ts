import { SyncEngine, SyncState } from "../sync/engine";
import { t } from "../i18n";

export class StatusBarManager {
  private statusBarEl: HTMLElement;
  private unsubscribeState?: () => void;
  private clickHandler: () => void;

  constructor(
    statusBarItem: HTMLElement,
    private engine: SyncEngine,
    private onClick: () => void
  ) {
    this.statusBarEl = statusBarItem;
    this.statusBarEl.addClass("baidu-sync-status-bar");
    this.clickHandler = () => this.onClick();
    this.statusBarEl.addEventListener("click", this.clickHandler);

    this.unsubscribeState = this.engine.onStateChange((state, msg) => {
      this.updateState(state, msg);
    });

    this.updateState("idle", t("statusBar.idle"));
  }

  updateState(state: SyncState, message?: string): void {
    let icon = "☁️";
    const text = message || t("statusBar.ready");

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

    this.statusBarEl.setText(`${icon} ${t("statusBar.prefix")}: ${text}`);
  }

  destroy(): void {
    this.unsubscribeState?.();
    this.unsubscribeState = undefined;
    this.statusBarEl.removeEventListener("click", this.clickHandler);
  }
}
