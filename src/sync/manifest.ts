import { DataAdapter } from "obsidian";

export interface ManifestItem {
  path: string;           // Local relative path, e.g. "Folder/Note.md"
  remotePath: string;     // Remote absolute path, e.g. "/apps/obsidian_vault/Folder/Note.md"
  mtime: number;          // Local last modified time in milliseconds
  remoteMtime: number;    // Remote server_mtime in milliseconds
  md5: string;            // File MD5
  size: number;           // Local file size in bytes
  remoteSize?: number;    // Remote file size in bytes (with encryption/overhead)
  fsId?: string | number; // Baidu Netdisk fs_id
}

export interface SyncManifest {
  version: number;
  lastSyncTime: number;
  files: Record<string, ManifestItem>;
}

export class ManifestManager {
  private manifest: SyncManifest = {
    version: 1,
    lastSyncTime: 0,
    files: {}
  };

  constructor(
    private adapter: DataAdapter,
    private manifestFilePath: string
  ) {}

  async load(): Promise<SyncManifest> {
    try {
      if (await this.adapter.exists(this.manifestFilePath)) {
        const raw = await this.adapter.read(this.manifestFilePath);
        this.manifest = JSON.parse(raw) as SyncManifest;
        if (!this.manifest.files) {
          this.manifest.files = {};
        }
      }
    } catch (err) {
      console.warn("[BaiduSync] 加载 sync_manifest 失败，将使用空清单:", err);
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
      // Ensure parent directory exists
      const lastSlash = this.manifestFilePath.lastIndexOf("/");
      if (lastSlash > 0) {
        const dir = this.manifestFilePath.substring(0, lastSlash);
        if (!(await this.adapter.exists(dir))) {
          await this.adapter.mkdir(dir);
        }
      }
      await this.adapter.write(
        this.manifestFilePath,
        JSON.stringify(this.manifest, null, 2)
      );
    } catch (err) {
      console.error("[BaiduSync] 保存 sync_manifest 失败:", err);
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
