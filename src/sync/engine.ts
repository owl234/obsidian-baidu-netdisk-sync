import { BaiduSyncSettings } from "../settings/settings";
import { BaiduClient } from "../baidu/client";
import { BaiduUploader } from "../baidu/uploader";
import { BaiduDownloader } from "../baidu/downloader";
import { BaiduFileMeta, FatalApiError, sanitizeErrorMessage } from "../baidu/types";
import { ManifestItem, ManifestManager, ManifestStorageAdapter } from "./manifest";
import {
  RemoteTombstoneShardRef,
  TombstoneEntry,
  TombstoneManager,
  buildRemoteTombstonePath,
  extractTombstoneDeviceId,
  generateDeviceId,
  isValidDeviceId
} from "./tombstone";
import { SyncFilter } from "./filter";
import { AsyncQueue, QueueCancelledError } from "./queue";
import {
  BRIDGE_PROBE_TIMEOUT_MS,
  BridgeDeadlockError,
  FS_BINARY_TIMEOUT_MS,
  FS_META_TIMEOUT_MS,
  OperationTimeoutError,
  withTimeout
} from "./timeout";
import {
  SyncPlanner,
  SyncPlanItem,
  LocalFileInfo,
  RemoteFileInfo,
  buildConflictPath,
  getBaselinePlainMd5
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
  /**
   * Optional zero-IPC fast stat using Obsidian's in-memory TFile index.
   * Falls back to adapter.stat() when omitted or for unindexed files (e.g. configDir).
   */
  statFast?(path: string): Promise<VaultFileStat | null>;
  list(dir: string): Promise<{ files: string[]; folders: string[] }>;
  mkdir(path: string): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  trashFile(path: string): Promise<void>;
}

export interface SyncEngineOptions {
  fsMetaTimeoutMs?: number;
  fsBinaryTimeoutMs?: number;
  bridgeProbeTimeoutMs?: number;
  checkpointItems?: number;
  checkpointIntervalMs?: number;
  massDeleteMinCount?: number;
  massDeleteRatio?: number;
  emptySideGuardMinManifest?: number;
  tombstones?: TombstoneManager;
  tombstoneRetentionMs?: number;
  tombstoneRetiredShardGraceMs?: number;
  tombstoneMaxEntriesPerDevice?: number;
  e2eeMd5BackfillMaxFiles?: number;
  e2eeMd5BackfillMaxBytes?: number;
}

interface SyncRunContext {
  readonly runId: number;
  readonly queue: AsyncQueue;
  bridgeDead: boolean;
  bridgeError: BridgeDeadlockError | null;
  probePromise: Promise<boolean> | null;
  readonly abortPromise: Promise<never>;
  abortRun: (err: BridgeDeadlockError) => void;
  isCurrent: () => boolean;
  exists: (path: string) => Promise<boolean>;
  stat: (path: string) => Promise<VaultFileStat | null>;
  statFast: (path: string) => Promise<VaultFileStat | null>;
  list: (dir: string) => Promise<{ files: string[]; folders: string[] }>;
  mkdir: (path: string) => Promise<void>;
  readBinary: (path: string) => Promise<ArrayBuffer>;
  writeBinary: (path: string, data: ArrayBuffer) => Promise<void>;
  trashFile: (path: string) => Promise<void>;
}

const ECHO_SUPPRESSION_MS = 3000;
const DELETE_BATCH_SIZE = 100;
const DEFAULT_CHECKPOINT_ITEMS = 25;
const DEFAULT_CHECKPOINT_INTERVAL_MS = 20_000;
const DEFAULT_MASS_DELETE_MIN_COUNT = 10;
const DEFAULT_MASS_DELETE_RATIO = 0.5;
const DEFAULT_EMPTY_SIDE_GUARD_MIN_MANIFEST = 5;
const DEFAULT_E2EE_BACKFILL_MAX_FILES = 50;
const DEFAULT_E2EE_BACKFILL_MAX_BYTES = 16 * 1024 * 1024;

function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  for (let i = 0; i < va.length; i++) {
    if (va[i] !== vb[i]) return false;
  }
  return true;
}

export type StaleSyncResolution = "trust-cloud" | "merge-upload";

export interface StaleGuardInfo {
  reason: "empty-baseline" | "stale-days";
  uploadCount: number;
  remoteCount: number;
  staleDays: number;
  samplePaths: string[];
}

export interface SyncRunOptions {
  bypassMassDeleteGuard?: boolean;
  staleResolution?: StaleSyncResolution;
}

export interface SyncRunResult {
  success: boolean;
  stats: SyncStats;
  bridgeDead?: boolean;
  massDeleteAborted?: boolean;
  manifestCorrupted?: boolean;
  staleGuardAborted?: boolean;
}

export function normalizeAndValidateRemoteBasePath(raw: string): {
  normalized: string;
  error?: string;
} {
  const trimmed = (raw || "").trim().replace(/\\/g, "/");
  if (!trimmed) {
    return { normalized: "", error: t("engine.invalidRemoteBasePath") };
  }
  let collapsed = trimmed.replace(/\/+/g, "/");
  if (!collapsed.startsWith("/")) {
    collapsed = `/${collapsed}`;
  }
  collapsed = collapsed.replace(/\/+$/, "");
  if (!collapsed || collapsed === "/") {
    return { normalized: "", error: t("engine.invalidRemoteBasePath") };
  }
  const segments = collapsed.split("/").filter(Boolean);
  if (segments.some((seg) => seg === "." || seg === "..")) {
    return { normalized: "", error: t("engine.invalidRemoteBasePath") };
  }
  return { normalized: collapsed.normalize("NFC") };
}

