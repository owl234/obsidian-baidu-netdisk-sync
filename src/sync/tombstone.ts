import { ManifestStorageAdapter } from "./manifest";
import { FS_META_TIMEOUT_MS, withTimeout } from "./timeout";

// Placed under `/plugins/baidu-netdisk-sync/` so ALL legacy plugin versions (<= 1.1.4)
// automatically ignore it via SyncFilter without ever hardcoding `.obsidian` configDir.
export const REMOTE_TOMBSTONE_DIR_REL = ".bdsync-meta/plugins/baidu-netdisk-sync/tombstones";
export const TOMBSTONE_RETENTION_MS = 365 * 24 * 60 * 60 * 1000; // 365 days
export const TOMBSTONE_RETIRED_SHARD_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // +30 days grace (395 days total)
export const TOMBSTONE_MAX_ENTRIES_PER_DEVICE = 10_000;

const DEVICE_ID_REGEX = /^[a-z0-9][a-z0-9-]{6,62}[a-z0-9]$/;

export interface TombstoneRecord {
  /** UTC epoch ms when the deletion occurred */
  deletedAt: number;
  /** Plaintext MD5 hash of the deleted file (if known) */
  deletedHash?: string;
  /** Plaintext file size in bytes (if known) */
  deletedSize?: number;
  /** Previous Baidu Netdisk fs_id (string preserves 64-bit precision) */
  deletedFsId?: string;
  /** Local or remote mtime prior to deletion (ms) */
  deletedMtime?: number;
}

export interface TombstoneEntry extends TombstoneRecord {
  /** Canonical NFC relative vault path */
  path: string;
  /** Device ID that recorded this deletion */
  deviceId: string;
}

export interface TombstoneShardFile {
  version: 1;
  deviceId: string;
  updatedAt: number;
  entries: Record<string, TombstoneRecord>;
}

export interface RemoteTombstoneShardRef {
  deviceId: string;
  relativePath: string;
  remotePath: string;
  fsId: string | number;
  mtime: number; // ms
  size: number;
}

interface CachedRemoteShard {
  deviceId: string;
  fsId: string;
  remoteMtime: number;
  remoteSize: number;
  entries: Record<string, TombstoneRecord>;
}

interface PersistedTombstoneCache {
  version: 1;
  remoteBasePath?: string;
  ownDeviceId?: string;
  ownShardPendingUpload: boolean;
  ownEntries: Record<string, TombstoneRecord>;
  remoteShards: Record<string, CachedRemoteShard>;
}

export interface TombstoneManagerOptions {
  adapterTimeoutMs?: number;
  retentionMs?: number;
  retiredShardGraceMs?: number;
  maxEntriesPerDevice?: number;
}

function getCrypto(): Crypto {
  if (typeof activeWindow !== "undefined" && activeWindow.crypto) {
    return activeWindow.crypto;
  }
  if (typeof window !== "undefined" && window.crypto) {
    return window.crypto;
  }
  return crypto;
}

export function isValidDeviceId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_ID_REGEX.test(value);
}

export function generateDeviceId(): string {
  const bytes = getCrypto().getRandomValues(new Uint8Array(12));
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return `dev-${hex}`;
}

export function buildRemoteTombstonePath(cleanRemoteBase: string, deviceId: string): string {
  return `${cleanRemoteBase}/${REMOTE_TOMBSTONE_DIR_REL}/${deviceId}.json`;
}

/**
 * Checks whether a normalized NFC relative path under remoteBasePath is a cloud tombstone shard
 * and returns its sanitized deviceId if valid, or null otherwise.
 */
export function extractTombstoneDeviceId(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "").normalize("NFC");
  const prefix = `${REMOTE_TOMBSTONE_DIR_REL}/`;
  if (!normalized.startsWith(prefix) || !normalized.endsWith(".json")) {
    return null;
  }
  const filename = normalized.slice(prefix.length);
  if (filename.includes("/")) {
    return null;
  }
  const deviceId = filename.slice(0, -".json".length);
  return isValidDeviceId(deviceId) ? deviceId : null;
}

