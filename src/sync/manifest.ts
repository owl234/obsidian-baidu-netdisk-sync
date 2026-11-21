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

async function ensureDirRecursive(adapter: ManifestStorageAdapter, dirPath: string): Promise<void> {
  const parts = dirPath.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await adapter.exists(current))) {
      await adapter.mkdir(current);
    }
  }
}

export class ManifestManager {
  private manifest: SyncManifest = {
    version: 1,
    lastSyncTime: 0,
    files: {}
  };

  constructor(
    private adapter: ManifestStorageAdapter,
    private manifestFilePath: string
  ) {}

  async load(): Promise<SyncManifest> {
    try {
      if (await this.adapter.exists(this.manifestFilePath)) {
        const raw = await this.adapter.read(this.manifestFilePath);
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
      console.warn("[BaiduSync] Failed to load sync_manifest, starting fresh:", err);
      this.manifest = {
        version: 1,
        lastSyncTime: 0,
        files: {}
      };
    }
    return this.manifest;
  }

  async save(): Promise<void> {
    try {
      const lastSlash = this.manifestFilePath.lastIndexOf("/");
      if (lastSlash > 0) {
        const dir = this.manifestFilePath.substring(0, lastSlash);
        await ensureDirRecursive(this.adapter, dir);
      }
      await this.adapter.write(
        this.manifestFilePath,
        JSON.stringify(this.manifest, null, 2)
      );
    } catch (err) {
      console.error("[BaiduSync] Failed to save sync_manifest:", err);
    }
  }

  get(path: string): ManifestItem | undefined {
    return this.manifest.files[path];
  }

  set(item: ManifestItem): void {
    this.manifest.files[item.path] = item;
  }

  delete(path: string): void {
    delete this.manifest.files[path];
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
