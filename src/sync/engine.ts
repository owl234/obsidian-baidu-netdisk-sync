import { BaiduSyncSettings } from "../settings/settings";
import { BaiduClient } from "../baidu/client";
import { BaiduUploader } from "../baidu/uploader";
import { BaiduDownloader } from "../baidu/downloader";
import { BaiduFileMeta, sanitizeErrorMessage } from "../baidu/types";
import { ManifestManager } from "./manifest";
import { SyncFilter } from "./filter";
import { AsyncQueue } from "./queue";
import {
  SyncPlanner,
  SyncPlanItem,
  LocalFileInfo,
  RemoteFileInfo,
  buildConflictPath
} from "./planner";
import { md5 } from "../crypto/md5";
import { t } from "../i18n";

export type SyncState = "idle" | "preparing" | "diffing" | "syncing" | "error";

export interface SyncLogEntry {
  timestamp: number;
  level: "info" | "success" | "warn" | "error";
  message: string;
  detail?: string;
}

export interface SyncStats {
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflicts: number;
  skipped: number;
  errors: number;
}

export interface VaultFileStat {
  type: "file" | "folder";
  mtime: number;
  size: number;
}

export interface VaultSyncBridge {
  configDir: string;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<VaultFileStat | null>;
  list(dir: string): Promise<{ files: string[]; folders: string[] }>;
  mkdir(path: string): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  trashFile(path: string): Promise<void>;
}

const ECHO_SUPPRESSION_MS = 3000;
const DELETE_BATCH_SIZE = 100;

function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  for (let i = 0; i < va.length; i++) {
    if (va[i] !== vb[i]) return false;
  }
  return true;
}

function normalizeRemoteBase(remoteBasePath: string): string {
  const trimmed = remoteBasePath.trim();
  if (!trimmed || trimmed === "/") return "";
  return trimmed.replace(/\/+$/, "");
}

export class SyncEngine {
  private state: SyncState = "idle";
  private lastStatusMessage: string = "";
  private filter: SyncFilter;
  private queue: AsyncQueue;
  private uploader: BaiduUploader;
  private downloader: BaiduDownloader;
  private logs: SyncLogEntry[] = [];
  private onStateChangeListeners: Array<(state: SyncState, message?: string) => void> = [];
  private onLogListeners: Array<(entry: SyncLogEntry) => void> = [];
  private recentSyncWrites = new Map<string, number>();

  constructor(
    private vault: VaultSyncBridge,
    private getSettings: () => BaiduSyncSettings,
    private saveSettings: (settings: BaiduSyncSettings) => Promise<void>,
    private client: BaiduClient,
    private manifest: ManifestManager,
    pluginDir: string = ""
  ) {
    const settings = this.getSettings();
    this.filter = new SyncFilter(settings, this.vault.configDir, pluginDir);
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
    this.lastStatusMessage = message ?? "";
    for (const listener of this.onStateChangeListeners) {
      listener(state, message);
    }
  }

  getState(): SyncState {
    return this.state;
  }

  getLastStatusMessage(): string {
    return this.lastStatusMessage;
  }

  isSyncing(): boolean {
    return this.state !== "idle" && this.state !== "error";
  }

  getLogs(): SyncLogEntry[] {
    return [...this.logs];
  }

  /**
   * Returns true if the given vault path was written or deleted by the sync engine
   * within the echo suppression window (prevents save-trigger ping-pong loops).
   */
  wasRecentlyWrittenBySync(path: string): boolean {
    const ts = this.recentSyncWrites.get(path);
    if (ts === undefined) return false;
    if (Date.now() - ts <= ECHO_SUPPRESSION_MS) {
      return true;
    }
    this.recentSyncWrites.delete(path);
    return false;
  }

  private markSyncWrite(path: string): void {
    const now = Date.now();
    this.recentSyncWrites.set(path, now);
    if (this.recentSyncWrites.size > 500) {
      for (const [k, ts] of this.recentSyncWrites) {
        if (now - ts > ECHO_SUPPRESSION_MS) {
          this.recentSyncWrites.delete(k);
        }
      }
    }
  }

