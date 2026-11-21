import { Plugin, Notice, TAbstractFile, TFile, moment, requestUrl } from "obsidian";
import { BaiduSyncSettings, DEFAULT_SETTINGS } from "./settings/settings";
import { BaiduSyncSettingTab } from "./settings/settingsTab";
import { BaiduOAuthManager } from "./baidu/oauth";
import { BaiduClient } from "./baidu/client";
import { HttpRequestFn, HttpRequestParam, HttpResponse } from "./baidu/types";
import { ManifestManager } from "./sync/manifest";
import { SyncEngine, VaultSyncBridge } from "./sync/engine";
import { StatusBarManager } from "./ui/statusBar";
import { SyncLogModal } from "./ui/logModal";
import { clearKeyCache } from "./crypto/e2ee";
import { initLocale, t } from "./i18n";

const obsidianHttpRequest: HttpRequestFn = async (param: HttpRequestParam): Promise<HttpResponse> => {
  const resp = await requestUrl({
    url: param.url,
    method: param.method,
    headers: param.headers,
    body: param.body,
    throw: param.throw ?? false
  });
  return {
    status: resp.status,
    headers: resp.headers,
    arrayBuffer: resp.arrayBuffer,
    text: resp.text
  };
};

export default class BaiduSyncPlugin extends Plugin {
  settings: BaiduSyncSettings = { ...DEFAULT_SETTINGS };
  oauth!: BaiduOAuthManager;
  client!: BaiduClient;
  manifestMgr!: ManifestManager;
  engine!: SyncEngine;
  statusBar!: StatusBarManager;

  private intervalId: number | null = null;
  private startupTimerId: number | null = null;
  private saveDebounceTimer: number | null = null;
  private pendingSaveSync = false;
  private ribbonIconEl: HTMLElement | null = null;
  private unsubscribeRibbonState?: () => void;

