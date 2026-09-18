import { App, TFile } from "obsidian";
import { BaiduSyncSettings } from "../settings/settings";
import { BaiduClient } from "../baidu/client";
import { BaiduUploader } from "../baidu/uploader";
import { BaiduDownloader } from "../baidu/downloader";
import { ManifestManager } from "./manifest";
import { SyncFilter } from "./filter";
import { AsyncQueue } from "./queue";
import {
  SyncPlanner,
  SyncPlanItem,
  LocalFileInfo,
  RemoteFileInfo
} from "./planner";

export type SyncState = "idle" | "preparing" | "diffing" | "syncing" | "error";

export interface SyncLogEntry {
  timestamp: number;
  level: "info" | "success" | "warn" | "error";
  message: string;
  detail?: string;
}

export class SyncEngine {
  private state: SyncState = "idle";
  private filter: SyncFilter;
  private queue: AsyncQueue;
  private uploader: BaiduUploader;
  private downloader: BaiduDownloader;
  private logs: SyncLogEntry[] = [];
  private onStateChangeListeners: Array<(state: SyncState, message?: string) => void> = [];
  private onLogListeners: Array<(entry: SyncLogEntry) => void> = [];

  constructor(
    private app: App,
    private getSettings: () => BaiduSyncSettings,
    private saveSettings: (settings: BaiduSyncSettings) => Promise<void>,
    private client: BaiduClient,
    private manifest: ManifestManager
  ) {
    const settings = this.getSettings();
    this.filter = new SyncFilter(settings, this.app.vault.configDir);
    this.queue = new AsyncQueue(settings.concurrency || 3);
    this.uploader = new BaiduUploader(this.client);
    this.downloader = new BaiduDownloader(this.client);
  }

  onStateChange(listener: (state: SyncState, message?: string) => void): () => void {
    this.onStateChangeListeners.push(listener);
    return () => {
      this.onStateChangeListeners = this.onStateChangeListeners.filter((l) => l !== listener);
    };
  }

  onLog(listener: (entry: SyncLogEntry) => void): () => void {
    this.onLogListeners.push(listener);
    return () => {
      this.onLogListeners = this.onLogListeners.filter((l) => l !== listener);
    };
  }

  private setState(state: SyncState, message?: string): void {
    this.state = state;
    for (const listener of this.onStateChangeListeners) {
      listener(state, message);
    }
  }

  getState(): SyncState {
    return this.state;
  }

  isSyncing(): boolean {
    return this.state !== "idle" && this.state !== "error";
  }

  getLogs(): SyncLogEntry[] {
    return [...this.logs];
  }

  addLog(level: "info" | "success" | "warn" | "error", message: string, detail?: string): void {
    const entry: SyncLogEntry = {
      timestamp: Date.now(),
      level,
      message,
      detail
    };
    this.logs.unshift(entry);
    if (this.logs.length > 200) {
      this.logs.pop();
    }
    for (const listener of this.onLogListeners) {
      try {
        listener(entry);
      } catch {
        // ignore listener errors
      }
    }
  }

  async startSync(silent = false): Promise<{ success: boolean; stats: { uploaded: number; downloaded: number; deleted: number; errors: number } }> {
    if (this.state !== "idle" && this.state !== "error") {
      this.addLog("warn", "已有同步任务正在运行，跳过本次触发");
      return { success: false, stats: { uploaded: 0, downloaded: 0, deleted: 0, errors: 0 } };
    }

    const settings = this.getSettings();
    if (!settings.accessToken) {
      this.addLog("error", "未配置百度网盘授权，请先前往设置授权账号");
      this.setState("error", "未授权账号");
      return { success: false, stats: { uploaded: 0, downloaded: 0, deleted: 0, errors: 0 } };
    }

    this.filter.updateSettings(settings);
    this.queue.setConcurrency(settings.concurrency || 3);

    const stats = { uploaded: 0, downloaded: 0, deleted: 0, errors: 0 };
    const startTime = Date.now();

    try {
      this.setState("preparing", "正在加载同步清单...");
      await this.manifest.load();

      // Step 1: Scan local files
      this.setState("diffing", "正在扫描本地文件...");
      const localFiles = await this.scanLocalFiles();

      // Step 2: Scan remote files
      this.setState("diffing", "正在检索百度网盘文件列表...");
      const remoteFiles = await this.scanRemoteFiles(settings.remoteBasePath);

      // Step 3: Compute diff plan
      this.setState("diffing", "正在对比差异并裁决冲突 (LWW)...");
      const plans = SyncPlanner.plan(
        localFiles,
        remoteFiles,
        this.manifest.getAll(),
        settings.remoteBasePath
      );

      if (plans.length === 0) {
        this.addLog("info", "两端文件已处于最新一致状态，无需传输");
        this.setState("idle", "同步完成 (无变动)");
        return { success: true, stats };
      }

      this.addLog("info", `规划完成，待执行操作数: ${plans.length}`);

      // Step 4: Execute actions
      this.setState("syncing", `同步中 (0/${plans.length})...`);
      let processed = 0;

      for (const item of plans) {
        await this.queue.add(async () => {
          try {
            await this.executePlanItem(item);
            if (item.action === "UPLOAD") stats.uploaded++;
            else if (item.action === "DOWNLOAD") stats.downloaded++;
            else if (item.action === "DELETE_LOCAL" || item.action === "DELETE_REMOTE") stats.deleted++;
          } catch (err: unknown) {
            stats.errors++;
            const msg = err instanceof Error ? err.message : String(err);
            this.addLog("error", `处理失败: ${item.path}`, msg);
          } finally {
            processed++;
            this.setState("syncing", `同步中 (${processed}/${plans.length})...`);
          }
        });
      }

      await this.queue.waitAll();

      // Step 5: Save manifest
      this.manifest.updateLastSyncTime();
      await this.manifest.save();

      settings.lastSyncTime = Date.now();
      await this.saveSettings(settings);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const summary = `同步完成！用时 ${elapsed}s | 上传: ${stats.uploaded}, 下载: ${stats.downloaded}, 删除: ${stats.deleted}, 失败: ${stats.errors}`;
      this.addLog(stats.errors > 0 ? "warn" : "success", summary);

      this.setState("idle", "同步完成");
      return { success: stats.errors === 0, stats };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.addLog("error", "同步过程中发生严重异常", msg);
      this.setState("error", msg);
      return { success: false, stats };
    }
  }