function normalizeRemoteBase(remoteBasePath: string): string {
  const { normalized } = normalizeAndValidateRemoteBasePath(remoteBasePath);
  if (normalized) return normalized;
  const trimmed = (remoteBasePath || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "";
  return trimmed.startsWith("/") ? trimmed.normalize("NFC") : `/${trimmed}`.normalize("NFC");
}

function isLikelyExpiredDlinkError(err: unknown): boolean {
  if (!(err instanceof FatalApiError)) return false;
  return err.code === 31360 || err.code === 403 || err.code === 400;
}

export class SyncEngine {
  private state: SyncState = "idle";
  private lastStatusMessage: string = "";
  private filter: SyncFilter;
  private uploader: BaiduUploader;
  private downloader: BaiduDownloader;
  private logs: SyncLogEntry[] = [];
  private onStateChangeListeners: Array<(state: SyncState, message?: string) => void> = [];
  private onLogListeners: Array<(entry: SyncLogEntry) => void> = [];
  private recentSyncWrites = new Map<string, number>();

  // Strict single-flight run tracking & generation counter to prevent re-entrancy
  private runSeq = 0;
  private activeRunId: number | null = null;
  private activeCtx: SyncRunContext | null = null;
  private migrationActive = false;
  private lastRunMassDeleteAborted = false;
  private lastRunManifestCorrupted = false;
  private lastRunStaleGuardAborted = false;
  private lastStaleGuardInfo: StaleGuardInfo | null = null;
  private readonly tombstones: TombstoneManager;

  private readonly fsMetaTimeoutMs: number;
  private readonly fsBinaryTimeoutMs: number;
  private readonly bridgeProbeTimeoutMs: number;
  private readonly checkpointItems: number;
  private readonly checkpointIntervalMs: number;
  private readonly massDeleteMinCount: number;
  private readonly massDeleteRatio: number;
  private readonly emptySideGuardMinManifest: number;
  private readonly e2eeMd5BackfillMaxFiles: number;
  private readonly e2eeMd5BackfillMaxBytes: number;

  constructor(
    private vault: VaultSyncBridge,
    private getSettings: () => BaiduSyncSettings,
    private saveSettings: (settings: BaiduSyncSettings) => Promise<void>,
    private client: BaiduClient,
    private manifest: ManifestManager,
    pluginDir: string = "",
    options: SyncEngineOptions = {}
  ) {
    const settings = this.getSettings();
    this.filter = new SyncFilter(settings, this.vault.configDir, pluginDir);
    this.uploader = new BaiduUploader(this.client);
    this.downloader = new BaiduDownloader(this.client);
    this.fsMetaTimeoutMs = options.fsMetaTimeoutMs ?? FS_META_TIMEOUT_MS;
    this.fsBinaryTimeoutMs = options.fsBinaryTimeoutMs ?? FS_BINARY_TIMEOUT_MS;
    this.bridgeProbeTimeoutMs = options.bridgeProbeTimeoutMs ?? BRIDGE_PROBE_TIMEOUT_MS;
    this.checkpointItems = options.checkpointItems ?? DEFAULT_CHECKPOINT_ITEMS;
    this.checkpointIntervalMs = options.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS;
    this.massDeleteMinCount = options.massDeleteMinCount ?? DEFAULT_MASS_DELETE_MIN_COUNT;
    this.massDeleteRatio = options.massDeleteRatio ?? DEFAULT_MASS_DELETE_RATIO;
    this.emptySideGuardMinManifest =
      options.emptySideGuardMinManifest ?? DEFAULT_EMPTY_SIDE_GUARD_MIN_MANIFEST;
    this.e2eeMd5BackfillMaxFiles =
      options.e2eeMd5BackfillMaxFiles ?? DEFAULT_E2EE_BACKFILL_MAX_FILES;
    this.e2eeMd5BackfillMaxBytes =
      options.e2eeMd5BackfillMaxBytes ?? DEFAULT_E2EE_BACKFILL_MAX_BYTES;

    if (options.tombstones) {
      this.tombstones = options.tombstones;
    } else {
      const fallbackPluginDir = this.vault.configDir
        ? `${this.vault.configDir}/plugins/baidu-netdisk-sync`
        : "plugins/baidu-netdisk-sync";
      const cleanPluginDir = (pluginDir || fallbackPluginDir)
        .replace(/\\/g, "/")
        .replace(/^\/+/, "")
        .replace(/\/+$/, "");
      const textAdapter: ManifestStorageAdapter = {
        exists: (p: string) => this.vault.exists(p),
        mkdir: (p: string) => this.vault.mkdir(p),
        read: async (p: string) => new TextDecoder().decode(await this.vault.readBinary(p)),
        write: async (p: string, data: string) => {
          const encoded = new TextEncoder().encode(data).slice().buffer;
          await this.vault.writeBinary(p, encoded);
        }
      };
      this.tombstones = new TombstoneManager(textAdapter, `${cleanPluginDir}/tombstone_cache.json`, {
        adapterTimeoutMs: this.fsMetaTimeoutMs,
        retentionMs: options.tombstoneRetentionMs,
        retiredShardGraceMs: options.tombstoneRetiredShardGraceMs,
        maxEntriesPerDevice: options.tombstoneMaxEntriesPerDevice
      });
    }
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
    return (
      this.activeRunId !== null ||
      this.migrationActive ||
      (this.state !== "idle" && this.state !== "error")
    );
  }

  getLogs(): SyncLogEntry[] {
    return [...this.logs];
  }

  wasLastRunMassDeleteAborted(): boolean {
    return this.lastRunMassDeleteAborted;
  }

  wasLastRunManifestCorrupted(): boolean {
    return this.lastRunManifestCorrupted;
  }

  wasLastRunStaleGuardAborted(): boolean {
    return this.lastRunStaleGuardAborted;
  }

  getLastStaleGuardInfo(): StaleGuardInfo | null {
    return this.lastStaleGuardInfo ? { ...this.lastStaleGuardInfo, samplePaths: [...this.lastStaleGuardInfo.samplePaths] } : null;
  }

  getTombstoneManager(): TombstoneManager {
    return this.tombstones;
  }

  async resetTombstoneCache(): Promise<void> {
    if (this.isSyncing()) {
      throw new Error(t("engine.alreadyRunning"));
    }
    const { normalized } = normalizeAndValidateRemoteBasePath(this.getSettings().remoteBasePath);
    await this.tombstones.resetCache(normalized || undefined);
  }

  /**
   * Cleanly cancels any active sync or migration run (e.g. on plugin unload).
   */
  abortActiveSync(): void {
    this.runSeq++;
    const ctx = this.activeCtx;
    if (ctx) {
      ctx.queue.clear(new QueueCancelledError("Plugin unloaded"));
    }
  }

  /**
   * Explicitly resets the local sync_manifest.json baseline without deleting
   * any local or remote files. Next sync safely re-indexes both sides.
   */
  async resetLocalBaseline(): Promise<void> {
    if (this.isSyncing()) {
      throw new Error(t("engine.alreadyRunning"));
    }
    const { normalized } = normalizeAndValidateRemoteBasePath(this.getSettings().remoteBasePath);
    await this.manifest.resetBaseline(normalized || undefined);
    this.lastRunMassDeleteAborted = false;
    this.lastRunManifestCorrupted = false;
    this.lastRunStaleGuardAborted = false;
    this.lastStaleGuardInfo = null;
    this.addLog("warn", t("engine.manifestBaselineReset"));
    this.setState("idle", t("statusBar.ready"));
  }

  shouldIgnore(path: string, isDir = false): boolean {
    this.filter.updateSettings(this.getSettings());
    return this.filter.shouldIgnore(path, isDir);
  }

  /**
   * Returns true if the given vault path was written or deleted by the sync engine
   * within the echo suppression window (prevents save-trigger ping-pong loops).
   */
  wasRecentlyWrittenBySync(path: string): boolean {
    const key = path.normalize("NFC");
    const ts = this.recentSyncWrites.get(key);
    if (ts === undefined) return false;
    if (Date.now() - ts <= ECHO_SUPPRESSION_MS) {
      return true;
    }
    this.recentSyncWrites.delete(key);
    return false;
  }

  private markSyncWrite(path: string): void {
    const key = path.normalize("NFC");
    const now = Date.now();
    this.recentSyncWrites.set(key, now);
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

  private async probeBridgeHealth(ctx: SyncRunContext): Promise<boolean> {
    if (ctx.bridgeDead) return false;
    if (ctx.probePromise) return ctx.probePromise;

    const probeTarget = this.vault.configDir || ".";
    const runProbe = async (): Promise<boolean> => {
      try {
        await withTimeout(
          this.vault.exists(probeTarget),
          this.bridgeProbeTimeoutMs,
          `bridge.probe(${probeTarget})`,
          "vault"
        );
        return true;
      } catch {
        ctx.bridgeDead = true;
        ctx.bridgeError = new BridgeDeadlockError(t("engine.bridgeDeadlock"));
        return false;
      }
    };

    const probe = runProbe().finally(() => {
      if (ctx.probePromise === probe) {
        ctx.probePromise = null;
      }
    });

    ctx.probePromise = probe;
    return probe;
  }

  private createRunContext(runId: number, concurrency: number): SyncRunContext {
    const queue = new AsyncQueue(concurrency);
    let rejectAbort!: (err: BridgeDeadlockError) => void;
    let aborted = false;

    const abortPromise = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    // Attach default handler to avoid unhandled rejection if abort fires before Promise.race
    abortPromise.catch(() => {});

    const ctx: SyncRunContext = {
      runId,
      queue,
      bridgeDead: false,
      bridgeError: null,
      probePromise: null,
      abortPromise,
      abortRun: (err: BridgeDeadlockError) => {
        if (aborted) return;
        aborted = true;
        ctx.bridgeDead = true;
        ctx.bridgeError = err;
        queue.clear(err);
        rejectAbort(err);
      },
      isCurrent: () => this.activeRunId === runId && this.runSeq === runId && !ctx.bridgeDead,
      exists: (path: string) =>
        this.runVaultOp(ctx, `exists(${path})`, this.fsMetaTimeoutMs, () => this.vault.exists(path)),
      stat: (path: string) =>
        this.runVaultOp(ctx, `stat(${path})`, this.fsMetaTimeoutMs, () => this.vault.stat(path)),
      statFast: (path: string) =>
        this.runVaultOp(ctx, `statFast(${path})`, this.fsMetaTimeoutMs, () =>
          this.vault.statFast ? this.vault.statFast(path) : this.vault.stat(path)
        ),
      list: (dir: string) =>
        this.runVaultOp(ctx, `list(${dir || "/"})`, this.fsMetaTimeoutMs, () => this.vault.list(dir)),
      mkdir: (path: string) =>
        this.runVaultOp(ctx, `mkdir(${path})`, this.fsMetaTimeoutMs, () => this.vault.mkdir(path)),
      readBinary: (path: string) =>
        this.runVaultOp(ctx, `readBinary(${path})`, this.fsBinaryTimeoutMs, () =>
          this.vault.readBinary(path)
        ),
      writeBinary: (path: string, data: ArrayBuffer) =>
        this.runVaultOp(ctx, `writeBinary(${path})`, this.fsBinaryTimeoutMs, () =>
          this.vault.writeBinary(path, data)
        ),
      trashFile: (path: string) =>
        this.runVaultOp(ctx, `trashFile(${path})`, this.fsMetaTimeoutMs, () =>
          this.vault.trashFile(path)
        )
    };

    return ctx;
  }

  private async runVaultOp<T>(
    ctx: SyncRunContext,
    opName: string,
    timeoutMs: number,
    fn: () => Promise<T>
  ): Promise<T> {
    if (ctx.bridgeDead) {
      throw ctx.bridgeError ?? new BridgeDeadlockError(t("engine.bridgeDeadlock"));
    }
    if (!ctx.isCurrent()) {
      throw new QueueCancelledError("Stale sync run cancelled");
    }

    try {
      return await withTimeout(fn(), timeoutMs, opName, "vault");
    } catch (err: unknown) {
      if (err instanceof OperationTimeoutError && err.kind === "vault") {
        if (ctx.isCurrent()) {
          this.addLog(
            "warn",
            t("engine.vaultTimeoutProbing", {
              op: opName,
              seconds: Math.max(1, Math.round(timeoutMs / 1000))
            })
          );
        }

        const alive = await this.probeBridgeHealth(ctx);
        if (!alive) {
          const deadlockErr = ctx.bridgeError ?? new BridgeDeadlockError(t("engine.bridgeDeadlock"));
          ctx.abortRun(deadlockErr);
          throw deadlockErr;
        }

        if (ctx.isCurrent()) {
          this.addLog("warn", t("engine.bridgeProbeAlive", { op: opName }));
        }
      }
      throw err;
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

  private async ensureParentDir(
    filePath: string,
    ensuredDirs: Set<string>,
    ctx: SyncRunContext
  ): Promise<void> {
    const lastSlash = filePath.lastIndexOf("/");
    if (lastSlash <= 0) return;
    const fullDir = filePath.substring(0, lastSlash);
    if (ensuredDirs.has(fullDir)) return;

    const parts = fullDir.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!ensuredDirs.has(current)) {
        if (!(await ctx.exists(current))) {
          await ctx.mkdir(current);
        }
        ensuredDirs.add(current);
      }
    }
  }

  private async resolveUniqueConflictPath(
    originalPath: string,
    remoteFiles: Map<string, RemoteFileInfo>,
    ctx: SyncRunContext
  ): Promise<string> {
    const isOccupied = async (candidate: string): Promise<boolean> => {
      if (remoteFiles.has(candidate.normalize("NFC"))) {
        return true;
      }
      return ctx.exists(candidate);
    };

    const baseCandidate = buildConflictPath(originalPath);
    if (!(await isOccupied(baseCandidate))) {
      return baseCandidate;
    }

    const dotIdx = baseCandidate.lastIndexOf(".");
    const slashIdx = baseCandidate.lastIndexOf("/");
    const hasExt = dotIdx > slashIdx + 1;
    for (let i = 1; i <= 99; i++) {
      const candidate = hasExt
        ? `${baseCandidate.slice(0, dotIdx)}-${i}${baseCandidate.slice(dotIdx)}`
        : `${baseCandidate}-${i}`;
      if (!(await isOccupied(candidate))) {
        return candidate;
      }
    }
    return `${baseCandidate}-${Date.now()}`;
  }

  /**
   * When zero-IPC statFast (Obsidian in-memory TFile.stat) reports a tracked file as modified,
   * verify against real disk stat before planning. This keeps 99.9% of unchanged files at 0 IPC
   * while eliminating false local-change / conflict triggers caused by lagging TFile.stat after
   * adapter.writeBinary or external editor writes.
   */
  private async reverifySuspectedLocalChanges(
    localFiles: Map<string, LocalFileInfo>,
    manifestFiles: Record<string, ManifestItem>,
    ctx: SyncRunContext
  ): Promise<void> {
    if (!this.vault.statFast) return;

    for (const [canonicalKey, local] of Array.from(localFiles.entries())) {
      if (!ctx.isCurrent()) return;
      const m = manifestFiles[canonicalKey];
      if (!m) continue;

      const suspectedChange =
        Math.abs(local.mtime - m.mtime) > 1000 ||
        local.size !== m.size ||
        this.wasRecentlyWrittenBySync(local.path);
      if (!suspectedChange) continue;

      const realStat = await ctx.stat(local.path);
      if (!realStat || realStat.type !== "file") {
        localFiles.delete(canonicalKey);
      } else {
        local.mtime = realStat.mtime;
        local.size = realStat.size;
      }
    }
  }

  private async tryCheckpoint(ctx: SyncRunContext, processed: number, totalOps: number): Promise<void> {
    try {
      const saved = await this.manifest.maybeCheckpoint(
        this.checkpointItems,
        this.checkpointIntervalMs
      );
      if (saved && ctx.isCurrent()) {
        this.addLog("info", t("engine.manifestCheckpoint", { done: processed, total: totalOps }));
      }
    } catch (err: unknown) {
      if (err instanceof OperationTimeoutError && err.kind === "vault") {
        const alive = await this.probeBridgeHealth(ctx);
        if (!alive) {
          const deadlockErr = ctx.bridgeError ?? new BridgeDeadlockError(t("engine.bridgeDeadlock"));
          ctx.abortRun(deadlockErr);
          return;
        }
      }
      if (ctx.isCurrent()) {
        const detail = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
        this.addLog("warn", t("engine.manifestSaveFailed", { detail }));
      }
    }
  }

  private async ensureDeviceId(settings: BaiduSyncSettings): Promise<string> {
    if (isValidDeviceId(settings.deviceId)) {
      return settings.deviceId;
    }
    const liveSettings = this.getSettings();
    if (isValidDeviceId(liveSettings.deviceId)) {
      settings.deviceId = liveSettings.deviceId;
      return liveSettings.deviceId;
    }
    const generated = generateDeviceId();
    settings.deviceId = generated;
    liveSettings.deviceId = generated;
    await this.saveSettings(liveSettings);
    return generated;
  }

  private async syncRemoteTombstoneShards(
    remoteShards: RemoteTombstoneShardRef[],
    currentDeviceId: string,
    settings: BaiduSyncSettings
  ): Promise<{ downloaded: number; skippedCached: number }> {
    return this.tombstones.syncRemoteShards(remoteShards, currentDeviceId, async (shard) => {
      const downloadOpts = {
        e2eePassword: settings.e2eePassword,
        expectedSize: shard.size
      };
      try {
        return await this.downloader.downloadByFsId(shard.fsId, downloadOpts);
      } catch (err: unknown) {
        if (isLikelyExpiredDlinkError(err)) {
          return this.downloader.downloadByFsId(shard.fsId, downloadOpts);
        }
        throw err;
      }
    });
  }

  private async flushOwnTombstoneShard(
    cleanBase: string,
    currentDeviceId: string,
    settings: BaiduSyncSettings,
    forcePlaintext = false
  ): Promise<void> {
    const payload = this.tombstones.buildOwnShardPayload(currentDeviceId);
    const remotePath = buildRemoteTombstonePath(cleanBase, currentDeviceId);
    const uploadRes = await this.uploader.uploadFile(
      remotePath,
      payload,
      forcePlaintext
        ? { enableE2EE: false }
        : { enableE2EE: settings.enableE2EE, e2eePassword: settings.e2eePassword }
    );
    this.tombstones.markOwnShardUploaded(currentDeviceId, {
      fsId: uploadRes.fs_id,
      remoteMtime: (uploadRes.mtime || Math.floor(Date.now() / 1000)) * 1000,
      remoteSize: uploadRes.size
    });
  }

  /**
   * Budgeted lazy backfill of plaintext `localMd5` for legacy E2EE manifest entries (<= v1.1.4).
   * Processes at most `e2eeMd5BackfillMaxFiles` (default 50) and `e2eeMd5BackfillMaxBytes` (default 16MB)
   * per sync run with zero network traffic so mobile vaults upgrade smoothly without stalling.
   */
  private async backfillLegacyE2EELocalMd5(
    localFiles: Map<string, LocalFileInfo>,
    remoteFiles: Map<string, RemoteFileInfo>,
    settings: BaiduSyncSettings,
    ctx: SyncRunContext
  ): Promise<number> {
    if (
      !settings.enableE2EE ||
      this.e2eeMd5BackfillMaxFiles <= 0 ||
      this.e2eeMd5BackfillMaxBytes <= 0
    ) {
      return 0;
    }

    const maxFileBytes = this.getMaxBytes(settings);
    let backfilledCount = 0;
    let backfilledBytes = 0;

    for (const [canonicalKey, local] of localFiles) {
      if (!ctx.isCurrent()) break;
      if (
        backfilledCount >= this.e2eeMd5BackfillMaxFiles ||
        backfilledBytes >= this.e2eeMd5BackfillMaxBytes
      ) {
        break;
      }

      const m = this.manifest.get(canonicalKey);
      if (!m || m.localMd5) continue;
      if (!remoteFiles.has(canonicalKey)) continue;
      if (local.size !== m.size || Math.abs(local.mtime - m.mtime) > 1000) continue;
      if (local.size > maxFileBytes) continue;
      if (backfilledCount > 0 && backfilledBytes + local.size > this.e2eeMd5BackfillMaxBytes) {
        continue;
      }

      try {
        const buf = await ctx.readBinary(local.path);
        if (!ctx.isCurrent()) break;
        if (buf.byteLength !== m.size) continue;
        this.manifest.set({
          ...m,
          localMd5: md5(buf)
        });
        backfilledCount++;
        backfilledBytes += buf.byteLength;
      } catch (err: unknown) {
        if (err instanceof BridgeDeadlockError || err instanceof QueueCancelledError) {
          throw err;
        }
        // Best-effort single-file backfill; skip transient read errors
      }
    }

    if (backfilledCount > 0 && ctx.isCurrent()) {
      this.addLog("info", t("engine.e2eeMd5Backfilled", { count: backfilledCount }));
    }
    return backfilledCount;
  }

  private async cleanupRetiredTombstoneShards(
    remoteShards: RemoteTombstoneShardRef[],
    currentDeviceId: string,
    ctx: SyncRunContext
  ): Promise<void> {
    if (!ctx.isCurrent() || remoteShards.length === 0) return;
    const retired = this.tombstones.getRetiredRemoteShards(remoteShards, currentDeviceId);
    if (retired.length === 0) return;

    try {
      await this.client.deleteFiles(retired.map((s) => s.remotePath));
      if (!ctx.isCurrent()) return;
      this.tombstones.removeCachedRemoteShards(retired.map((s) => s.deviceId));
      this.addLog("info", t("engine.tombstoneRetiredShardsCleaned", { count: retired.length }));
    } catch (err: unknown) {
      if (ctx.isCurrent()) {
        const detail = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
        this.addLog("warn", t("engine.tombstoneRetiredShardsCleanupFailed", { detail }));
      }
    }
  }

  /**
   * Lazily computes local plaintext MD5 ONLY for files that actually need content verification:
   * 1. Plaintext same-size dedup when manifest is absent or both sides changed.
   * 2. `!remote` files with drifted local mtime vs manifest (prevents false resurrection under both plaintext & E2EE).
   * 3. `!remote` files matching a cloud tombstone path with recorded hash (verifies exact deleted content).
   */
  private async populateCandidateLocalMd5(
    localFiles: Map<string, LocalFileInfo>,
    remoteFiles: Map<string, RemoteFileInfo>,
    manifestAll: Record<string, ManifestItem>,
    tombstones: Map<string, TombstoneEntry>,
    settings: BaiduSyncSettings,
    ctx: SyncRunContext
  ): Promise<void> {
    const maxBytes = this.getMaxBytes(settings);

    for (const [canonicalKey, local] of localFiles) {
      if (!ctx.isCurrent()) return;
      if (local.size > maxBytes) continue;

      const remote = remoteFiles.get(canonicalKey);
      const manifestItem = manifestAll[canonicalKey];
      const tombstone = tombstones.get(canonicalKey);

      let needsLocalHash = false;

      if (remote) {
        // Case 1: Plaintext dedup when both sides exist with equal size
        if (!settings.enableE2EE && remote.md5 && local.size === remote.size) {
          if (!manifestItem) {
            needsLocalHash = true;
          } else {
            const localChanged =
              Math.abs(local.mtime - manifestItem.mtime) > 1000 || local.size !== manifestItem.size;
            const expectedRemoteSize =
              manifestItem.remoteSize !== undefined ? manifestItem.remoteSize : manifestItem.size;
            const fsIdChanged =
              Boolean(manifestItem.fsId) &&
              Boolean(remote.fsId) &&
              String(remote.fsId) !== String(manifestItem.fsId);
            const remoteChanged =
              Math.abs(remote.mtime - manifestItem.remoteMtime) > 1000 ||
              remote.size !== expectedRemoteSize ||
              fsIdChanged;
            if (localChanged && remoteChanged) {
              needsLocalHash = true;
            }
          }
        }
      } else {
        // Case 2: Remote absent — verify drifted mtime against manifest plaintext hash
        if (
          manifestItem &&
          local.size === manifestItem.size &&
          Math.abs(local.mtime - manifestItem.mtime) > 1000 &&
          Boolean(getBaselinePlainMd5(manifestItem, settings.enableE2EE))
        ) {
          needsLocalHash = true;
        }
        // Case 3: Remote absent — verify content hash against cloud tombstone
        if (
          !needsLocalHash &&
          tombstone &&
          Boolean(tombstone.deletedHash) &&
          (tombstone.deletedSize === undefined || local.size === tombstone.deletedSize)
        ) {
          needsLocalHash = true;
        }
      }

      if (!needsLocalHash) continue;

      try {
        const buf = await ctx.readBinary(local.path);
        local.md5 = md5(buf);
      } catch (err: unknown) {
        if (err instanceof BridgeDeadlockError) {
          throw err;
        }
        // Ignore single-file read error here; transfer phase handles it
      }
    }
  }

  async startSync(_silent = false, options: SyncRunOptions = {}): Promise<SyncRunResult> {
    return this.executeSyncRun(false, options);
  }

  private async executeSyncRun(
    allowDuringMigration: boolean,
    options: SyncRunOptions = {}
  ): Promise<SyncRunResult> {
    const stats: SyncStats = {
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      skipped: 0,
      errors: 0
    };

    if (
      this.activeRunId !== null ||
      (!allowDuringMigration && this.migrationActive) ||
      (this.state !== "idle" && this.state !== "error")
    ) {
      this.addLog("warn", t("engine.alreadyRunning"));
      return { success: false, stats };
    }

    // Freeze an immutable settings snapshot for this run so keystroke edits in Settings
    // (e.g. typing e2eePassword or remoteBasePath) can never corrupt in-flight syncs.
    const settings: BaiduSyncSettings = { ...this.getSettings() };
    if (!settings.accessToken) {
      this.addLog("error", t("engine.notAuthorized"));
      this.setState("error", t("engine.stateNotAuthorized"));
      return { success: false, stats };
    }

    const baseValidation = normalizeAndValidateRemoteBasePath(settings.remoteBasePath);
    if (baseValidation.error || !baseValidation.normalized) {
      const msg = baseValidation.error || t("engine.invalidRemoteBasePath");
      this.addLog("error", msg);
      this.setState("error", msg);
      return { success: false, stats };
    }
    const cleanBase = baseValidation.normalized;
    settings.remoteBasePath = cleanBase;

    const runId = ++this.runSeq;
    this.activeRunId = runId;
    this.lastRunMassDeleteAborted = false;
    this.lastRunManifestCorrupted = false;
    this.lastRunStaleGuardAborted = false;
    this.lastStaleGuardInfo = null;
    this.filter.updateSettings(settings);
    const ctx = this.createRunContext(runId, settings.concurrency || 3);
    this.activeCtx = ctx;

    const startTime = Date.now();
    const ensuredDirs = new Set<string>();
    let manifestResetThisRun = false;
    let completedMutations = 0;
    let runSucceeded = false;

    try {
      const currentDeviceId = await this.ensureDeviceId(settings);

      this.setState("preparing", t("engine.loadingManifest"));
      try {
        await this.manifest.load();
        await this.tombstones.load();
      } catch (err: unknown) {
        if (err instanceof OperationTimeoutError && err.kind === "vault") {
          const alive = await this.probeBridgeHealth(ctx);
          if (!alive) {
            const deadlockErr = ctx.bridgeError ?? new BridgeDeadlockError(t("engine.bridgeDeadlock"));
            ctx.abortRun(deadlockErr);
            throw deadlockErr;
          }
        }
        if (err instanceof Error && err.message === t("engine.manifestCorrupted")) {
          this.lastRunManifestCorrupted = true;
        }
        throw err;
      }

      if (this.manifest.wasRecoveredFromBackup()) {
        this.addLog("warn", t("engine.manifestRecoveredFromBackup"));
      }

      this.tombstones.ensureRemoteBase(cleanBase, currentDeviceId);

      // Step 1: Scan local files
      this.setState("diffing", t("engine.scanningLocal"));
      const localFiles = await this.scanLocalFiles(ctx, settings);

      // Step 2: Scan remote files (including case-collision detection & cloud tombstone shards)
      this.setState("diffing", t("engine.scanningRemote"));
      const { files: remoteFiles, caseCollisions, tombstoneShards } = await this.scanRemoteFiles(cleanBase);

      // Step 2.5: Incrementally sync cloud tombstone shards (fail-closed on decrypt/fetch error)
      if (tombstoneShards.length > 0) {
        try {
          await this.syncRemoteTombstoneShards(tombstoneShards, currentDeviceId, settings);
        } catch (err: unknown) {
          const detail = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
          throw new Error(t("engine.tombstoneSyncFailed", { detail }));
        }
      }
      const mergedTombstones = this.tombstones.getMergedTombstones(currentDeviceId);

      // Step 3: Guard against remoteBasePath change (reset stale baseline so local files are never wiped)
      const expectedPrefix = `${cleanBase}/`;
      const existingManifestFiles = this.manifest.getAll();
      const existingManifestKeys = Object.keys(existingManifestFiles);
      const savedBase = this.manifest.getRemoteBasePath();

      if (existingManifestKeys.length > 0) {
        let baseChanged = false;
        let previousBaseLabel = savedBase ? normalizeRemoteBase(savedBase) || "/" : "";

        if (savedBase !== undefined) {
          baseChanged = normalizeRemoteBase(savedBase) !== cleanBase;
        } else {
          // Strict exact path check (`${expectedPrefix}${k}`) catches parent-dir switches
          // like `/apps/obsidian_vault` -> `/apps`, unlike a loose startsWith check.
          const anyExactMatch = existingManifestKeys.some((k) => {
            const rp = existingManifestFiles[k]?.remotePath;
            return (
              typeof rp === "string" &&
              rp.normalize("NFC") === `${expectedPrefix}${k.normalize("NFC")}`
            );
          });
          if (!anyExactMatch) {
            baseChanged = true;
            const sample = existingManifestFiles[existingManifestKeys[0]];
            if (sample && typeof sample.remotePath === "string" && sample.remotePath.endsWith(`/${sample.path}`)) {
              previousBaseLabel = sample.remotePath.slice(0, -(sample.path.length + 1)) || "/";
            } else {
              previousBaseLabel = "(previous)";
            }
          }
        }

        if (baseChanged) {
          this.addLog(
            "warn",
            t("engine.remoteBaseChanged", {
              previous: previousBaseLabel || "/",
              current: cleanBase
            })
          );
          this.manifest.resetForRemoteBase(cleanBase);
          manifestResetThisRun = true;
        } else {
          this.manifest.setRemoteBasePath(cleanBase);
        }
      } else {
        this.manifest.setRemoteBasePath(cleanBase);
      }

      // Exclude case-colliding remote paths (and matching local/manifest entries) from planning
      const collidedLowerKeys = new Set<string>();
      for (const group of caseCollisions) {
        stats.errors++;
        this.addLog("error", t("engine.caseCollisionSkipped", { paths: group.join(", ") }));
        for (const p of group) {
          collidedLowerKeys.add(p.toLowerCase());
        }
      }

      const rawManifestFiles = this.manifest.getAll();
      let activeManifestFiles = rawManifestFiles;
      if (collidedLowerKeys.size > 0) {
        for (const key of Array.from(localFiles.keys())) {
          if (collidedLowerKeys.has(key.toLowerCase())) {
            localFiles.delete(key);
          }
        }
        const filteredManifest: Record<string, ManifestItem> = {};
        for (const [k, v] of Object.entries(rawManifestFiles)) {
          if (!collidedLowerKeys.has(k.toLowerCase())) {
            filteredManifest[k] = v;
          }
        }
        activeManifestFiles = filteredManifest;
      }

      // Step 3.2: Verify any statFast-suspected local changes against real disk stat
      await this.reverifySuspectedLocalChanges(localFiles, activeManifestFiles, ctx);

      // Compute local MD5 for plaintext dedup, mtime-drift verification, and tombstone matching
      this.setState("diffing", t("engine.computingPlan"));
      await this.populateCandidateLocalMd5(
        localFiles,
        remoteFiles,
        activeManifestFiles,
        mergedTombstones,
        settings,
        ctx
      );

      let plans = SyncPlanner.plan(
        localFiles,
        remoteFiles,
        activeManifestFiles,
        cleanBase,
        {
          conflictStrategy: settings.conflictStrategy,
          enableE2EE: settings.enableE2EE,
          tombstones: mergedTombstones,
          currentDeviceId
        }
      );

      // Step 3.5: Bidirectional mass-deletion safety circuit breaker
      // Tombstone-verified local deletions are explicitly corroborated by another device's deletion
      // record and flow smoothly to local .trash; unverified disappearances stay strictly guarded.
      let trackedCount = 0;
      for (const k of Object.keys(activeManifestFiles)) {
        if (!this.filter.shouldIgnore(k, false)) {
          trackedCount++;
        }
      }
      const localDeletePlans = plans.filter((p) => p.action === "DELETE_LOCAL");
      const unverifiedLocalDeleteCount = localDeletePlans.filter((p) => !p.tombstoneVerified).length;
      const verifiedLocalDeleteCount = localDeletePlans.length - unverifiedLocalDeleteCount;
      const remoteDeleteCount = plans.filter((p) => p.action === "DELETE_REMOTE").length;

      if (verifiedLocalDeleteCount > 0) {
        this.addLog(
          "info",
          t("engine.tombstoneVerifiedDeletes", { count: verifiedLocalDeleteCount })
        );
      }

      const localWipeEmptyRemote =
        trackedCount >= this.emptySideGuardMinManifest &&
        remoteFiles.size === 0 &&
        unverifiedLocalDeleteCount >= this.emptySideGuardMinManifest;
      const localWipeMass =
        unverifiedLocalDeleteCount >= this.massDeleteMinCount &&
        trackedCount > 0 &&
        unverifiedLocalDeleteCount / trackedCount >= this.massDeleteRatio;

      const remoteWipeEmptyLocal =
        trackedCount >= this.emptySideGuardMinManifest &&
        localFiles.size === 0 &&
        remoteDeleteCount >= this.emptySideGuardMinManifest;
      const remoteWipeMass =
        remoteDeleteCount >= this.massDeleteMinCount &&
        trackedCount > 0 &&
        remoteDeleteCount / trackedCount >= this.massDeleteRatio;

      if (localWipeEmptyRemote || localWipeMass) {
        if (options.bypassMassDeleteGuard) {
          this.addLog("warn", t("engine.massDeleteBypassed"));
        } else {
          const msg = t("engine.massDeleteLocalAborted", {
            count: unverifiedLocalDeleteCount,
            total: trackedCount,
            remoteCount: remoteFiles.size
          });
          this.lastRunMassDeleteAborted = true;
          this.addLog("error", msg);
          this.setState("error", msg);
          return { success: false, stats, massDeleteAborted: true };
        }
      }

      if (remoteWipeEmptyLocal || remoteWipeMass) {
        if (options.bypassMassDeleteGuard) {
          this.addLog("warn", t("engine.massDeleteBypassed"));
        } else {
          const msg = t("engine.massDeleteRemoteAborted", {
            count: remoteDeleteCount,
            total: trackedCount,
            localCount: localFiles.size
          });
          this.lastRunMassDeleteAborted = true;
          this.addLog("error", msg);
          this.setState("error", msg);
          return { success: false, stats, massDeleteAborted: true };
        }
      }

      // Step 3.6: Layer 3 Stale-Device & Empty-Baseline Wakeup Guard
      const unexplainedLocalOnlyUploads = plans.filter((p) => p.action === "UPLOAD" && !p.remote);
      const staleThresholdDays =
        typeof settings.staleSyncThresholdDays === "number" && Number.isFinite(settings.staleSyncThresholdDays)
          ? Math.max(0, settings.staleSyncThresholdDays)
          : 30;
      const lastSyncTime = this.manifest.getLastSyncTime();
      const elapsedSinceLastSync = lastSyncTime > 0 ? Math.max(0, Date.now() - lastSyncTime) : 0;
      const staleDays = Math.floor(elapsedSinceLastSync / 86_400_000);

      const isEmptyBaselineToPopulatedRemote =
        trackedCount === 0 &&
        remoteFiles.size > 0 &&
        unexplainedLocalOnlyUploads.length > 0;
      const isStaleDeviceWithUploads =
        staleThresholdDays > 0 &&
        lastSyncTime > 0 &&
        elapsedSinceLastSync >= staleThresholdDays * 86_400_000 &&
        unexplainedLocalOnlyUploads.length > 0;

      if (isEmptyBaselineToPopulatedRemote || isStaleDeviceWithUploads) {
        if (!options.staleResolution) {
          const samplePaths = unexplainedLocalOnlyUploads.slice(0, 5).map((p) => p.path);
          this.lastRunStaleGuardAborted = true;
          this.lastStaleGuardInfo = {
            reason: isEmptyBaselineToPopulatedRemote ? "empty-baseline" : "stale-days",
            uploadCount: unexplainedLocalOnlyUploads.length,
            remoteCount: remoteFiles.size,
            staleDays,
            samplePaths
          };
          const msg = isEmptyBaselineToPopulatedRemote
            ? t("engine.staleGuardEmptyBaselineAborted", {
                uploadCount: unexplainedLocalOnlyUploads.length,
                remoteCount: remoteFiles.size
              })
            : t("engine.staleGuardOfflineAborted", {
                days: staleDays,
                uploadCount: unexplainedLocalOnlyUploads.length
              });
          const detail = samplePaths.length > 0 ? samplePaths.join(", ") : undefined;
          this.addLog("error", msg, detail);
          this.setState("error", msg);
          return { success: false, stats, staleGuardAborted: true };
        }

        if (options.staleResolution === "trust-cloud") {
          let trashedLocalOnly = 0;
          let restoredRemoteDeletes = 0;
          plans = plans.map((p) => {
            if (p.action === "UPLOAD" && !p.remote) {
              trashedLocalOnly++;
              return {
                ...p,
                action: "DELETE_LOCAL",
                tombstoneVerified: true,
                reason: t("plan.trustCloudTrashLocal")
              };
            }
            if (p.action === "DELETE_REMOTE" && !p.local && p.remote) {
              restoredRemoteDeletes++;
              return {
                ...p,
                action: "DOWNLOAD",
                reason: t("plan.trustCloudRestoreRemote")
              };
            }
            return p;
          });
          this.addLog(
            "warn",
            t("engine.staleTrustCloudApplied", {
              trashed: trashedLocalOnly,
              restored: restoredRemoteDeletes
            })
          );
        } else if (options.staleResolution === "merge-upload") {
          this.addLog(
            "warn",
            t("engine.staleMergeUploadApplied", {
              count: unexplainedLocalOnlyUploads.length
            })
          );
        }
      }

      // Step 3.7: Budgeted lazy backfill of plaintext localMd5 for legacy E2EE manifest entries
      await this.backfillLegacyE2EELocalMd5(localFiles, remoteFiles, settings, ctx);

      if (plans.length === 0) {
        if (this.tombstones.isOwnShardPendingUpload()) {
          try {
            await this.flushOwnTombstoneShard(cleanBase, currentDeviceId, settings);
          } catch (err: unknown) {
            stats.errors++;
            const detail = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
            this.addLog("warn", t("engine.tombstoneUploadFailed", { detail }));
          }
        }
        await this.cleanupRetiredTombstoneShards(tombstoneShards, currentDeviceId, ctx);
        if (this.tombstones.isDirty()) {
          await this.tombstones.save();
        }
        if (this.manifest.isDirty()) {
          this.manifest.setRemoteBasePath(cleanBase);
          this.manifest.updateLastSyncTime();
          await this.manifest.save();
        }
        runSucceeded = true;
        if (stats.errors > 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          this.addLog(
            "warn",
            t("engine.summary", {
              elapsed,
              uploaded: stats.uploaded,
              downloaded: stats.downloaded,
              deleted: stats.deleted,
              conflicts: stats.conflicts,
              skipped: stats.skipped,
              errors: stats.errors
            })
          );
          this.setState("idle", t("engine.stateComplete"));
          return { success: false, stats };
        }
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

      // Phased execution order:
      // 1) Batched DELETE_REMOTE (with local existence TOCTOU guard + cloud tombstone recording)
      // 2) DELETE_LOCAL phase (must finish strictly BEFORE DOWNLOAD/UPLOAD/CONFLICT so
      //    case-only renames like Note.md -> note.md never delete the freshly downloaded file
      //    on case-insensitive macOS/Windows/iOS filesystems)
      // 3) Remaining concurrent UPLOAD / DOWNLOAD / CONFLICT / DELETE_CONFLICT / manifest updates
      const remoteDeleteItems = plans.filter((p) => p.action === "DELETE_REMOTE");
      const localDeleteItems = plans.filter((p) => p.action === "DELETE_LOCAL");
      const otherItems = plans.filter(
        (p) => p.action !== "DELETE_REMOTE" && p.action !== "DELETE_LOCAL"
      );

      const totalOps = plans.length;
      let processed = 0;
      this.setState("syncing", t("engine.syncProgress", { done: 0, total: totalOps }));

      // Phase 1: Execute batched remote deletions (up to 100 paths per API call)
      for (let i = 0; i < remoteDeleteItems.length; i += DELETE_BATCH_SIZE) {
        if (!ctx.isCurrent()) break;
        const batch = remoteDeleteItems.slice(i, i + DELETE_BATCH_SIZE);

        // TOCTOU check: never delete remote file if user restored/created it locally during scan
        const toDelete: SyncPlanItem[] = [];
        for (const b of batch) {
          if (!ctx.isCurrent()) break;
          const localDiskPath = b.local?.path ?? b.path;
          if (await ctx.exists(localDiskPath)) {
            stats.skipped++;
            this.addLog("warn", t("engine.deleteRemoteSkippedRestored", { path: b.path }));
          } else {
            toDelete.push(b);
          }
        }

        if (toDelete.length > 0 && ctx.isCurrent()) {
          const remotePaths = toDelete.map((b) => b.remotePath);
          try {
            await this.client.deleteFiles(remotePaths);
            if (!ctx.isCurrent()) break;
            const deletedAt = Date.now();
            for (const b of toDelete) {
              const plainHash = b.manifest
                ? getBaselinePlainMd5(b.manifest, settings.enableE2EE)
                : !settings.enableE2EE && b.remote?.md5
                  ? b.remote.md5.toLowerCase()
                  : undefined;
              const deletedSize =
                b.manifest?.size ?? (!settings.enableE2EE ? b.remote?.size : undefined);
              const deletedFsId =
                b.remote?.fsId !== undefined
                  ? String(b.remote.fsId)
                  : b.manifest?.fsId !== undefined
                    ? String(b.manifest.fsId)
                    : undefined;
              this.tombstones.recordDeletion(b.path, {
                deletedAt,
                deletedHash: plainHash,
                deletedSize,
                deletedFsId,
                deletedMtime: b.manifest?.mtime ?? b.remote?.mtime
              });
              this.manifest.delete(b.path);
            }
            completedMutations += toDelete.length;
            stats.deleted += toDelete.length;
            if (toDelete.length === 1) {
              this.addLog("info", t("engine.deleteRemoteSuccess", { path: toDelete[0].path }));
            } else {
              this.addLog("info", t("engine.batchDeleteRemoteSuccess", { count: toDelete.length }));
            }
          } catch (err: unknown) {
            stats.errors += toDelete.length;
            const msg = err instanceof Error ? err.message : String(err);
            this.addLog(
              "error",
              t("engine.itemFailed", { path: toDelete.map((b) => b.path).join(", ") }),
              msg
            );
          }
        }

        if (ctx.isCurrent()) {
          processed += batch.length;
          this.setState("syncing", t("engine.syncProgress", { done: processed, total: totalOps }));
          await this.tryCheckpoint(ctx, processed, totalOps);
        }
      }

      const runQueuedPhase = async (items: SyncPlanItem[]): Promise<void> => {
        if (items.length === 0 || !ctx.isCurrent()) return;

        const tasks = items.map((item) =>
          ctx.queue.add(async () => {
            if (!ctx.isCurrent()) return;
            try {
              const outcome = await this.executePlanItem(
                item,
                settings,
                prefetchedMetas,
                remoteFiles,
                ensuredDirs,
                ctx
              );
              if (!ctx.isCurrent()) return;
              if (outcome === "uploaded") {
                stats.uploaded++;
                completedMutations++;
              } else if (outcome === "downloaded") {
                stats.downloaded++;
                completedMutations++;
              } else if (outcome === "deleted") {
                stats.deleted++;
                completedMutations++;
              } else if (outcome === "conflict") {
                stats.conflicts++;
                completedMutations++;
              } else if (outcome === "skipped") {
                stats.skipped++;
              } else if (outcome === "manifest") {
                completedMutations++;
              }
            } catch (err: unknown) {
              if (err instanceof BridgeDeadlockError || err instanceof QueueCancelledError) {
                return;
              }
              if (!ctx.isCurrent()) return;
              stats.errors++;
              const msg = err instanceof Error ? err.message : String(err);
              this.addLog("error", t("engine.itemFailed", { path: item.path }), msg);
            } finally {
              if (ctx.isCurrent()) {
                processed++;
                this.setState("syncing", t("engine.syncProgress", { done: processed, total: totalOps }));
                await this.tryCheckpoint(ctx, processed, totalOps);
              }
            }
          })
        );

        const phasePromise = Promise.all(tasks);
        phasePromise.catch(() => {});

        await Promise.race([phasePromise, ctx.abortPromise]);
        if (!ctx.bridgeDead) {
          await ctx.queue.waitAll();
        }
      };

      // Phase 2: Complete all DELETE_LOCAL before any DOWNLOAD/UPLOAD/CONFLICT
      await runQueuedPhase(localDeleteItems);

      // Phase 3: Execute concurrent UPLOAD / DOWNLOAD / CONFLICT / DELETE_CONFLICT / manifest updates
      await runQueuedPhase(otherItems);

      // Step 5: Flush cloud tombstone shard (if dirty), GC retired peer shards, save cache, manifest & settings
      if (this.tombstones.isOwnShardPendingUpload()) {
        try {
          await this.flushOwnTombstoneShard(cleanBase, currentDeviceId, settings);
        } catch (err: unknown) {
          stats.errors++;
          const detail = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
          this.addLog("warn", t("engine.tombstoneUploadFailed", { detail }));
        }
      }
      await this.cleanupRetiredTombstoneShards(tombstoneShards, currentDeviceId, ctx);
      if (this.tombstones.isDirty()) {
        await this.tombstones.save();
      }

      this.manifest.setRemoteBasePath(cleanBase);
      this.manifest.updateLastSyncTime();
      await this.manifest.save();
      runSucceeded = true;

      // Write lastSyncTime onto the LIVE settings object so we never clobber
      // refreshed OAuth tokens or user edits made while sync was running.
      const latestSettings = this.getSettings();
      latestSettings.lastSyncTime = Date.now();
      await this.saveSettings(latestSettings);

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
      if (err instanceof BridgeDeadlockError || ctx.bridgeDead) {
        const msg = t("engine.bridgeDeadlock");
        this.addLog("error", msg);
        this.setState("error", msg);
        return { success: false, stats, bridgeDead: true };
      }

      const msg = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
      this.addLog("error", t("engine.fatalError"), msg);
      this.setState("error", msg);
      return {
        success: false,
        stats,
        manifestCorrupted: this.lastRunManifestCorrupted || undefined
      };
    } finally {
      ctx.queue.clear();
      // Best-effort flush of completed items if bridge is still responsive.
      // Never persist an empty baseline reset if the run aborted before completing any mutation.
      const shouldSkipResetFlush = manifestResetThisRun && completedMutations === 0 && !runSucceeded;
      if (!ctx.bridgeDead && !shouldSkipResetFlush && this.manifest.isDirty()) {
        this.manifest.setRemoteBasePath(cleanBase);
        this.manifest.updateLastSyncTime();
        try {
          await this.manifest.save();
        } catch (saveErr: unknown) {
          const detail = sanitizeErrorMessage(
            saveErr instanceof Error ? saveErr.message : String(saveErr)
          );
          this.addLog("error", t("engine.manifestSaveFailed", { detail }));
        }
      }
      if (!ctx.bridgeDead && this.tombstones.isDirty()) {
        try {
          await this.tombstones.save();
        } catch {
          // Best-effort cache flush; cloud shards remain authoritative
        }
      }
      if (this.activeRunId === runId) {
        this.activeRunId = null;
      }
      if (this.activeCtx === ctx) {
        this.activeCtx = null;
      }
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
    const downloadOpts = {
      e2eePassword: settings.e2eePassword,
      expectedSize: item.remote.size
    };
    const meta = prefetchedMetas.get(String(item.remote.fsId));
    if (meta && meta.dlink) {
      try {
        return await this.downloader.downloadWithMeta(meta, downloadOpts);
      } catch (err: unknown) {
        if (isLikelyExpiredDlinkError(err)) {
          this.addLog("warn", t("engine.dlinkRefreshed", { path: item.path }));
          return this.downloader.downloadByFsId(item.remote.fsId, downloadOpts);
        }
        throw err;
      }
    }
    return this.downloader.downloadByFsId(item.remote.fsId, downloadOpts);
  }

  private async executePlanItem(
    item: SyncPlanItem,
    settings: BaiduSyncSettings,
    prefetchedMetas: Map<string, BaiduFileMeta>,
    remoteFiles: Map<string, RemoteFileInfo>,
    ensuredDirs: Set<string>,
    ctx: SyncRunContext
  ): Promise<"uploaded" | "downloaded" | "deleted" | "conflict" | "skipped" | "manifest" | "none"> {
    const localDiskPath = item.local?.path ?? item.path;

    switch (item.action) {
      case "UPLOAD": {
        if (item.local && this.isOversized(item.local.size, settings, item.path)) {
          return "skipped";
        }

        let buffer: ArrayBuffer;
        try {
          buffer = await ctx.readBinary(localDiskPath);
        } catch (err: unknown) {
          if (
            err instanceof BridgeDeadlockError ||
            err instanceof OperationTimeoutError ||
            err instanceof QueueCancelledError
          ) {
            throw err;
          }
          // File may have been deleted between scan and upload
          if (!(await ctx.exists(localDiskPath))) {
            return "none";
          }
          throw err;
        }

        if (this.isOversized(buffer.byteLength, settings, item.path)) {
          return "skipped";
        }

        let localMtime = item.local?.mtime;
        let localSize = item.local?.size ?? buffer.byteLength;
        if (localMtime === undefined || buffer.byteLength !== localSize) {
          // File changed size between scan and readBinary: re-stat & re-read once to bind exact stat to buffer
          const preStat = await ctx.stat(localDiskPath);
          if (!preStat || preStat.type !== "file") {
            return "none";
          }
          buffer = await ctx.readBinary(localDiskPath);
          if (this.isOversized(buffer.byteLength, settings, item.path)) {
            return "skipped";
          }
          const postStat = await ctx.stat(localDiskPath);
          if (
            !postStat ||
            postStat.type !== "file" ||
            postStat.size !== buffer.byteLength ||
            Math.abs(postStat.mtime - preStat.mtime) > 1000
          ) {
            this.addLog("warn", t("engine.uploadSkippedModified", { path: item.path }));
            return "skipped";
          }
          localMtime = preStat.mtime;
          localSize = buffer.byteLength;
        }

        const localPlainMd5 = md5(buffer);
        const res = await this.uploader.uploadFile(item.remotePath, buffer, {
          enableE2EE: settings.enableE2EE,
          e2eePassword: settings.e2eePassword
        });

        if (!ctx.isCurrent()) {
          return "none";
        }

        this.tombstones.clearOwnEntry(item.path);
        this.manifest.set({
          path: item.path,
          remotePath: item.remotePath,
          mtime: localMtime,
          remoteMtime: (res.mtime || Math.floor(Date.now() / 1000)) * 1000,
          md5: res.md5 || "",
          localMd5: localPlainMd5,
          size: localSize,
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
        if (!ctx.isCurrent()) {
          return "none";
        }

        // TOCTOU protection before overwriting local disk:
        // If user edited the local file (or created a brand-new local file at this path)
        // during scan/download, NEVER overwrite silently — skip and let next sync diff safely.
        const currentStat = await ctx.stat(localDiskPath);
        if (item.local) {
          if (
            currentStat &&
            currentStat.type === "file" &&
            (Math.abs(currentStat.mtime - item.local.mtime) > 1000 ||
              currentStat.size !== item.local.size)
          ) {
            this.addLog("warn", t("engine.downloadSkippedModified", { path: item.path }));
            return "skipped";
          }
        } else if (currentStat !== null) {
          this.addLog("warn", t("engine.downloadSkippedModified", { path: item.path }));
          return "skipped";
        }

        await this.ensureParentDir(localDiskPath, ensuredDirs, ctx);
        this.markSyncWrite(localDiskPath);
        await ctx.writeBinary(localDiskPath, buffer);
        this.markSyncWrite(localDiskPath);
        const stat = await ctx.stat(localDiskPath);

        if (!ctx.isCurrent()) {
          return "none";
        }

        this.manifest.set({
          path: item.path,
          remotePath: item.remotePath,
          mtime: stat?.mtime || Date.now(),
          remoteMtime: item.remote.mtime,
          md5: item.remote.md5 || "",
          localMd5: md5(buffer),
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

        // Capture real disk stat BEFORE reading so any subsequent user edit is never masked
        const preLocalStat = await ctx.stat(localDiskPath);
        if (!preLocalStat || preLocalStat.type !== "file") {
          this.addLog("warn", t("engine.conflictSkippedModified", { path: item.path }));
          return "skipped";
        }

        const [localBuffer, remoteBuffer] = await Promise.all([
          ctx.readBinary(localDiskPath),
          this.downloadItemBuffer(item, settings, prefetchedMetas)
        ]);

        if (!ctx.isCurrent()) {
          return "none";
        }

        // Confirm local file didn't mutate mid-read
        if (localBuffer.byteLength !== preLocalStat.size) {
          this.addLog("warn", t("engine.conflictSkippedModified", { path: item.path }));
          return "skipped";
        }

        const localPlainMd5 = md5(localBuffer);
        // If decrypted contents are byte-for-byte identical, skip creating any conflict copy
        if (buffersEqual(localBuffer, remoteBuffer)) {
          this.manifest.set({
            path: item.path,
            remotePath: item.remotePath,
            mtime: preLocalStat.mtime,
            remoteMtime: item.remote.mtime,
            md5: item.remote.md5 || "",
            localMd5: localPlainMd5,
            size: localBuffer.byteLength,
            remoteSize: item.remote.size,
            fsId: item.remote.fsId
          });
          this.addLog("info", t("engine.conflictIdentical", { path: item.path }));
          return "manifest";
        }

        const remotePlainMd5 = md5(remoteBuffer);
        const conflictPath = await this.resolveUniqueConflictPath(item.path, remoteFiles, ctx);
        const cleanBase = normalizeRemoteBase(settings.remoteBasePath);
        const conflictRemotePath = `${cleanBase}/${conflictPath}`;
        const winner = item.winner ?? (preLocalStat.mtime >= item.remote.mtime ? "local" : "remote");

        await this.ensureParentDir(conflictPath, ensuredDirs, ctx);

        if (winner === "local") {
          // Preserve remote version as conflict copy locally & remotely, then push local as main
          this.markSyncWrite(conflictPath);
          await ctx.writeBinary(conflictPath, remoteBuffer);
          this.markSyncWrite(conflictPath);
          const conflictStat = await ctx.stat(conflictPath);
          const conflictUploadRes = await this.uploader.uploadFile(conflictRemotePath, remoteBuffer, {
            enableE2EE: settings.enableE2EE,
            e2eePassword: settings.e2eePassword
          });
          if (!ctx.isCurrent()) return "none";
          this.manifest.set({
            path: conflictPath,
            remotePath: conflictRemotePath,
            mtime: conflictStat?.mtime || Date.now(),
            remoteMtime: (conflictUploadRes.mtime || Math.floor(Date.now() / 1000)) * 1000,
            md5: conflictUploadRes.md5 || "",
            localMd5: remotePlainMd5,
            size: remoteBuffer.byteLength,
            remoteSize: conflictUploadRes.size,
            fsId: conflictUploadRes.fs_id
          });

          const mainUploadRes = await this.uploader.uploadFile(item.remotePath, localBuffer, {
            enableE2EE: settings.enableE2EE,
            e2eePassword: settings.e2eePassword
          });
          if (!ctx.isCurrent()) return "none";
          // Record preLocalStat.mtime (exact mtime of localBuffer), NOT post-upload stat,
          // so edits made while uploading are detected and synced on the next run.
          this.manifest.set({
            path: item.path,
            remotePath: item.remotePath,
            mtime: preLocalStat.mtime,
            remoteMtime: (mainUploadRes.mtime || Math.floor(Date.now() / 1000)) * 1000,
            md5: mainUploadRes.md5 || "",
            localMd5: localPlainMd5,
            size: localBuffer.byteLength,
            remoteSize: mainUploadRes.size,
            fsId: mainUploadRes.fs_id
          });
        } else {
          // Re-check local file before overwriting main path with remoteBuffer
          const latestLocalStat = await ctx.stat(localDiskPath);
          if (
            !latestLocalStat ||
            latestLocalStat.type !== "file" ||
            Math.abs(latestLocalStat.mtime - preLocalStat.mtime) > 1000 ||
            latestLocalStat.size !== preLocalStat.size
          ) {
            this.addLog("warn", t("engine.conflictSkippedModified", { path: item.path }));
            return "skipped";
          }

          // Preserve local version as conflict copy locally & remotely, then apply remote as main
          this.markSyncWrite(conflictPath);
          await ctx.writeBinary(conflictPath, localBuffer);
          this.markSyncWrite(conflictPath);
          const conflictStat = await ctx.stat(conflictPath);
          const conflictUploadRes = await this.uploader.uploadFile(conflictRemotePath, localBuffer, {
            enableE2EE: settings.enableE2EE,
            e2eePassword: settings.e2eePassword
          });
          if (!ctx.isCurrent()) return "none";
          this.manifest.set({
            path: conflictPath,
            remotePath: conflictRemotePath,
            mtime: conflictStat?.mtime || Date.now(),
            remoteMtime: (conflictUploadRes.mtime || Math.floor(Date.now() / 1000)) * 1000,
            md5: conflictUploadRes.md5 || "",
            localMd5: localPlainMd5,
            size: localBuffer.byteLength,
            remoteSize: conflictUploadRes.size,
            fsId: conflictUploadRes.fs_id
          });

          // Final TOCTOU check right before overwriting main local file
          const beforeOverwriteStat = await ctx.stat(localDiskPath);
          if (
            beforeOverwriteStat &&
            beforeOverwriteStat.type === "file" &&
            (Math.abs(beforeOverwriteStat.mtime - preLocalStat.mtime) > 1000 ||
              beforeOverwriteStat.size !== preLocalStat.size)
          ) {
            this.addLog("warn", t("engine.conflictSkippedModified", { path: item.path }));
            return "skipped";
          }

          this.markSyncWrite(localDiskPath);
          await ctx.writeBinary(localDiskPath, remoteBuffer);
          this.markSyncWrite(localDiskPath);
          const mainStat = await ctx.stat(localDiskPath);
          if (!ctx.isCurrent()) return "none";
          this.manifest.set({
            path: item.path,
            remotePath: item.remotePath,
            mtime: mainStat?.mtime || Date.now(),
            remoteMtime: item.remote.mtime,
            md5: item.remote.md5 || "",
            localMd5: remotePlainMd5,
            size: remoteBuffer.byteLength,
            remoteSize: item.remote.size,
            fsId: item.remote.fsId
          });
        }

        this.addLog("warn", t("engine.conflictPreserved", { path: item.path, conflictPath }));
        return "conflict";
      }

      case "DELETE_CONFLICT": {
        if (!item.local) {
          return "none";
        }
        if (this.isOversized(item.local.size, settings, item.path)) {
          return "skipped";
        }

        const preLocalStat = await ctx.stat(localDiskPath);
        if (!preLocalStat || preLocalStat.type !== "file") {
          this.addLog("warn", t("engine.conflictSkippedModified", { path: item.path }));
          return "skipped";
        }

        const localBuffer = await ctx.readBinary(localDiskPath);
        if (!ctx.isCurrent()) return "none";

        if (localBuffer.byteLength !== preLocalStat.size) {
          this.addLog("warn", t("engine.conflictSkippedModified", { path: item.path }));
          return "skipped";
        }

        const localPlainMd5 = md5(localBuffer);
        const conflictPath = await this.resolveUniqueConflictPath(item.path, remoteFiles, ctx);
        const cleanBase = normalizeRemoteBase(settings.remoteBasePath);
        const conflictRemotePath = `${cleanBase}/${conflictPath}`;

        await this.ensureParentDir(conflictPath, ensuredDirs, ctx);
        this.markSyncWrite(conflictPath);
        await ctx.writeBinary(conflictPath, localBuffer);
        this.markSyncWrite(conflictPath);
        const conflictStat = await ctx.stat(conflictPath);

        const conflictUploadRes = await this.uploader.uploadFile(conflictRemotePath, localBuffer, {
          enableE2EE: settings.enableE2EE,
          e2eePassword: settings.e2eePassword
        });
        if (!ctx.isCurrent()) return "none";

        this.tombstones.clearOwnEntry(conflictPath);
        this.manifest.set({
          path: conflictPath,
          remotePath: conflictRemotePath,
          mtime: conflictStat?.mtime || Date.now(),
          remoteMtime: (conflictUploadRes.mtime || Math.floor(Date.now() / 1000)) * 1000,
          md5: conflictUploadRes.md5 || "",
          localMd5: localPlainMd5,
          size: localBuffer.byteLength,
          remoteSize: conflictUploadRes.size,
          fsId: conflictUploadRes.fs_id
        });

        // Final TOCTOU check on original path before moving it to local trash
        const postLocalStat = await ctx.stat(localDiskPath);
        if (
          postLocalStat &&
          postLocalStat.type === "file" &&
          Math.abs(postLocalStat.mtime - preLocalStat.mtime) <= 1000 &&
          postLocalStat.size === preLocalStat.size
        ) {
          this.markSyncWrite(localDiskPath);
          await ctx.trashFile(localDiskPath);
          this.markSyncWrite(localDiskPath);
          if (ctx.isCurrent()) {
            this.manifest.delete(item.path);
          }
        } else {
          this.addLog("warn", t("engine.deleteLocalSkippedModified", { path: item.path }));
        }

        this.addLog(
          "warn",
          t("engine.deleteConflictPreserved", { path: item.path, conflictPath })
        );
        return "conflict";
      }

      case "UPDATE_MANIFEST": {
        if (item.local && item.remote && ctx.isCurrent()) {
          this.manifest.set({
            path: item.path,
            remotePath: item.remotePath,
            mtime: item.local.mtime,
            remoteMtime: item.remote.mtime,
            md5: item.remote.md5 || item.local.md5 || "",
            localMd5: item.local.md5 || (!settings.enableE2EE ? item.remote.md5 : undefined),
            size: item.local.size,
            remoteSize: item.remote.size,
            fsId: item.remote.fsId
          });
          return "manifest";
        }
        return "none";
      }

      case "DELETE_LOCAL": {
        if (await ctx.exists(localDiskPath)) {
          // Re-stat right before deleting to prevent TOCTOU loss if user edited during remote scan.
          // Compare against scanned `item.local` (already verified via mtime/MD5/tombstone) rather than
          // `item.manifest` so files with pre-scan mtime drift verified by content hash still trash cleanly.
          const currentStat = await ctx.stat(localDiskPath);
          const expectedStat = item.local ?? item.manifest;
          if (
            currentStat &&
            currentStat.type === "file" &&
            expectedStat &&
            (Math.abs(currentStat.mtime - expectedStat.mtime) > 1000 ||
              currentStat.size !== expectedStat.size)
          ) {
            this.addLog("warn", t("engine.deleteLocalSkippedModified", { path: item.path }));
            return "skipped";
          }
          this.markSyncWrite(localDiskPath);
          await ctx.trashFile(localDiskPath);
          this.markSyncWrite(localDiskPath);
          this.addLog("info", t("engine.deleteLocalSuccess", { path: item.path }));
        }
        if (ctx.isCurrent()) {
          this.manifest.delete(item.path);
        }
        return "deleted";
      }

      case "CLEAN_MANIFEST": {
        if (ctx.isCurrent()) {
          this.manifest.delete(item.path);
          return "manifest";
        }
        return "none";
      }

      default:
        return "none";
    }
  }

  async convertVaultToPlaintext(
    onProgress?: (processed: number, total: number, currentPath: string) => void
  ): Promise<{ success: boolean; total: number; skipped: number; errors: number }> {
    if (this.activeRunId !== null || this.migrationActive || (this.state !== "idle" && this.state !== "error")) {
      throw new Error(t("migration.alreadyRunning"));
    }

    const settings: BaiduSyncSettings = { ...this.getSettings() };
    if (!settings.accessToken) {
      throw new Error(t("migration.notAuthorized"));
    }

    const baseValidation = normalizeAndValidateRemoteBasePath(settings.remoteBasePath);
    if (baseValidation.error || !baseValidation.normalized) {
      throw new Error(baseValidation.error || t("engine.invalidRemoteBasePath"));
    }
    const cleanBase = baseValidation.normalized;
    settings.remoteBasePath = cleanBase;

    this.migrationActive = true;
    try {
      this.addLog("info", t("migration.step1Log"));
      const pullResult = await this.executeSyncRun(true);
      // Abort on ANY pre-sync failure (including fatal network or bridge errors where stats.errors may be 0)
      if (!pullResult.success) {
        if (pullResult.bridgeDead) {
          throw new Error(t("engine.bridgeDeadlock"));
        }
        throw new Error(t("migration.step1Failed", { errors: pullResult.stats.errors }));
      }

      const runId = ++this.runSeq;
      this.activeRunId = runId;
      this.filter.updateSettings(settings);
      const ctx = this.createRunContext(runId, settings.concurrency || 3);
      this.activeCtx = ctx;

      try {
        this.setState("diffing", t("migration.scanningLocal"));
        const localFiles = await this.scanLocalFiles(ctx, settings);
        const total = localFiles.size;
        let processed = 0;
        let skipped = 0;
        let errors = 0;

        this.addLog("info", t("migration.step2Log", { total }));

        this.setState("syncing", t("migration.step2Progress", { done: 0, total }));

        const entries = Array.from(localFiles.entries());
        const tasks = entries.map(([canonicalPath, fileInfo]) =>
          ctx.queue.add(async () => {
            if (!ctx.isCurrent()) return;
            const localDiskPath = fileInfo.path;
            try {
              if (this.isOversized(fileInfo.size, settings, canonicalPath)) {
                skipped++;
                return;
              }
              let buffer: ArrayBuffer;
              try {
                buffer = await ctx.readBinary(localDiskPath);
              } catch (err: unknown) {
                if (
                  err instanceof BridgeDeadlockError ||
                  err instanceof OperationTimeoutError ||
                  err instanceof QueueCancelledError
                ) {
                  throw err;
                }
                if (!(await ctx.exists(localDiskPath))) {
                  return;
                }
                throw err;
              }
              if (this.isOversized(buffer.byteLength, settings, canonicalPath)) {
                skipped++;
                return;
              }
              const localMtime = fileInfo.mtime || Date.now();
              const remotePath = `${cleanBase}/${canonicalPath}`;

              // Explicitly upload with enableE2EE: false -> Pure Plaintext
              const localPlainMd5 = md5(buffer);
              const res = await this.uploader.uploadFile(remotePath, buffer, {
                enableE2EE: false
              });

              if (!ctx.isCurrent()) return;

              this.manifest.set({
                path: canonicalPath,
                remotePath: remotePath,
                mtime: localMtime,
                remoteMtime: (res.mtime || Math.floor(Date.now() / 1000)) * 1000,
                md5: res.md5 || "",
                localMd5: localPlainMd5,
                size: buffer.byteLength,
                remoteSize: res.size,
                fsId: res.fs_id
              });
              this.addLog("success", t("migration.uploadSuccess", { path: canonicalPath }));
            } catch (err: unknown) {
              if (err instanceof BridgeDeadlockError || err instanceof QueueCancelledError) {
                return;
              }
              if (!ctx.isCurrent()) return;
              errors++;
              const msg = err instanceof Error ? err.message : String(err);
              this.addLog("error", t("migration.uploadFailed", { path: canonicalPath }), msg);
            } finally {
              if (ctx.isCurrent()) {
                processed++;
                onProgress?.(processed, total, canonicalPath);
                this.setState("syncing", t("migration.step2Progress", { done: processed, total }));
                await this.tryCheckpoint(ctx, processed, total);
              }
            }
          })
        );

        const allTasksPromise = Promise.all(tasks);
        allTasksPromise.catch(() => {});

        await Promise.race([allTasksPromise, ctx.abortPromise]);
        if (!ctx.bridgeDead) {
          await ctx.queue.waitAll();
        }

        // Also re-upload own tombstone shard as plaintext so cloud tombstones stay readable after E2EE is disabled
        if (this.tombstones.hasOwnEntries() || this.tombstones.isOwnShardPendingUpload()) {
          const currentDeviceId = await this.ensureDeviceId(settings);
          try {
            await this.flushOwnTombstoneShard(cleanBase, currentDeviceId, settings, true);
            await this.tombstones.save();
          } catch (err: unknown) {
            errors++;
            const detail = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
            this.addLog("warn", t("engine.tombstoneUploadFailed", { detail }));
          }
        }

        this.manifest.setRemoteBasePath(cleanBase);
        this.manifest.updateLastSyncTime();
        await this.manifest.save();

        const latestSettings = this.getSettings();
        latestSettings.lastSyncTime = Date.now();
        await this.saveSettings(latestSettings);

        this.setState("idle", t("migration.stateDone"));
        const summary = t("migration.summary", { processed, total, skipped, errors });
        this.addLog(errors > 0 ? "warn" : "success", summary);

        return { success: errors === 0, total, skipped, errors };
      } catch (err: unknown) {
        if (err instanceof BridgeDeadlockError || ctx.bridgeDead) {
          const msg = t("engine.bridgeDeadlock");
          this.addLog("error", msg);
          this.setState("error", msg);
          throw new Error(msg);
        }
        const msg = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
        this.addLog("error", t("engine.fatalError"), msg);
        this.setState("error", msg);
        throw new Error(msg);
      } finally {
        ctx.queue.clear();
        if (!ctx.bridgeDead && this.manifest.isDirty()) {
          this.manifest.setRemoteBasePath(cleanBase);
          this.manifest.updateLastSyncTime();
          try {
            await this.manifest.save();
          } catch (saveErr: unknown) {
            const detail = sanitizeErrorMessage(
              saveErr instanceof Error ? saveErr.message : String(saveErr)
            );
            this.addLog("error", t("engine.manifestSaveFailed", { detail }));
          }
        }
        if (this.activeRunId === runId) {
          this.activeRunId = null;
        }
        if (this.activeCtx === ctx) {
          this.activeCtx = null;
        }
      }
    } finally {
      this.migrationActive = false;
    }
  }

  private async scanLocalFiles(
    ctx: SyncRunContext,
    settings: BaiduSyncSettings
  ): Promise<Map<string, LocalFileInfo>> {
    const result = new Map<string, LocalFileInfo>();
    const visitedDirs = new Set<string>();

    const scanDirectory = async (dir: string) => {
      const normDir = dir.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
      if (visitedDirs.has(normDir)) {
        return;
      }
      visitedDirs.add(normDir);

      const list = await ctx.list(normDir);

      for (const file of list.files) {
        if (this.filter.shouldIgnore(file, false)) {
          continue;
        }
        const stat = await ctx.statFast(file);
        if (stat && stat.type === "file") {
          const canonicalKey = file.normalize("NFC");
          result.set(canonicalKey, {
            path: file,
            mtime: stat.mtime,
            size: stat.size
          });
        }
      }

      for (const folder of list.folders) {
        if (this.filter.shouldIgnore(folder, true)) {
          continue;
        }
        await scanDirectory(folder);
      }
    };

    // Scan regular vault contents
    await scanDirectory("");

    // Scan config directory only if enabled and not already visited during root scan
    const configDir = this.vault.configDir.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (
      settings.syncObsidianConfig &&
      configDir &&
      !visitedDirs.has(configDir) &&
      (await ctx.exists(configDir))
    ) {
      await scanDirectory(configDir);
    }

    return result;
  }

  private async scanRemoteFiles(
    cleanBase: string
  ): Promise<{
    files: Map<string, RemoteFileInfo>;
    caseCollisions: string[][];
    tombstoneShards: RemoteTombstoneShardRef[];
  }> {
    const result = new Map<string, RemoteFileInfo>();
    const tombstoneShards: RemoteTombstoneShardRef[] = [];
    const expectedPrefix = `${cleanBase}/`;

    const items = await this.client.listAll(cleanBase);

    for (const item of items) {
      if (item.isdir === 1) {
        continue;
      }

      const normalizedItemPath = item.path.normalize("NFC");
      if (!normalizedItemPath.startsWith(expectedPrefix)) {
        continue;
      }

      const relativePath = normalizedItemPath.slice(expectedPrefix.length);
      if (!relativePath) {
        continue;
      }

      // Intercept cloud tombstone shards BEFORE SyncFilter (legacy plugin versions ignore
      // `/plugins/baidu-netdisk-sync/` automatically for zero-breakage mixed-version safety).
      const shardDeviceId = extractTombstoneDeviceId(relativePath);
      if (shardDeviceId) {
        tombstoneShards.push({
          deviceId: shardDeviceId,
          relativePath,
          remotePath: item.path,
          fsId: item.fs_id,
          mtime: (item.server_mtime || 0) * 1000,
          size: item.size || 0
        });
        continue;
      }

      if (this.filter.shouldIgnore(relativePath, false)) {
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

    // Detect remote files whose paths differ ONLY by letter case (e.g. Note.md vs note.md)
    // to prevent silent clobbering on case-insensitive macOS/Windows/iOS filesystems.
    const caseGroups = new Map<string, string[]>();
    for (const key of result.keys()) {
      const lower = key.toLowerCase();
      const group = caseGroups.get(lower);
      if (group) {
        group.push(key);
      } else {
        caseGroups.set(lower, [key]);
      }
    }

    const caseCollisions: string[][] = [];
    for (const group of caseGroups.values()) {
      if (group.length >= 2) {
        caseCollisions.push(group);
        for (const key of group) {
          result.delete(key);
        }
      }
    }

    return { files: result, caseCollisions, tombstoneShards };
  }
}
