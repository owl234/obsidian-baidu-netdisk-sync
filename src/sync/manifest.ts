import { FS_META_TIMEOUT_MS, OperationTimeoutError, withTimeout } from "./timeout";

export interface ManifestStorageAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
}

export interface ManifestItem {
  path: string;           // Local relative path, e.g. "Folder/Note.md"
  remotePath: string;     // Remote absolute path, e.g. "/apps/obsidian_vault/Folder/Note.md"
  mtime: number;          // Local last modified time in milliseconds
  remoteMtime: number;    // Remote server_mtime in milliseconds
  md5: string;            // File MD5
  size: number;           // Local file size in bytes
  remoteSize?: number;    // Remote file size in bytes (with encryption overhead)
  fsId?: string | number; // Baidu Netdisk fs_id
}

export interface SyncManifest {
  version: number;
  lastSyncTime: number;
  files: Record<string, ManifestItem>;
}

export interface ManifestManagerOptions {
  adapterTimeoutMs?: number;
  checkpointItemThreshold?: number;
  checkpointIntervalMs?: number;
}

const DEFAULT_CHECKPOINT_ITEMS = 25;
const DEFAULT_CHECKPOINT_INTERVAL_MS = 20_000;

async function ensureDirRecursive(
  adapter: ManifestStorageAdapter,
  dirPath: string,
  timeoutMs: number
): Promise<void> {
  const parts = dirPath.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const exists = await withTimeout(
      adapter.exists(current),
      timeoutMs,
      `manifest.exists(${current})`,
      "vault"
    );
    if (!exists) {
      await withTimeout(
        adapter.mkdir(current),
        timeoutMs,
        `manifest.mkdir(${current})`,
        "vault"
      );
    }
  }
}

export class ManifestManager {
  private manifest: SyncManifest = {
    version: 1,
    lastSyncTime: 0,
    files: {}
  };
  private dirtyCount = 0;
  private lastSaveTime = 0;
  private dirEnsured = false;
  private activeSavePromise: Promise<void> | null = null;
  private pendingResave = false;
  private adapterTimeoutMs: number;
  private checkpointItemThreshold: number;
  private checkpointIntervalMs: number;

  constructor(
    private adapter: ManifestStorageAdapter,
    private manifestFilePath: string,
    options: ManifestManagerOptions = {}
  ) {
    this.adapterTimeoutMs = options.adapterTimeoutMs ?? FS_META_TIMEOUT_MS;
    this.checkpointItemThreshold = options.checkpointItemThreshold ?? DEFAULT_CHECKPOINT_ITEMS;
    this.checkpointIntervalMs = options.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS;
  }

  async load(): Promise<SyncManifest> {
    try {
      const exists = await withTimeout(
        this.adapter.exists(this.manifestFilePath),
        this.adapterTimeoutMs,
        "manifest.exists",
        "vault"
      );
      if (exists) {
        this.dirEnsured = true;
        const raw = await withTimeout(
          this.adapter.read(this.manifestFilePath),
          this.adapterTimeoutMs,
          "manifest.read",
          "vault"
        );
        const parsed = JSON.parse(raw) as Partial<SyncManifest>;
        if (parsed && typeof parsed === "object" && parsed.files && typeof parsed.files === "object") {
          this.manifest = {
            version: typeof parsed.version === "number" ? parsed.version : 1,
            lastSyncTime: typeof parsed.lastSyncTime === "number" ? parsed.lastSyncTime : 0,
            files: parsed.files
          };
        } else {
          this.manifest = { version: 1, lastSyncTime: 0, files: {} };
        }
      }
    } catch (err) {
      if (err instanceof OperationTimeoutError) {
        throw err;
      }
      console.warn("[BaiduSync] Failed to load sync_manifest, starting fresh:", err);
      this.manifest = {
        version: 1,
        lastSyncTime: 0,
        files: {}
      };
    }
    this.dirtyCount = 0;
    this.lastSaveTime = Date.now();
    return this.manifest;
  }

  /**
   * Serialized, coalesced save: concurrent callers share a single in-flight write
   * and trigger at most one follow-up flush if new mutations arrive mid-write.
   * Directory existence is cached to avoid redundant mobile bridge IPC calls.
   */
  async save(): Promise<void> {
    if (this.activeSavePromise) {
      this.pendingResave = true;
      return this.activeSavePromise;
    }

    const runSave = async (): Promise<void> => {
      try {
        do {
          this.pendingResave = false;
          const dirtySnapshot = this.dirtyCount;
          this.dirtyCount = 0;

          try {
            if (!this.dirEnsured) {
              const lastSlash = this.manifestFilePath.lastIndexOf("/");
              if (lastSlash > 0) {
                const dir = this.manifestFilePath.substring(0, lastSlash);
                await ensureDirRecursive(this.adapter, dir, this.adapterTimeoutMs);
              }
              this.dirEnsured = true;
            }

            const payload = JSON.stringify(this.manifest, null, 2);
            await withTimeout(
              this.adapter.write(this.manifestFilePath, payload),
              this.adapterTimeoutMs,
              "manifest.write",
              "vault"
            );
            this.lastSaveTime = Date.now();
          } catch (err) {
            this.dirtyCount += dirtySnapshot;
            console.error("[BaiduSync] Failed to save sync_manifest:", err);
            break;
          }
        } while (this.pendingResave || this.dirtyCount > 0);
      } finally {
        this.activeSavePromise = null;
      }
    };

    this.activeSavePromise = runSave();
    return this.activeSavePromise;
  }

  /**
   * Persists the manifest incrementally once either the mutation count threshold
   * or elapsed wall-clock interval threshold is reached.
   */
  async maybeCheckpoint(
    itemThreshold = this.checkpointItemThreshold,
    intervalMs = this.checkpointIntervalMs
  ): Promise<boolean> {
    if (this.dirtyCount <= 0) {
      return false;
    }

    const now = Date.now();
    const elapsed = this.lastSaveTime > 0 ? now - this.lastSaveTime : Infinity;
    if (this.dirtyCount < itemThreshold && elapsed < intervalMs) {
      return false;
    }

    await this.save();
    return true;
  }

  isDirty(): boolean {
    return this.dirtyCount > 0;
  }

  getDirtyCount(): number {
    return this.dirtyCount;
  }

  get(path: string): ManifestItem | undefined {
    return this.manifest.files[path];
  }

  set(item: ManifestItem): void {
    this.manifest.files[item.path] = item;
    this.dirtyCount++;
  }

  delete(path: string): void {
    if (Object.prototype.hasOwnProperty.call(this.manifest.files, path)) {
      delete this.manifest.files[path];
      this.dirtyCount++;
    }
  }

  getAll(): Record<string, ManifestItem> {
    return this.manifest.files;
  }

  updateLastSyncTime(time = Date.now()): void {
    this.manifest.lastSyncTime = time;
  }

  getLastSyncTime(): number {
    return this.manifest.lastSyncTime;
  }
}
