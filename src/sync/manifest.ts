import { FS_META_TIMEOUT_MS, withTimeout } from "./timeout";
import { t } from "../i18n";

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
  md5: string;            // Remote file MD5 (ciphertext MD5 under E2EE)
  localMd5?: string;      // Local plaintext file MD5 (for both plaintext & E2EE)
  size: number;           // Local file size in bytes
  remoteSize?: number;    // Remote file size in bytes (with encryption overhead)
  fsId?: string | number; // Baidu Netdisk fs_id
}

export interface SyncManifest {
  version: number;
  lastSyncTime: number;
  remoteBasePath?: string;
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

function parseManifestJson(raw: string): SyncManifest | null {
  let parsed: Partial<SyncManifest>;
  try {
    parsed = JSON.parse(raw) as Partial<SyncManifest>;
  } catch {
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !parsed.files ||
    typeof parsed.files !== "object" ||
    Array.isArray(parsed.files)
  ) {
    return null;
  }

  // Normalize keys to Unicode NFC so macOS NFD / Baidu NFC paths always map to one baseline entry
  const normalizedFiles: Record<string, ManifestItem> = {};
  for (const [k, item] of Object.entries(parsed.files)) {
    if (!item || typeof item !== "object") continue;
    const canonicalKey = k.normalize("NFC");
    normalizedFiles[canonicalKey] = {
      ...item,
      path: typeof item.path === "string" ? item.path.normalize("NFC") : canonicalKey
    };
  }

  return {
    version: typeof parsed.version === "number" ? parsed.version : 1,
    lastSyncTime: typeof parsed.lastSyncTime === "number" ? parsed.lastSyncTime : 0,
    remoteBasePath: typeof parsed.remoteBasePath === "string" ? parsed.remoteBasePath : undefined,
    files: normalizedFiles
  };
}

export class ManifestManager {
  private manifest: SyncManifest = {
    version: 1,
    lastSyncTime: 0,
    files: {}
  };
  private readonly backupFilePath: string;
  private dirtyCount = 0;
  private lastSaveTime = 0;
  private dirEnsured = false;
  private activeSavePromise: Promise<void> | null = null;
  private pendingResave = false;
  private lastPersistedPayload: string | null = null;
  private recoveredFromBackup = false;
  private adapterTimeoutMs: number;
  private checkpointItemThreshold: number;
  private checkpointIntervalMs: number;

  constructor(
    private adapter: ManifestStorageAdapter,
    private manifestFilePath: string,
    options: ManifestManagerOptions = {}
  ) {
    this.backupFilePath = `${manifestFilePath}.bak`;
    this.adapterTimeoutMs = options.adapterTimeoutMs ?? FS_META_TIMEOUT_MS;
    this.checkpointItemThreshold = options.checkpointItemThreshold ?? DEFAULT_CHECKPOINT_ITEMS;
    this.checkpointIntervalMs = options.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS;
  }

  private async tryLoadBackup(): Promise<{ manifest: SyncManifest; raw: string } | null> {
    const bakExists = await withTimeout(
      this.adapter.exists(this.backupFilePath),
      this.adapterTimeoutMs,
      "manifest.backupExists",
      "vault"
    );
    if (!bakExists) {
      return null;
    }

    const bakRaw = await withTimeout(
      this.adapter.read(this.backupFilePath),
      this.adapterTimeoutMs,
      "manifest.readBackup",
      "vault"
    );
    const parsed = parseManifestJson(bakRaw);
    if (!parsed) {
      return null;
    }
    return { manifest: parsed, raw: bakRaw };
  }

  wasRecoveredFromBackup(): boolean {
    return this.recoveredFromBackup;
  }