  private async executePlanItem(item: SyncPlanItem): Promise<void> {
    const settings = this.getSettings();
    const adapter = this.app.vault.adapter;

    switch (item.action) {
      case "UPLOAD": {
        if (!(await adapter.exists(item.path))) {
          return;
        }
        const buffer = await adapter.readBinary(item.path);
        const stat = await adapter.stat(item.path);
        const localMtime = stat?.mtime || Date.now();

        const res = await this.uploader.uploadFile(item.remotePath, buffer, {
          enableE2EE: settings.enableE2EE,
          e2eePassword: settings.e2eePassword
        });

        this.manifest.set({
          path: item.path,
          remotePath: item.remotePath,
          mtime: localMtime,
          remoteMtime: (res.mtime || Math.floor(Date.now() / 1000)) * 1000,
          md5: res.md5 || "",
          size: stat?.size || buffer.byteLength,
          remoteSize: res.size,
          fsId: res.fs_id
        });
        this.addLog("success", `上传成功: ${item.path}`);
        break;
      }

      case "DOWNLOAD": {
        if (!item.remote?.fsId) {
          throw new Error(`缺少远端 fs_id，无法下载: ${item.path}`);
        }

        const buffer = await this.downloader.downloadByFsId(item.remote.fsId, {
          e2eePassword: settings.e2eePassword
        });

        // Ensure parent directory exists
        const lastSlash = item.path.lastIndexOf("/");
        if (lastSlash > 0) {
          const dir = item.path.substring(0, lastSlash);
          if (!(await adapter.exists(dir))) {
            await adapter.mkdir(dir);
          }
        }

        await adapter.writeBinary(item.path, buffer);
        const stat = await adapter.stat(item.path);

        this.manifest.set({
          path: item.path,
          remotePath: item.remotePath,
          mtime: stat?.mtime || Date.now(),
          remoteMtime: item.remote.mtime,
          md5: item.remote.md5 || "",
          size: buffer.byteLength,
          remoteSize: item.remote.size,
          fsId: item.remote.fsId
        });
        this.addLog("success", `下载成功: ${item.path}`);
        break;
      }

      case "DELETE_LOCAL": {
        if (await adapter.exists(item.path)) {
          const file = this.app.vault.getAbstractFileByPath(item.path);
          if (file && file instanceof TFile) {
            await this.app.fileManager.trashFile(file); // Respect user trash preference
          } else {
            // For files under config directory or files not indexed by Vault
            await adapter.trashLocal(item.path);
          }
          this.addLog("info", `移入本地回收站: ${item.path}`);
        }
        this.manifest.delete(item.path);
        break;
      }

      case "DELETE_REMOTE": {
        await this.client.deleteFiles([item.remotePath]);
        this.manifest.delete(item.path);
        this.addLog("info", `移入网盘回收站: ${item.path}`);
        break;
      }

      case "CLEAN_MANIFEST": {
        this.manifest.delete(item.path);
        break;
      }

      default:
        break;
    }
  }