  addLog(level: "info" | "success" | "warn" | "error", message: string, detail?: string): void {
    const entry: SyncLogEntry = {
      timestamp: Date.now(),
      level,
      message: sanitizeErrorMessage(message),
      detail: detail ? sanitizeErrorMessage(detail) : undefined
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

  private getMaxBytes(settings: BaiduSyncSettings): number {
    return settings.maxFileSizeMB > 0 ? settings.maxFileSizeMB * 1024 * 1024 : Infinity;
  }

  private isOversized(size: number, settings: BaiduSyncSettings, path: string): boolean {
    const maxBytes = this.getMaxBytes(settings);
    if (size > maxBytes) {
      const sizeMB = (size / (1024 * 1024)).toFixed(1);
      this.addLog(
        "warn",
        t("engine.skippedMaxSize", {
          sizeMB,
          limitMB: settings.maxFileSizeMB,
          path
        })
      );
      return true;
    }
    return false;
  }

  private async ensureParentDir(filePath: string, ensuredDirs: Set<string>): Promise<void> {
    const lastSlash = filePath.lastIndexOf("/");
    if (lastSlash <= 0) return;
    const fullDir = filePath.substring(0, lastSlash);
    if (ensuredDirs.has(fullDir)) return;

    const parts = fullDir.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!ensuredDirs.has(current)) {
        if (!(await this.vault.exists(current))) {
          await this.vault.mkdir(current);
        }
        ensuredDirs.add(current);
      }
    }
  }

  private async resolveUniqueConflictPath(originalPath: string): Promise<string> {
    const baseCandidate = buildConflictPath(originalPath);
    if (!(await this.vault.exists(baseCandidate))) {
      return baseCandidate;
    }

    const dotIdx = baseCandidate.lastIndexOf(".");
    const slashIdx = baseCandidate.lastIndexOf("/");
    const hasExt = dotIdx > slashIdx + 1;
    for (let i = 1; i <= 99; i++) {
      const candidate = hasExt
        ? `${baseCandidate.slice(0, dotIdx)}-${i}${baseCandidate.slice(dotIdx)}`
        : `${baseCandidate}-${i}`;
      if (!(await this.vault.exists(candidate))) {
        return candidate;
      }
    }
    return `${baseCandidate}-${Date.now()}`;
  }

  /**
   * For plaintext sync when manifest is absent (or both sides changed with same size),
   * lazily compute local MD5 only for same-size candidates so identical files skip transfer.
   */
  private async populateCandidateLocalMd5(
    localFiles: Map<string, LocalFileInfo>,
    remoteFiles: Map<string, RemoteFileInfo>,
    settings: BaiduSyncSettings
  ): Promise<void> {
    if (settings.enableE2EE) return;
    const manifestAll = this.manifest.getAll();
    const maxBytes = this.getMaxBytes(settings);

    for (const [path, local] of localFiles) {
      const remote = remoteFiles.get(path);
      if (!remote || !remote.md5) continue;
      if (local.size !== remote.size || local.size > maxBytes) continue;

      const manifestItem = manifestAll[path];
      if (manifestItem) {
        const localChanged =
          Math.abs(local.mtime - manifestItem.mtime) > 1000 || local.size !== manifestItem.size;
        const expectedRemoteSize =
          manifestItem.remoteSize !== undefined ? manifestItem.remoteSize : manifestItem.size;
        const remoteChanged =
          Math.abs(remote.mtime - manifestItem.remoteMtime) > 1000 ||
          remote.size !== expectedRemoteSize;
        if (!(localChanged && remoteChanged)) continue;
      }

      try {
        const buf = await this.vault.readBinary(path);
        local.md5 = md5(buf);
      } catch {
        // Ignore read error here; transfer phase handles it
      }
    }
  }

