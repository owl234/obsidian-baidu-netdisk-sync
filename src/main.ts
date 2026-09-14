import { Plugin, Notice, TAbstractFile } from "obsidian";
import { BaiduSyncSettings, DEFAULT_SETTINGS } from "./settings/settings";
import { BaiduSyncSettingTab } from "./settings/settingsTab";
import { BaiduOAuthManager } from "./baidu/oauth";
import { BaiduClient } from "./baidu/client";
import { ManifestManager } from "./sync/manifest";
import { SyncEngine } from "./sync/engine";
import { StatusBarManager } from "./ui/statusBar";
import { SyncLogModal } from "./ui/logModal";

export default class BaiduSyncPlugin extends Plugin {
  settings: BaiduSyncSettings = DEFAULT_SETTINGS;
  oauth!: BaiduOAuthManager;
  client!: BaiduClient;
  manifestMgr!: ManifestManager;
  engine!: SyncEngine;
  statusBar!: StatusBarManager;

  private intervalId: number | null = null;
  private saveDebounceTimer: number | null = null;
  private ribbonIconEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Initialize core subsystems
    const manifestPath = `${this.manifest.dir || ".obsidian/plugins/baidu-netdisk-sync"}/sync_manifest.json`;
    this.manifestMgr = new ManifestManager(this.app.vault.adapter, manifestPath);

    this.oauth = new BaiduOAuthManager(
      () => this.settings,
      async (s) => {
        this.settings = s;
        await this.saveData(this.settings);
      }
    );

    this.client = new BaiduClient(this.oauth);

    this.engine = new SyncEngine(
      this.app,
      () => this.settings,
      async (s) => {
        this.settings = s;
        await this.saveData(this.settings);
      },
      this.client,
      this.manifestMgr
    );

    // Setup Status Bar
    const statusBarItem = this.addStatusBarItem();
    this.statusBar = new StatusBarManager(statusBarItem, this.engine, () => {
      new SyncLogModal(this.app, this.engine).open();
    });

    // Setup Left Ribbon Icon
    this.ribbonIconEl = this.addRibbonIcon("cloud", "百度网盘同步", async () => {
      new Notice("正在启动百度网盘同步...");
      const res = await this.engine.startSync(false);
      if (res.success) {
        new Notice("百度网盘同步完成！");
      } else {
        new Notice("百度网盘同步失败，请检查同步日志");
      }
    });

    this.engine.onStateChange((state) => {
      if (this.ribbonIconEl) {
        if (state === "syncing" || state === "diffing" || state === "preparing") {
          this.ribbonIconEl.addClass("baidu-sync-spinning");
        } else {
          this.ribbonIconEl.removeClass("baidu-sync-spinning");
        }
      }
    });

    // Register Commands
    this.addCommand({
      id: "baidu-sync-now",
      name: "立即执行同步 (Sync Now)",
      callback: async () => {
        new Notice("正在启动百度网盘同步...");
        await this.engine.startSync(false);
      }
    });

    this.addCommand({
      id: "baidu-sync-view-logs",
      name: "查看同步日志 (View Sync Logs)",
      callback: () => {
        new SyncLogModal(this.app, this.engine).open();
      }
    });

    // Register Settings Tab
    this.addSettingTab(new BaiduSyncSettingTab(this.app, this));

    // Setup Automation Triggers
    this.setupTriggers();

    console.log("[BaiduSync] 百度网盘同步插件已成功加载");
  }

  onunload(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.saveDebounceTimer !== null) {
      window.clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    console.log("[BaiduSync] 百度网盘同步插件已卸载");
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  resetInterval(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (this.settings.syncIntervalMinutes > 0) {
      const ms = this.settings.syncIntervalMinutes * 60 * 1000;
      this.intervalId = window.setInterval(async () => {
        if (this.settings.accessToken) {
          console.log("[BaiduSync] 触发定时同步任务");
          await this.engine.startSync(true); // Silent sync
        }
      }, ms);
    }
  }

  private setupTriggers(): void {
    // 1. Startup trigger
    if (this.settings.syncOnStartup && this.settings.accessToken) {
      // Delay 3s to let Obsidian complete internal indexing
      setTimeout(async () => {
        console.log("[BaiduSync] 触发启动自动同步");
        await this.engine.startSync(true);
      }, 3000);
    }

    // 2. Periodic sync
    this.resetInterval();

    // 3. Save / Modify debounced trigger
    const onVaultChange = (file: TAbstractFile) => {
      if (!this.settings.syncOnSave || !this.settings.accessToken) return;
      if (this.engine.isSyncing()) return;
      if (file.path.includes("sync_manifest.json") || file.path.includes("workspace")) return;

      if (this.saveDebounceTimer !== null) {
        window.clearTimeout(this.saveDebounceTimer);
      }

      const debounceMs = (this.settings.syncDebounceSeconds || 5) * 1000;
      this.saveDebounceTimer = window.setTimeout(async () => {
        console.log("[BaiduSync] 触发保存防抖同步");
        await this.engine.startSync(true);
      }, debounceMs);
    };

    this.registerEvent(this.app.vault.on("modify", onVaultChange));
    this.registerEvent(this.app.vault.on("create", onVaultChange));
    this.registerEvent(this.app.vault.on("delete", onVaultChange));
  }
}