function sanitizeRecord(raw: unknown): TombstoneRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.deletedAt !== "number" || !Number.isFinite(obj.deletedAt) || obj.deletedAt <= 0) {
    return null;
  }
  const rec: TombstoneRecord = {
    deletedAt: obj.deletedAt
  };
  if (typeof obj.deletedHash === "string" && obj.deletedHash.length > 0) {
    rec.deletedHash = obj.deletedHash.toLowerCase();
  }
  if (typeof obj.deletedSize === "number" && Number.isFinite(obj.deletedSize) && obj.deletedSize >= 0) {
    rec.deletedSize = obj.deletedSize;
  }
  if (typeof obj.deletedFsId === "string" && obj.deletedFsId.length > 0) {
    rec.deletedFsId = obj.deletedFsId;
  } else if (typeof obj.deletedFsId === "number" && Number.isFinite(obj.deletedFsId)) {
    rec.deletedFsId = String(obj.deletedFsId);
  }
  if (typeof obj.deletedMtime === "number" && Number.isFinite(obj.deletedMtime) && obj.deletedMtime >= 0) {
    rec.deletedMtime = obj.deletedMtime;
  }
  return rec;
}

function sanitizeEntriesMap(raw: unknown): Record<string, TombstoneRecord> {
  const out: Record<string, TombstoneRecord> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const cleanKey = k.replace(/\\/g, "/").replace(/^\/+/, "").normalize("NFC");
    if (!cleanKey) continue;
    const rec = sanitizeRecord(v);
    if (rec) {
      out[cleanKey] = rec;
    }
  }
  return out;
}

export function parseTombstoneShardBuffer(buffer: ArrayBuffer, expectedDeviceId?: string): TombstoneShardFile | null {
  let rawText: string;
  try {
    rawText = new TextDecoder().decode(buffer);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const deviceId = isValidDeviceId(obj.deviceId) ? obj.deviceId : expectedDeviceId;
  if (!deviceId) {
    return null;
  }
  if (!obj.entries || typeof obj.entries !== "object" || Array.isArray(obj.entries)) {
    return null;
  }

  return {
    version: 1,
    deviceId,
    updatedAt: typeof obj.updatedAt === "number" && Number.isFinite(obj.updatedAt) ? obj.updatedAt : 0,
    entries: sanitizeEntriesMap(obj.entries)
  };
}

function parsePersistedCache(raw: string): PersistedTombstoneCache | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const remoteShards: Record<string, CachedRemoteShard> = {};
  if (obj.remoteShards && typeof obj.remoteShards === "object" && !Array.isArray(obj.remoteShards)) {
    for (const [devId, shardVal] of Object.entries(obj.remoteShards as Record<string, unknown>)) {
      if (!isValidDeviceId(devId) || !shardVal || typeof shardVal !== "object" || Array.isArray(shardVal)) {
        continue;
      }
      const s = shardVal as Record<string, unknown>;
      remoteShards[devId] = {
        deviceId: devId,
        fsId:
          typeof s.fsId === "string"
            ? s.fsId
            : typeof s.fsId === "number" && Number.isFinite(s.fsId)
              ? String(s.fsId)
              : "",
        remoteMtime: typeof s.remoteMtime === "number" ? s.remoteMtime : 0,
        remoteSize: typeof s.remoteSize === "number" ? s.remoteSize : 0,
        entries: sanitizeEntriesMap(s.entries)
      };
    }
  }

  return {
    version: 1,
    remoteBasePath: typeof obj.remoteBasePath === "string" ? obj.remoteBasePath : undefined,
    ownDeviceId: isValidDeviceId(obj.ownDeviceId) ? obj.ownDeviceId : undefined,
    ownShardPendingUpload: Boolean(obj.ownShardPendingUpload),
    ownEntries: sanitizeEntriesMap(obj.ownEntries),
    remoteShards
  };
}

function createEmptyCache(remoteBasePath?: string): PersistedTombstoneCache {
  return {
    version: 1,
    remoteBasePath,
    ownShardPendingUpload: false,
    ownEntries: {},
    remoteShards: {}
  };
}

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
      `tombstone.exists(${current})`,
      "vault"
    );
    if (!exists) {
      await withTimeout(
        adapter.mkdir(current),
        timeoutMs,
        `tombstone.mkdir(${current})`,
        "vault"
      );
    }
  }
}

export class TombstoneManager {
  private cache: PersistedTombstoneCache = createEmptyCache();
  private readonly backupFilePath: string;
  private readonly adapterTimeoutMs: number;
  private readonly retentionMs: number;
  private readonly retiredShardGraceMs: number;
  private readonly maxEntriesPerDevice: number;
  private dirty = false;
  private dirEnsured = false;
  private lastPersistedPayload: string | null = null;
  private activeSavePromise: Promise<void> | null = null;
  private pendingResave = false;