  async startSync(_silent = false): Promise<{ success: boolean; stats: SyncStats }> {
    const stats: SyncStats = {
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      skipped: 0,
      errors: 0
    };

    if (this.state !== "idle" && this.state !== "error") {
      this.addLog("warn", t("engine.alreadyRunning"));
      return { success: false, stats };
    }

    const settings = this.getSettings();
    if (!settings.accessToken) {
      this.addLog("error", t("engine.notAuthorized"));
      this.setState("error", t("engine.stateNotAuthorized"));
      return { success: false, stats };
    }

    this.filter.updateSettings(settings);
    this.queue.setConcurrency(settings.concurrency || 3);

    const startTime = Date.now();
    const ensuredDirs = new Set<string>();

    try {
      this.setState("preparing", t("engine.loadingManifest"));
      await this.manifest.load();

      // Step 1: Scan local files
      this.setState("diffing", t("engine.scanningLocal"));
      const localFiles = await this.scanLocalFiles();

      // Step 2: Scan remote files
      this.setState("diffing", t("engine.scanningRemote"));
      const remoteFiles = await this.scanRemoteFiles(settings.remoteBasePath);

      // Step 3: Compute local MD5 for plaintext dedup candidates & build diff plan
      this.setState("diffing", t("engine.computingPlan"));
      await this.populateCandidateLocalMd5(localFiles, remoteFiles, settings);

      const plans = SyncPlanner.plan(
        localFiles,
        remoteFiles,
        this.manifest.getAll(),
        settings.remoteBasePath,
        {
          conflictStrategy: settings.conflictStrategy,
          enableE2EE: settings.enableE2EE
        }
      );

      if (plans.length === 0) {
        this.addLog("info", t("engine.upToDate"));
        this.setState("idle", t("engine.stateUpToDate"));
        return { success: true, stats };
      }

      this.addLog("info", t("engine.planReady", { count: plans.length }));

      // Step 4: Pre-fetch file metadata (dlinks) in batches of 100 for DOWNLOAD & CONFLICT items
      const downloadFsIds: Array<string | number> = [];
      for (const item of plans) {
        if ((item.action === "DOWNLOAD" || item.action === "CONFLICT") && item.remote?.fsId) {
          if (!this.isOversized(item.remote.size, settings, item.path)) {
            downloadFsIds.push(item.remote.fsId);
          }
        }
      }
      let prefetchedMetas = new Map<string, BaiduFileMeta>();
      if (downloadFsIds.length > 0) {
        prefetchedMetas = await this.client.getFileMetas(downloadFsIds);
      }

      // Separate batchable DELETE_REMOTE operations from concurrent file operations
      const remoteDeleteItems = plans.filter((p) => p.action === "DELETE_REMOTE");
      const otherItems = plans.filter((p) => p.action !== "DELETE_REMOTE");

      const totalOps = plans.length;
      let processed = 0;
      this.setState("syncing", t("engine.syncProgress", { done: 0, total: totalOps }));

      // Execute batched remote deletions first (up to 100 paths per API call)
      for (let i = 0; i < remoteDeleteItems.length; i += DELETE_BATCH_SIZE) {
        const batch = remoteDeleteItems.slice(i, i + DELETE_BATCH_SIZE);
        const remotePaths = batch.map((b) => b.remotePath);
        try {
          await this.client.deleteFiles(remotePaths);
          for (const b of batch) {
            this.manifest.delete(b.path);
          }
          stats.deleted += batch.length;
          if (batch.length === 1) {
            this.addLog("info", t("engine.deleteRemoteSuccess", { path: batch[0].path }));
          } else {
            this.addLog("info", t("engine.batchDeleteRemoteSuccess", { count: batch.length }));
          }
        } catch (err: unknown) {
          stats.errors += batch.length;
          const msg = err instanceof Error ? err.message : String(err);
          this.addLog(
            "error",
            t("engine.itemFailed", { path: batch.map((b) => b.path).join(", ") }),
            msg
          );
        } finally {
          processed += batch.length;
          this.setState("syncing", t("engine.syncProgress", { done: processed, total: totalOps }));
        }
      }

      // Execute remaining items with true concurrency via AsyncQueue
      const tasks = otherItems.map((item) =>
        this.queue.add(async () => {
          try {
            const outcome = await this.executePlanItem(item, settings, prefetchedMetas, ensuredDirs);
            if (outcome === "uploaded") stats.uploaded++;
            else if (outcome === "downloaded") stats.downloaded++;
            else if (outcome === "deleted") stats.deleted++;
            else if (outcome === "conflict") stats.conflicts++;
            else if (outcome === "skipped") stats.skipped++;
          } catch (err: unknown) {
            stats.errors++;
            const msg = err instanceof Error ? err.message : String(err);
            this.addLog("error", t("engine.itemFailed", { path: item.path }), msg);
          } finally {
            processed++;
            this.setState("syncing", t("engine.syncProgress", { done: processed, total: totalOps }));
          }
        })
      );

      await Promise.all(tasks);
      await this.queue.waitAll();

      // Step 5: Save manifest and sync timestamp
      this.manifest.updateLastSyncTime();
      await this.manifest.save();

      settings.lastSyncTime = Date.now();
      await this.saveSettings(settings);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const summary = t("engine.summary", {
        elapsed,
        uploaded: stats.uploaded,
        downloaded: stats.downloaded,
        deleted: stats.deleted,
        conflicts: stats.conflicts,
        skipped: stats.skipped,
        errors: stats.errors
      });
      this.addLog(stats.errors > 0 ? "warn" : "success", summary);

      this.setState("idle", t("engine.stateComplete"));
      return { success: stats.errors === 0, stats };
    } catch (err: unknown) {
      const msg = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
      this.addLog("error", t("engine.fatalError"), msg);
      this.setState("error", msg);
      return { success: false, stats };
    }
  }