  async load(): Promise<SyncManifest> {
    this.recoveredFromBackup = false;

    const exists = await withTimeout(
      this.adapter.exists(this.manifestFilePath),
      this.adapterTimeoutMs,
      "manifest.exists",
      "vault"
    );
    if (!exists) {
      const backup = await this.tryLoadBackup();
      if (backup) {
        this.dirEnsured = true;
        this.manifest = backup.manifest;
        this.lastPersistedPayload = backup.raw;
        this.recoveredFromBackup = true;
        this.dirtyCount = 1;
        this.lastSaveTime = Date.now();
        return this.manifest;
      }

      this.manifest = {
        version: 1,
        lastSyncTime: 0,
        files: {}
      };
      this.lastPersistedPayload = null;
      this.dirtyCount = 0;
      this.lastSaveTime = Date.now();
      return this.manifest;
    }

    this.dirEnsured = true;
    const raw = await withTimeout(
      this.adapter.read(this.manifestFilePath),
      this.adapterTimeoutMs,
      "manifest.read",
      "vault"
    );

    const parsed = parseManifestJson(raw);
    if (!parsed) {
      const backup = await this.tryLoadBackup();
      if (backup) {
        this.manifest = backup.manifest;
        this.lastPersistedPayload = backup.raw;
        this.recoveredFromBackup = true;
        this.dirtyCount = 1;
        this.lastSaveTime = Date.now();
        return this.manifest;
      }
      throw new Error(t("engine.manifestCorrupted"));
    }

    this.manifest = parsed;
    this.lastPersistedPayload = raw;
    this.dirtyCount = 0;
    this.lastSaveTime = Date.now();
    return this.manifest;
  }

  /**
   * Serialized, coalesced, backup-protected save:
   * - Concurrent callers share a single in-flight write and trigger at most one follow-up flush.
   * - Preserves the previous valid JSON payload in `sync_manifest.json.bak` before overwriting.
   * - Propagates write failures instead of silently swallowing them.
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

            if (this.lastPersistedPayload !== null && this.lastPersistedPayload !== payload) {
              await withTimeout(
                this.adapter.write(this.backupFilePath, this.lastPersistedPayload),
                this.adapterTimeoutMs,
                "manifest.writeBackup",
                "vault"
              );
            }

            await withTimeout(
              this.adapter.write(this.manifestFilePath, payload),
              this.adapterTimeoutMs,
              "manifest.write",
              "vault"
            );
            this.lastPersistedPayload = payload;
            this.lastSaveTime = Date.now();
          } catch (err) {
            this.dirtyCount += dirtySnapshot;
            console.error("[BaiduSync] Failed to save sync_manifest:", err);
            throw err;
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
   * Explicitly resets the persisted manifest and backup to a clean empty baseline
   * without touching any vault or remote files.
   */
  async resetBaseline(remoteBasePath?: string): Promise<void> {
    if (this.activeSavePromise) {
      await this.activeSavePromise.catch(() => {});
    }

    this.manifest = {
      version: 1,
      lastSyncTime: 0,
      remoteBasePath,
      files: {}
    };
    this.recoveredFromBackup = false;
    this.lastPersistedPayload = null;
    this.dirtyCount = 0;

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
      "manifest.resetWrite",
      "vault"
    );

    const bakExists = await withTimeout(
      this.adapter.exists(this.backupFilePath),
      this.adapterTimeoutMs,
      "manifest.resetBackupExists",
      "vault"
    );
    if (bakExists) {
      await withTimeout(
        this.adapter.write(this.backupFilePath, payload),
        this.adapterTimeoutMs,
        "manifest.resetBackupWrite",
        "vault"
      );
    }

    this.lastPersistedPayload = payload;
    this.lastSaveTime = Date.now();
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
    return this.manifest.files[path.normalize("NFC")];
  }

  set(item: ManifestItem): void {
    const canonical = item.path.normalize("NFC");
    this.manifest.files[canonical] = {
      ...item,
      path: canonical
    };
    this.dirtyCount++;
  }

  delete(path: string): void {
    const canonical = path.normalize("NFC");
    if (Object.prototype.hasOwnProperty.call(this.manifest.files, canonical)) {
      delete this.manifest.files[canonical];
      this.dirtyCount++;
    }
  }

  getAll(): Record<string, ManifestItem> {
    return this.manifest.files;
  }

  getRemoteBasePath(): string | undefined {
    return this.manifest.remoteBasePath;
  }

  setRemoteBasePath(remoteBasePath: string): void {
    this.manifest.remoteBasePath = remoteBasePath;
  }

  resetForRemoteBase(remoteBasePath: string): void {
    this.manifest = {
      version: 1,
      lastSyncTime: 0,
      remoteBasePath,
      files: {}
    };
    this.dirtyCount++;
  }

  updateLastSyncTime(time = Date.now()): void {
    this.manifest.lastSyncTime = time;
  }

  getLastSyncTime(): number {
    return this.manifest.lastSyncTime;
  }
}