  constructor(
    private adapter: ManifestStorageAdapter,
    private cacheFilePath: string,
    options: TombstoneManagerOptions = {}
  ) {
    this.backupFilePath = `${cacheFilePath}.bak`;
    this.adapterTimeoutMs = options.adapterTimeoutMs ?? FS_META_TIMEOUT_MS;
    this.retentionMs = options.retentionMs ?? TOMBSTONE_RETENTION_MS;
    this.retiredShardGraceMs = options.retiredShardGraceMs ?? TOMBSTONE_RETIRED_SHARD_GRACE_MS;
    this.maxEntriesPerDevice = options.maxEntriesPerDevice ?? TOMBSTONE_MAX_ENTRIES_PER_DEVICE;
  }

  private async tryLoadBackup(): Promise<{ cache: PersistedTombstoneCache; raw: string } | null> {
    const bakExists = await withTimeout(
      this.adapter.exists(this.backupFilePath),
      this.adapterTimeoutMs,
      "tombstone.backupExists",
      "vault"
    );
    if (!bakExists) return null;
    const bakRaw = await withTimeout(
      this.adapter.read(this.backupFilePath),
      this.adapterTimeoutMs,
      "tombstone.readBackup",
      "vault"
    );
    const parsed = parsePersistedCache(bakRaw);
    if (!parsed) return null;
    return { cache: parsed, raw: bakRaw };
  }

  async load(): Promise<void> {
    const exists = await withTimeout(
      this.adapter.exists(this.cacheFilePath),
      this.adapterTimeoutMs,
      "tombstone.exists",
      "vault"
    );
    if (!exists) {
      const backup = await this.tryLoadBackup();
      if (backup) {
        this.dirEnsured = true;
        this.cache = backup.cache;
        this.lastPersistedPayload = backup.raw;
        this.dirty = true;
        return;
      }
      this.cache = createEmptyCache();
      this.lastPersistedPayload = null;
      this.dirty = false;
      return;
    }

    this.dirEnsured = true;
    const raw = await withTimeout(
      this.adapter.read(this.cacheFilePath),
      this.adapterTimeoutMs,
      "tombstone.read",
      "vault"
    );
    const parsed = parsePersistedCache(raw);
    if (!parsed) {
      const backup = await this.tryLoadBackup();
      if (backup) {
        this.cache = backup.cache;
        this.lastPersistedPayload = backup.raw;
        this.dirty = true;
        return;
      }
      // Cache is regenerable from remote shards; fall back cleanly instead of wedging sync.
      this.cache = createEmptyCache();
      this.lastPersistedPayload = null;
      this.dirty = true;
      return;
    }

    this.cache = parsed;
    this.lastPersistedPayload = raw;
    this.dirty = false;
  }

  async save(): Promise<void> {
    if (this.activeSavePromise) {
      this.pendingResave = true;
      return this.activeSavePromise;
    }

    const runSave = async (): Promise<void> => {
      try {
        do {
          this.pendingResave = false;
          const wasDirty = this.dirty;
          this.dirty = false;
          try {
            if (!this.dirEnsured) {
              const lastSlash = this.cacheFilePath.lastIndexOf("/");
              if (lastSlash > 0) {
                const dir = this.cacheFilePath.substring(0, lastSlash);
                await ensureDirRecursive(this.adapter, dir, this.adapterTimeoutMs);
              }
              this.dirEnsured = true;
            }
            const payload = JSON.stringify(this.cache, null, 2);
            if (this.lastPersistedPayload !== null && this.lastPersistedPayload !== payload) {
              await withTimeout(
                this.adapter.write(this.backupFilePath, this.lastPersistedPayload),
                this.adapterTimeoutMs,
                "tombstone.writeBackup",
                "vault"
              );
            }
            await withTimeout(
              this.adapter.write(this.cacheFilePath, payload),
              this.adapterTimeoutMs,
              "tombstone.write",
              "vault"
            );
            this.lastPersistedPayload = payload;
          } catch (err) {
            if (wasDirty) this.dirty = true;
            throw err;
          }
        } while (this.pendingResave || this.dirty);
      } finally {
        this.activeSavePromise = null;
      }
    };

    this.activeSavePromise = runSave();
    return this.activeSavePromise;
  }

  ensureRemoteBase(cleanRemoteBase: string, currentDeviceId: string): void {
    const prevBase = this.cache.remoteBasePath;
    if (prevBase !== undefined && prevBase !== cleanRemoteBase) {
      this.cache = createEmptyCache(cleanRemoteBase);
      this.cache.ownDeviceId = currentDeviceId;
      this.dirty = true;
      return;
    }
    if (this.cache.remoteBasePath !== cleanRemoteBase) {
      this.cache.remoteBasePath = cleanRemoteBase;
      this.dirty = true;
    }
    if (this.cache.ownDeviceId !== currentDeviceId) {
      // Device identity changed (e.g. fresh pairing); keep remoteShards cache but clear ownEntries
      this.cache.ownDeviceId = currentDeviceId;
      this.cache.ownEntries = {};
      this.cache.ownShardPendingUpload = false;
      this.dirty = true;
    }
  }