  private async downloadItemBuffer(
    item: SyncPlanItem,
    settings: BaiduSyncSettings,
    prefetchedMetas: Map<string, BaiduFileMeta>
  ): Promise<ArrayBuffer> {
    if (!item.remote?.fsId) {
      throw new Error(t("engine.missingFsId", { path: item.path }));
    }
    const meta = prefetchedMetas.get(String(item.remote.fsId));
    if (meta && meta.dlink) {
      return this.downloader.downloadWithMeta(meta, {
        e2eePassword: settings.e2eePassword
      });
    }
    return this.downloader.downloadByFsId(item.remote.fsId, {
      e2eePassword: settings.e2eePassword
    });
  }

  private async executePlanItem(
    item: SyncPlanItem,
    settings: BaiduSyncSettings,
    prefetchedMetas: Map<string, BaiduFileMeta>,
    ensuredDirs: Set<string>
  ): Promise<"uploaded" | "downloaded" | "deleted" | "conflict" | "skipped" | "none"> {
    switch (item.action) {
      case "UPLOAD": {
        if (!(await this.vault.exists(item.path))) {
          return "none";
        }
        const stat = await this.vault.stat(item.path);
        if (stat && this.isOversized(stat.size, settings, item.path)) {
          return "skipped";
        }
        const buffer = await this.vault.readBinary(item.path);
        if (this.isOversized(buffer.byteLength, settings, item.path)) {
          return "skipped";
        }
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
          size: stat?.size ?? buffer.byteLength,
          remoteSize: res.size,
          fsId: res.fs_id
        });
        this.addLog("success", t("engine.uploadSuccess", { path: item.path }));
        return "uploaded";
      }

      case "DOWNLOAD": {
        if (!item.remote?.fsId) {
          throw new Error(t("engine.missingFsId", { path: item.path }));
        }
        if (this.isOversized(item.remote.size, settings, item.path)) {
          return "skipped";
        }

        const buffer = await this.downloadItemBuffer(item, settings, prefetchedMetas);

        await this.ensureParentDir(item.path, ensuredDirs);
        this.markSyncWrite(item.path);
        await this.vault.writeBinary(item.path, buffer);
        const stat = await this.vault.stat(item.path);

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
        this.addLog("success", t("engine.downloadSuccess", { path: item.path }));
        return "downloaded";
      }

