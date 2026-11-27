import { Plugin, Notice, Platform, TAbstractFile, TFile, moment, requestUrl } from "obsidian";
import { BaiduSyncSettings, DEFAULT_SETTINGS } from "./settings/settings";
import { BaiduSyncSettingTab } from "./settings/settingsTab";
import { BaiduOAuthManager } from "./baidu/oauth";
import { BaiduClient } from "./baidu/client";
import { HttpRequestFn, HttpRequestParam, HttpResponse } from "./baidu/types";
import { ManifestManager } from "./sync/manifest";
import { TombstoneManager, generateDeviceId, isValidDeviceId } from "./sync/tombstone";
import { SyncEngine, VaultSyncBridge } from "./sync/engine";
import { HTTP_REQUEST_TIMEOUT_MS, withTimeout } from "./sync/timeout";
import { StatusBarManager } from "./ui/statusBar";
import { SyncLogModal } from "./ui/logModal";
import { clearKeyCache } from "./crypto/e2ee";
import { initLocale, t } from "./i18n";

const obsidianHttpRequest: HttpRequestFn = async (param: HttpRequestParam): Promise<HttpResponse> => {
  const resp = await withTimeout(
    requestUrl({
      url: param.url,
      method: param.method,
      headers: param.headers,
      body: param.body,
      throw: param.throw ?? false
    }),
    HTTP_REQUEST_TIMEOUT_MS,
    `requestUrl.${param.method || "GET"}`,
    "http"
  );
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
  tombstoneMgr!: TombstoneManager;
  engine!: SyncEngine;
  statusBar!: StatusBarManager;

  private intervalId: number | null = null;
  private startupTimerId: number | null = null;
  private saveDebounceTimer: number | null = null;
  private pendingSaveSync = false;
  private ribbonIconEl: HTMLElement | null = null;
  private activeLogModal: SyncLogModal | null = null;
  private guardModalAutoOpened = false;
  private unsubscribeRibbonState?: () => void;

  async onload(): Promise<void> {
    initLocale(moment.locale());
    await this.loadSettings();

    if (!isValidDeviceId(this.settings.deviceId)) {
      this.settings.deviceId = generateDeviceId();
      await this.saveSettings();
    }

    const configDir = this.app.vault.configDir;
    const pluginDir = this.manifest.dir || `${configDir}/plugins/baidu-netdisk-sync`;
    const manifestPath = `${pluginDir}/sync_manifest.json`;
    const tombstoneCachePath = `${pluginDir}/tombstone_cache.json`;
    this.manifestMgr = new ManifestManager(this.app.vault.adapter, manifestPath);
    this.tombstoneMgr = new TombstoneManager(this.app.vault.adapter, tombstoneCachePath);

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
      // Use zero-IPC in-memory TFile.stat ONLY on Mobile (iOS/Android Capacitor bridge deadlock prevention).
      // On Desktop, adapter.stat() is a fast native fs.stat syscall and guarantees immediate visibility
      // of external edits (VS Code, Git, CLI scripts) before Obsidian's watcher refreshes TFile.stat.
      statFast: Platform.isMobile
        ? async (path: string) => {
            const abstractFile = this.app.vault.getAbstractFileByPath(path);
            if (abstractFile && abstractFile instanceof TFile && abstractFile.stat) {
              return {
                type: "file",
                mtime: abstractFile.stat.mtime,
                size: abstractFile.stat.size
              };
            }
            return vaultBridge.stat(path);
          }
        : undefined,
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
      pluginDir,
      { tombstones: this.tombstoneMgr }
    );
    warnSink = (msg) => this.engine.addLog("warn", msg);

    // Setup Status Bar (Desktop)
    const statusBarItem = this.addStatusBarItem();
    this.statusBar = new StatusBarManager(statusBarItem, this.engine, () => {
      this.openLogModal();
    });

    // Setup Left Ribbon Icon
    this.ribbonIconEl = this.addRibbonIcon("cloud", t("ribbon.tooltip"), async () => {
      // If a safety guard previously paused sync, tapping the ribbon opens the recovery modal directly
      // (especially critical on mobile where there is no status bar).
      if (this.hasActiveSafetyGuardAbort() && !this.engine.isSyncing()) {
        this.openLogModal();
        return;
      }
      await this.triggerManualSync();
    });

    this.unsubscribeRibbonState = this.engine.onStateChange((state, message) => {
      if (this.ribbonIconEl) {
        if (state === "syncing" || state === "diffing" || state === "preparing") {
          this.ribbonIconEl.addClass("baidu-sync-spinning");
        } else {
          this.ribbonIconEl.removeClass("baidu-sync-spinning");
        }
      }

      if (state === "idle") {
        this.guardModalAutoOpened = false;
      }

      if (
        state === "error" &&
        message &&
        (message === t("engine.bridgeDeadlock") || this.hasActiveSafetyGuardAbort())
      ) {
        new Notice(message, 12000);
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
        await this.triggerManualSync();
      }
    });

    this.addCommand({
      id: "baidu-sync-view-logs",
      name: t("command.viewLogs"),
      callback: () => {
        this.openLogModal();
      }
    });

    // Register Settings Tab
    this.addSettingTab(new BaiduSyncSettingTab(this.app, this));

    // Setup Automation Triggers
    this.setupTriggers();
  }

  onunload(): void {
    this.engine?.abortActiveSync();
    if (this.activeLogModal) {
      this.activeLogModal.close();
      this.activeLogModal = null;
    }
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

  private hasActiveSafetyGuardAbort(): boolean {
    return (
      this.engine.wasLastRunStaleGuardAborted() ||
      this.engine.wasLastRunMassDeleteAborted() ||
      this.engine.wasLastRunManifestCorrupted()
    );
  }

  openLogModal(): void {
    if (this.activeLogModal) {
      return;
    }
    const modal = new SyncLogModal(this.app, this.engine, () => {
      if (this.activeLogModal === modal) {
        this.activeLogModal = null;
      }
    });
    this.activeLogModal = modal;
    modal.open();
  }

  private async triggerManualSync(): Promise<void> {
    new Notice(t("notice.syncStarting"));
    const res = await this.engine.startSync(false);
    if (res.success) {
      new Notice(t("notice.syncSuccess"));
    } else if (res.massDeleteAborted || res.manifestCorrupted || res.staleGuardAborted) {
      this.guardModalAutoOpened = true;
      this.openLogModal();
    } else if (!res.bridgeDead) {
      new Notice(t("notice.syncFailed"));
    }
  }

  private async triggerBackgroundSync(): Promise<void> {
    const res = await this.engine.startSync(true);
    if (
      Platform.isMobile &&
      !this.guardModalAutoOpened &&
      (res.massDeleteAborted || res.manifestCorrupted || res.staleGuardAborted)
    ) {
      this.guardModalAutoOpened = true;
      this.openLogModal();
    }
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
          void this.triggerBackgroundSync();
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
      void this.triggerBackgroundSync();
    }, debounceSec * 1000);
  }

  private setupTriggers(): void {
    // 1. Startup trigger
    if (this.settings.syncOnStartup && this.settings.accessToken) {
      // Delay 3s to let Obsidian complete internal indexing
      this.startupTimerId = window.setTimeout(() => {
        this.startupTimerId = null;
        void this.triggerBackgroundSync();
      }, 3000);
    }

    // 2. Periodic sync
    this.resetInterval();

    // 3. Save / Create / Delete / Rename debounced trigger with echo suppression
    const onVaultChange = (file: TAbstractFile) => {
      if (!this.settings.syncOnSave || !this.settings.accessToken) return;
      if (
        file.path.endsWith("sync_manifest.json") ||
        file.path.endsWith("sync_manifest.json.bak") ||
        file.path.endsWith("tombstone_cache.json") ||
        file.path.endsWith("tombstone_cache.json.bak")
      ) {
        return;
      }
      if (this.engine.shouldIgnore(file.path)) return;
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