  async convertVaultToPlaintext(
    onProgress?: (processed: number, total: number, currentPath: string) => void
  ): Promise<{ success: boolean; total: number; errors: number }> {
    if (this.state !== "idle" && this.state !== "error") {
      throw new Error("已有同步任务正在运行，请等待当前任务完成。");
    }

    const settings = this.getSettings();
    if (!settings.accessToken) {
      throw new Error("未配置百度网盘授权，请先前往设置授权账号。");
    }

    this.addLog("info", "启动全量解密迁移流程：开始拉取并解密云端全部最新文件确保本地完整...");
    const pullResult = await this.startSync(false);
    if (!pullResult.success && pullResult.stats.errors > 0) {
      throw new Error(`云端预拉取未完全成功（存在 ${pullResult.stats.errors} 个错误），请在同步日志中检查并排除后再试，以防数据丢失。`);
    }

    this.setState("diffing", "正在扫描本地待迁移文件...");
    const localFiles = await this.scanLocalFiles();
    const total = localFiles.size;
    let processed = 0;
    let errors = 0;

    this.addLog("info", `开始以明文全量重新上传 ${total} 个文件覆盖网盘历史密文...`);

    const adapter = this.app.vault.adapter;
    const cleanBase = settings.remoteBasePath.endsWith("/")
      ? settings.remoteBasePath.slice(0, -1)
      : settings.remoteBasePath;

    this.setState("syncing", `正在以明文重新上传 (0/${total})...`);

    for (const [path] of localFiles) {
      await this.queue.add(async () => {
        try {
          if (!(await adapter.exists(path))) {
            return;
          }
          const buffer = await adapter.readBinary(path);
          const stat = await adapter.stat(path);
          const localMtime = stat?.mtime || Date.now();
          const remotePath = `${cleanBase}/${path}`;

          // Explicitly upload with enableE2EE: false -> Pure Plaintext!
          const res = await this.uploader.uploadFile(remotePath, buffer, {
            enableE2EE: false
          });

          this.manifest.set({
            path: path,
            remotePath: remotePath,
            mtime: localMtime,
            remoteMtime: (res.mtime || Math.floor(Date.now() / 1000)) * 1000,
            md5: res.md5 || "",
            size: stat?.size || buffer.byteLength,
            remoteSize: res.size,
            fsId: res.fs_id
          });
          this.addLog("success", `明文重传成功: ${path}`);
        } catch (err: unknown) {
          errors++;
          const msg = err instanceof Error ? err.message : String(err);
          this.addLog("error", `明文重传失败: ${path}`, msg);
        } finally {
          processed++;
          onProgress?.(processed, total, path);
          this.setState("syncing", `正在以明文重新上传 (${processed}/${total})...`);
        }
      });
    }

    await this.queue.waitAll();

    this.manifest.updateLastSyncTime();
    await this.manifest.save();

    settings.lastSyncTime = Date.now();
    await this.saveSettings(settings);

    this.setState("idle", "明文迁移重传完成");
    const summary = `明文迁移完成！共处理 ${processed}/${total} 个文件，失败: ${errors}`;
    this.addLog(errors > 0 ? "warn" : "success", summary);

    return { success: errors === 0, total, errors };
  }

  private async scanLocalFiles(): Promise<Map<string, LocalFileInfo>> {
    const adapter = this.app.vault.adapter;
    const result = new Map<string, LocalFileInfo>();

    const scanDirectory = async (dir: string) => {
      const list = await adapter.list(dir);

      for (const file of list.files) {
        if (this.filter.shouldIgnore(file)) {
          continue;
        }
        const stat = await adapter.stat(file);
        if (stat && stat.type === "file") {
          result.set(file, {
            path: file,
            mtime: stat.mtime,
            size: stat.size
          });
        }
      }

      for (const folder of list.folders) {
        if (this.filter.shouldIgnore(folder)) {
          continue;
        }
        await scanDirectory(folder);
      }
    };

    // Scan regular vault contents
    await scanDirectory("");

    // Scan config directory if enabled
    const settings = this.getSettings();
    const configDir = this.app.vault.configDir;
    if (settings.syncObsidianConfig && configDir && (await adapter.exists(configDir))) {
      await scanDirectory(configDir);
    }

    return result;
  }

  private async scanRemoteFiles(remoteBasePath: string): Promise<Map<string, RemoteFileInfo>> {
    const result = new Map<string, RemoteFileInfo>();
    const cleanBase = remoteBasePath.endsWith("/") ? remoteBasePath.slice(0, -1) : remoteBasePath;

    const items = await this.client.listAll(cleanBase);

    for (const item of items) {
      if (item.isdir === 1) {
        continue;
      }

      let relativePath = item.path;
      if (relativePath.startsWith(cleanBase)) {
        relativePath = relativePath.slice(cleanBase.length);
      }
      if (relativePath.startsWith("/")) {
        relativePath = relativePath.slice(1);
      }

      if (this.filter.shouldIgnore(relativePath)) {
        continue;
      }

      result.set(relativePath, {
        path: relativePath,
        remotePath: item.path,
        mtime: (item.server_mtime || 0) * 1000,
        size: item.size || 0,
        fsId: item.fs_id,
        md5: item.md5
      });
    }

    return result;
  }
}