  /**
   * Incrementally fetches any remote tombstone shards whose fs_id, server_mtime, or size changed.
   * Steady state performs 0 downloads. Throws on download/decrypt failure (fail-closed).
   */
  async syncRemoteShards(
    remoteShards: RemoteTombstoneShardRef[],
    currentDeviceId: string,
    downloadShard: (shard: RemoteTombstoneShardRef) => Promise<ArrayBuffer>
  ): Promise<{ downloaded: number; skippedCached: number }> {
    const activeDevIds = new Set<string>(remoteShards.map((s) => s.deviceId));
    for (const cachedDevId of Object.keys(this.cache.remoteShards)) {
      if (!activeDevIds.has(cachedDevId)) {
        delete this.cache.remoteShards[cachedDevId];
        this.dirty = true;
      }
    }

    let downloaded = 0;
    let skippedCached = 0;

    for (const ref of remoteShards) {
      const existing = this.cache.remoteShards[ref.deviceId];
      const fsIdStr = String(ref.fsId);
      const isUnchanged =
        existing &&
        existing.fsId === fsIdStr &&
        existing.remoteMtime === ref.mtime &&
        existing.remoteSize === ref.size;

      if (isUnchanged) {
        skippedCached++;
      } else {
        const buffer = await downloadShard(ref);
        const parsed = parseTombstoneShardBuffer(buffer, ref.deviceId);
        if (!parsed) {
          throw new Error(`Invalid cloud tombstone shard payload (${ref.deviceId})`);
        }
        this.cache.remoteShards[ref.deviceId] = {
          deviceId: ref.deviceId,
          fsId: fsIdStr,
          remoteMtime: ref.mtime,
          remoteSize: ref.size,
          entries: parsed.entries
        };
        this.dirty = true;
        downloaded++;
      }

      // If this is our own device's remote shard and our local cache lost own entries
      // (e.g. cache deleted/recreated), recover missing entries unless we have pending local changes.
      if (ref.deviceId === currentDeviceId) {
        const syncedSelf = this.cache.remoteShards[ref.deviceId];
        if (syncedSelf && !this.cache.ownShardPendingUpload) {
          for (const [p, rec] of Object.entries(syncedSelf.entries)) {
            const localRec = this.cache.ownEntries[p];
            if (!localRec || rec.deletedAt > localRec.deletedAt) {
              this.cache.ownEntries[p] = { ...rec };
              this.dirty = true;
            }
          }
        }
      }
    }

    return { downloaded, skippedCached };
  }

  recordDeletion(path: string, record: TombstoneRecord): void {
    const canonical = path.replace(/\\/g, "/").replace(/^\/+/, "").normalize("NFC");
    if (!canonical) return;
    const existing = this.cache.ownEntries[canonical];
    if (!existing || record.deletedAt >= existing.deletedAt) {
      this.cache.ownEntries[canonical] = {
        deletedAt: record.deletedAt,
        deletedHash: record.deletedHash ? record.deletedHash.toLowerCase() : undefined,
        deletedSize: record.deletedSize,
        deletedFsId: record.deletedFsId,
        deletedMtime: record.deletedMtime
      };
      this.cache.ownShardPendingUpload = true;
      this.dirty = true;
    }
  }

  clearOwnEntry(path: string): boolean {
    const canonical = path.replace(/\\/g, "/").replace(/^\/+/, "").normalize("NFC");
    if (!canonical) return false;
    if (Object.prototype.hasOwnProperty.call(this.cache.ownEntries, canonical)) {
      delete this.cache.ownEntries[canonical];
      this.cache.ownShardPendingUpload = true;
      this.dirty = true;
      return true;
    }
    return false;
  }

  pruneOwnEntries(now = Date.now()): boolean {
    let changed = false;
    const cutoff = now - this.retentionMs;

    for (const [p, rec] of Object.entries(this.cache.ownEntries)) {
      if (rec.deletedAt < cutoff) {
        delete this.cache.ownEntries[p];
        changed = true;
      }
    }

    const keys = Object.keys(this.cache.ownEntries);
    if (keys.length > this.maxEntriesPerDevice) {
      keys.sort((a, b) => this.cache.ownEntries[a].deletedAt - this.cache.ownEntries[b].deletedAt);
      const excess = keys.length - this.maxEntriesPerDevice;
      for (let i = 0; i < excess; i++) {
        delete this.cache.ownEntries[keys[i]];
      }
      changed = true;
    }

    if (changed) {
      this.dirty = true;
    }
    return changed;
  }