      case "CONFLICT": {
        if (!item.remote?.fsId || !item.local) {
          throw new Error(t("engine.missingFsId", { path: item.path }));
        }
        if (
          this.isOversized(item.local.size, settings, item.path) ||
          this.isOversized(item.remote.size, settings, item.path)
        ) {
          return "skipped";
        }

        const [localBuffer, remoteBuffer] = await Promise.all([
          this.vault.readBinary(item.path),
          this.downloadItemBuffer(item, settings, prefetchedMetas)
        ]);

        // If decrypted contents are byte-for-byte identical, skip creating any conflict copy
        if (buffersEqual(localBuffer, remoteBuffer)) {
          const stat = await this.vault.stat(item.path);
          this.manifest.set({
            path: item.path,
            remotePath: item.remotePath,
            mtime: stat?.mtime || item.local.mtime,
            remoteMtime: item.remote.mtime,
            md5: item.remote.md5 || "",
            size: localBuffer.byteLength,
            remoteSize: item.remote.size,
            fsId: item.remote.fsId
          });
          this.addLog("info", t("engine.conflictIdentical", { path: item.path }));
          return "none";
        }

        const conflictPath = await this.resolveUniqueConflictPath(item.path);
        const cleanBase = normalizeRemoteBase(settings.remoteBasePath);
        const conflictRemotePath = `${cleanBase}/${conflictPath}`;
        const winner = item.winner ?? (item.local.mtime >= item.remote.mtime ? "local" : "remote");

        await this.ensureParentDir(conflictPath, ensuredDirs);

        if (winner === "local") {
          // Preserve remote version as conflict copy locally & remotely, then push local as main
          this.markSyncWrite(conflictPath);
          await this.vault.writeBinary(conflictPath, remoteBuffer);
          const conflictStat = await this.vault.stat(conflictPath);
          const conflictUploadRes = await this.uploader.uploadFile(conflictRemotePath, remoteBuffer, {
            enableE2EE: settings.enableE2EE,
            e2eePassword: settings.e2eePassword
          });
          this.manifest.set({
            path: conflictPath,
            remotePath: conflictRemotePath,
            mtime: conflictStat?.mtime || Date.now(),
            remoteMtime: (conflictUploadRes.mtime || Math.floor(Date.now() / 1000)) * 1000,
            md5: conflictUploadRes.md5 || "",
            size: remoteBuffer.byteLength,
            remoteSize: conflictUploadRes.size,
            fsId: conflictUploadRes.fs_id
          });

          const localStat = await this.vault.stat(item.path);
          const mainUploadRes = await this.uploader.uploadFile(item.remotePath, localBuffer, {
            enableE2EE: settings.enableE2EE,
            e2eePassword: settings.e2eePassword
          });
          this.manifest.set({
            path: item.path,
            remotePath: item.remotePath,
            mtime: localStat?.mtime || item.local.mtime,
            remoteMtime: (mainUploadRes.mtime || Math.floor(Date.now() / 1000)) * 1000,
            md5: mainUploadRes.md5 || "",
            size: localBuffer.byteLength,
            remoteSize: mainUploadRes.size,
            fsId: mainUploadRes.fs_id
          });
        } else {
          // Preserve local version as conflict copy locally & remotely, then apply remote as main
          this.markSyncWrite(conflictPath);
          await this.vault.writeBinary(conflictPath, localBuffer);
          const conflictStat = await this.vault.stat(conflictPath);
          const conflictUploadRes = await this.uploader.uploadFile(conflictRemotePath, localBuffer, {
            enableE2EE: settings.enableE2EE,
            e2eePassword: settings.e2eePassword
          });
          this.manifest.set({
            path: conflictPath,
            remotePath: conflictRemotePath,
            mtime: conflictStat?.mtime || Date.now(),
            remoteMtime: (conflictUploadRes.mtime || Math.floor(Date.now() / 1000)) * 1000,
            md5: conflictUploadRes.md5 || "",
            size: localBuffer.byteLength,
            remoteSize: conflictUploadRes.size,
            fsId: conflictUploadRes.fs_id
          });

          this.markSyncWrite(item.path);
          await this.vault.writeBinary(item.path, remoteBuffer);
          const mainStat = await this.vault.stat(item.path);
          this.manifest.set({
            path: item.path,
            remotePath: item.remotePath,
            mtime: mainStat?.mtime || Date.now(),
            remoteMtime: item.remote.mtime,
            md5: item.remote.md5 || "",
            size: remoteBuffer.byteLength,
            remoteSize: item.remote.size,
            fsId: item.remote.fsId
          });
        }

        this.addLog("warn", t("engine.conflictPreserved", { path: item.path, conflictPath }));
        return "conflict";
      }

      case "UPDATE_MANIFEST": {
        if (item.local && item.remote) {
          this.manifest.set({
            path: item.path,
            remotePath: item.remotePath,
            mtime: item.local.mtime,
            remoteMtime: item.remote.mtime,
            md5: item.remote.md5 || item.local.md5 || "",
            size: item.local.size,
            remoteSize: item.remote.size,
            fsId: item.remote.fsId
          });
        }
        return "none";
      }

      case "DELETE_LOCAL": {
        if (await this.vault.exists(item.path)) {
          this.markSyncWrite(item.path);
          await this.vault.trashFile(item.path);
          this.addLog("info", t("engine.deleteLocalSuccess", { path: item.path }));
        }
        this.manifest.delete(item.path);
        return "deleted";
      }

      case "CLEAN_MANIFEST": {
        this.manifest.delete(item.path);
        return "none";
      }