  async onload(): Promise<void> {
    initLocale(moment.locale());
    await this.loadSettings();

    const configDir = this.app.vault.configDir;
    const pluginDir = this.manifest.dir || `${configDir}/plugins/baidu-netdisk-sync`;
    const manifestPath = `${pluginDir}/sync_manifest.json`;
    this.manifestMgr = new ManifestManager(this.app.vault.adapter, manifestPath);

    this.oauth = new BaiduOAuthManager(
      () => this.settings,
      async (s) => {
        this.settings = s;
        await this.saveData(this.settings);
      },
      obsidianHttpRequest
    );

    const vaultBridge: VaultSyncBridge = {
      configDir: this.app.vault.configDir,
      exists: (path: string) => this.app.vault.adapter.exists(path),
      stat: async (path: string) => {
        const s = await this.app.vault.adapter.stat(path);
        if (!s) return null;
        return {
          type: s.type === "folder" ? "folder" : "file",
          mtime: s.mtime,
          size: s.size
        };
      },
      list: (dir: string) => this.app.vault.adapter.list(dir),
      mkdir: (path: string) => this.app.vault.adapter.mkdir(path),
      readBinary: (path: string) => this.app.vault.adapter.readBinary(path),
      writeBinary: (path: string, data: ArrayBuffer) => this.app.vault.adapter.writeBinary(path, data),
      trashFile: async (path: string) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file && file instanceof TFile) {
          await this.app.fileManager.trashFile(file);
        } else {
          await this.app.vault.adapter.trashLocal(path);
        }
      }
    };

    let warnSink: ((msg: string) => void) | undefined;
    this.client = new BaiduClient(this.oauth, obsidianHttpRequest, {
      onWarn: (msg) => warnSink?.(msg)
    });

    this.engine = new SyncEngine(
      vaultBridge,
      () => this.settings,
      async (s) => {
        this.settings = s;
        await this.saveData(this.settings);
      },
      this.client,
      this.manifestMgr,
      pluginDir
    );
    warnSink = (msg) => this.engine.addLog("warn", msg);

    // Setup Status Bar (Desktop)
    const statusBarItem = this.addStatusBarItem();
    this.statusBar = new StatusBarManager(statusBarItem, this.engine, () => {
      new SyncLogModal(this.app, this.engine).open();
    });

    // Setup Left Ribbon Icon
    this.ribbonIconEl = this.addRibbonIcon("cloud", t("ribbon.tooltip"), async () => {
      new Notice(t("notice.syncStarting"));
      const res = await this.engine.startSync(false);
      if (res.success) {
        new Notice(t("notice.syncSuccess"));
      } else {
        new Notice(t("notice.syncFailed"));
      }
    });

    this.unsubscribeRibbonState = this.engine.onStateChange((state) => {
      if (this.ribbonIconEl) {
        if (state === "syncing" || state === "diffing" || state === "preparing") {
          this.ribbonIconEl.addClass("baidu-sync-spinning");
        } else {
          this.ribbonIconEl.removeClass("baidu-sync-spinning");
        }
      }

      if (state === "idle" && this.pendingSaveSync) {
        this.pendingSaveSync = false;
        this.scheduleDebouncedSaveSync();
      }
    });

    // Register Commands
    this.addCommand({
      id: "baidu-sync-now",
      name: t("command.syncNow"),
      callback: async () => {
        new Notice(t("notice.syncStarting"));
        await this.engine.startSync(false);
      }
    });

    this.addCommand({
      id: "baidu-sync-view-logs",
      name: t("command.viewLogs"),
      callback: () => {
        new SyncLogModal(this.app, this.engine).open();
      }
    });

    // Register Settings Tab
    this.addSettingTab(new BaiduSyncSettingTab(this.app, this));

    // Setup Automation Triggers
    this.setupTriggers();
  }

  onunload(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.startupTimerId !== null) {
      window.clearTimeout(this.startupTimerId);
      this.startupTimerId = null;
    }
    if (this.saveDebounceTimer !== null) {
      window.clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    this.unsubscribeRibbonState?.();
    this.unsubscribeRibbonState = undefined;
    this.statusBar?.destroy();
    clearKeyCache();
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<BaiduSyncSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(loaded ?? {})
    };
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
      this.intervalId = window.setInterval(() => {
        if (this.settings.accessToken) {
          void this.engine.startSync(true);
        }
      }, ms);
    }
  }

  private scheduleDebouncedSaveSync(): void {
    if (!this.settings.syncOnSave || !this.settings.accessToken) return;

    if (this.saveDebounceTimer !== null) {
      window.clearTimeout(this.saveDebounceTimer);
    }

    const debounceSec = Math.max(1, this.settings.syncDebounceSeconds || 5);
    this.saveDebounceTimer = window.setTimeout(() => {
      this.saveDebounceTimer = null;
      void this.engine.startSync(true);
    }, debounceSec * 1000);
  }

  private setupTriggers(): void {
    // 1. Startup trigger
    if (this.settings.syncOnStartup && this.settings.accessToken) {
      // Delay 3s to let Obsidian complete internal indexing
      this.startupTimerId = window.setTimeout(() => {
        this.startupTimerId = null;
        void this.engine.startSync(true);
      }, 3000);
    }

    // 2. Periodic sync
    this.resetInterval();

    // 3. Save / Create / Delete / Rename debounced trigger with echo suppression
    const onVaultChange = (file: TAbstractFile) => {
      if (!this.settings.syncOnSave || !this.settings.accessToken) return;
      if (file.path.endsWith("sync_manifest.json") || file.path.includes("workspace")) return;
      if (this.engine.wasRecentlyWrittenBySync(file.path)) return;

      if (this.engine.isSyncing()) {
        // Queue a follow-up sync once the active sync finishes
        this.pendingSaveSync = true;
        return;
      }

      this.scheduleDebouncedSaveSync();
    };

    this.registerEvent(this.app.vault.on("modify", onVaultChange));
    this.registerEvent(this.app.vault.on("create", onVaultChange));
    this.registerEvent(this.app.vault.on("delete", onVaultChange));
    this.registerEvent(this.app.vault.on("rename", onVaultChange));
  }
}