  /**
   * Merges all non-expired tombstones across remote shards and local ownEntries.
   * For the current device, ownEntries is authoritative over the cached remote copy.
   * Across devices, LWW semantics (highest deletedAt, deterministic deviceId tie-breaker) apply.
   */
  getMergedTombstones(currentDeviceId: string, now = Date.now()): Map<string, TombstoneEntry> {
    const merged = new Map<string, TombstoneEntry>();
    const cutoff = now - this.retentionMs;

    const consider = (path: string, deviceId: string, rec: TombstoneRecord) => {
      if (rec.deletedAt < cutoff) return;
      const existing = merged.get(path);
      if (
        !existing ||
        rec.deletedAt > existing.deletedAt ||
        (rec.deletedAt === existing.deletedAt && deviceId > existing.deviceId)
      ) {
        merged.set(path, {
          path,
          deviceId,
          ...rec
        });
      }
    };

    for (const [devId, shard] of Object.entries(this.cache.remoteShards)) {
      if (devId === currentDeviceId) continue;
      for (const [p, rec] of Object.entries(shard.entries)) {
        consider(p, devId, rec);
      }
    }

    for (const [p, rec] of Object.entries(this.cache.ownEntries)) {
      consider(p, currentDeviceId, rec);
    }

    return merged;
  }

  buildOwnShardPayload(currentDeviceId: string, now = Date.now()): ArrayBuffer {
    this.pruneOwnEntries(now);
    const shard: TombstoneShardFile = {
      version: 1,
      deviceId: currentDeviceId,
      updatedAt: now,
      entries: { ...this.cache.ownEntries }
    };
    const encoded = new TextEncoder().encode(JSON.stringify(shard));
    return encoded.slice().buffer;
  }

  markOwnShardUploaded(
    currentDeviceId: string,
    meta: { fsId: string | number; remoteMtime: number; remoteSize: number }
  ): void {
    this.cache.ownShardPendingUpload = false;
    this.cache.remoteShards[currentDeviceId] = {
      deviceId: currentDeviceId,
      fsId: String(meta.fsId),
      remoteMtime: meta.remoteMtime,
      remoteSize: meta.remoteSize,
      entries: { ...this.cache.ownEntries }
    };
    this.dirty = true;
  }

  /**
   * Identifies retired peer device shards safe for garbage collection:
   * 1. Belongs to another device (never currentDeviceId).
   * 2. Remote shard `server_mtime` is older than `retentionMs + retiredShardGraceMs` (default 395 days).
   * 3. Contains ZERO active (non-expired) tombstone entries.
   */
  getRetiredRemoteShards(
    remoteShards: RemoteTombstoneShardRef[],
    currentDeviceId: string,
    now = Date.now()
  ): RemoteTombstoneShardRef[] {
    const entryCutoff = now - this.retentionMs;
    const shardCutoff = now - (this.retentionMs + this.retiredShardGraceMs);
    const retired: RemoteTombstoneShardRef[] = [];

    for (const ref of remoteShards) {
      if (ref.deviceId === currentDeviceId) continue;
      if (ref.mtime <= 0 || ref.mtime >= shardCutoff) continue;

      const cached = this.cache.remoteShards[ref.deviceId];
      if (!cached) continue;

      let hasActiveEntry = false;
      for (const rec of Object.values(cached.entries)) {
        if (rec.deletedAt >= entryCutoff) {
          hasActiveEntry = true;
          break;
        }
      }
      if (!hasActiveEntry) {
        retired.push(ref);
      }
    }

    return retired;
  }

  removeCachedRemoteShards(deviceIds: string[]): void {
    for (const devId of deviceIds) {
      if (Object.prototype.hasOwnProperty.call(this.cache.remoteShards, devId)) {
        delete this.cache.remoteShards[devId];
        this.dirty = true;
      }
    }
  }

  isOwnShardPendingUpload(): boolean {
    return this.cache.ownShardPendingUpload;
  }

  hasOwnEntries(): boolean {
    return Object.keys(this.cache.ownEntries).length > 0;
  }

  getOwnEntryCount(): number {
    return Object.keys(this.cache.ownEntries).length;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  async resetCache(remoteBasePath?: string): Promise<void> {
    if (this.activeSavePromise) {
      await this.activeSavePromise.catch(() => {});
    }
    this.cache = createEmptyCache(remoteBasePath);
    this.lastPersistedPayload = null;
    this.dirty = true;
    await this.save();
  }
}