      default:
        return "none";
    }
  }

  async convertVaultToPlaintext(
    onProgress?: (processed: number, total: number, currentPath: string) => void
  ): Promise<{ success: boolean; total: number; skipped: number; errors: number }> {
    if (this.state !== "idle" && this.state !== "error") {
      throw new Error(t("migration.alreadyRunning"));
    }

    const settings = this.getSettings();
    if (!settings.accessToken) {
      throw new Error(t("migration.notAuthorized"));
    }

    this.addLog("info", t("migration.step1Log"));
    const pullResult = await this.startSync(false);
    // Abort on ANY pre-sync failure (including fatal network errors where stats.errors may be 0)
    if (!pullResult.success) {
      throw new Error(t("migration.step1Failed", { errors: pullResult.stats.errors }));
    }

    this.filter.updateSettings(settings);
    this.queue.setConcurrency(settings.concurrency || 3);

    try {
      this.setState("diffing", t("migration.scanningLocal"));
      const localFiles = await this.scanLocalFiles();
      const total = localFiles.size;
      let processed = 0;
      let skipped = 0;
      let errors = 0;

      this.addLog("info", t("migration.step2Log", { total }));

      const cleanBase = normalizeRemoteBase(settings.remoteBasePath);
      this.setState("syncing", t("migration.step2Progress", { done: 0, total }));

      const entries = Array.from(localFiles.entries());
      const tasks = entries.map(([path, fileInfo]) =>
        this.queue.add(async () => {
          try {
            if (!(await this.vault.exists(path))) {
              return;
            }
            if (this.isOversized(fileInfo.size, settings, path)) {
              skipped++;
              return;
            }
            const buffer = await this.vault.readBinary(path);
            if (this.isOversized(buffer.byteLength, settings, path)) {
              skipped++;
              return;
            }
            const stat = await this.vault.stat(path);
            const localMtime = stat?.mtime || Date.now();
            const remotePath = `${cleanBase}/${path}`;

            // Explicitly upload with enableE2EE: false -> Pure Plaintext
            const res = await this.uploader.uploadFile(remotePath, buffer, {
              enableE2EE: false
            });

            this.manifest.set({
              path: path,
              remotePath: remotePath,
              mtime: localMtime,
              remoteMtime: (res.mtime || Math.floor(Date.now() / 1000)) * 1000,
              md5: res.md5 || "",
              size: stat?.size ?? buffer.byteLength,
              remoteSize: res.size,
              fsId: res.fs_id
            });
            this.addLog("success", t("migration.uploadSuccess", { path }));
          } catch (err: unknown) {
            errors++;
            const msg = err instanceof Error ? err.message : String(err);
            this.addLog("error", t("migration.uploadFailed", { path }), msg);
          } finally {
            processed++;
            onProgress?.(processed, total, path);
            this.setState("syncing", t("migration.step2Progress", { done: processed, total }));
          }
        })
      );

      await Promise.all(tasks);
      await this.queue.waitAll();

      this.manifest.updateLastSyncTime();
      await this.manifest.save();

      settings.lastSyncTime = Date.now();
      await this.saveSettings(settings);

      this.setState("idle", t("migration.stateDone"));
      const summary = t("migration.summary", { processed, total, skipped, errors });
      this.addLog(errors > 0 ? "warn" : "success", summary);

      return { success: errors === 0, total, skipped, errors };
    } catch (err: unknown) {
      const msg = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
      this.addLog("error", t("engine.fatalError"), msg);
      this.setState("error", msg);
      throw new Error(msg);
    }
  }

  private async scanLocalFiles(): Promise<Map<string, LocalFileInfo>> {
    const result = new Map<string, LocalFileInfo>();
    const visitedDirs = new Set<string>();

    const scanDirectory = async (dir: string) => {
      const normDir = dir.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
      if (visitedDirs.has(normDir)) {
        return;
      }
      visitedDirs.add(normDir);

      const list = await this.vault.list(normDir);

      for (const file of list.files) {
        if (this.filter.shouldIgnore(file)) {
          continue;
        }
        const stat = await this.vault.stat(file);
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

    // Scan config directory only if enabled and not already visited during root scan
    const settings = this.getSettings();
    const configDir = this.vault.configDir.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (
      settings.syncObsidianConfig &&
      configDir &&
      !visitedDirs.has(configDir) &&
      (await this.vault.exists(configDir))
    ) {
      await scanDirectory(configDir);
    }

    return result;
  }

  private async scanRemoteFiles(remoteBasePath: string): Promise<Map<string, RemoteFileInfo>> {
    const result = new Map<string, RemoteFileInfo>();
    const cleanBase = normalizeRemoteBase(remoteBasePath);
    const listRoot = cleanBase || "/";
    const expectedPrefix = cleanBase ? `${cleanBase}/` : "/";

    const items = await this.client.listAll(listRoot);

    for (const item of items) {
      if (item.isdir === 1) {
        continue;
      }

      if (!item.path.startsWith(expectedPrefix)) {
        continue;
      }

      const relativePath = item.path.slice(expectedPrefix.length);
      if (!relativePath || this.filter.shouldIgnore(relativePath)) {
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
