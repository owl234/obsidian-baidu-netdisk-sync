import { ManifestItem } from "./manifest";

export type SyncActionType =
  | "UPLOAD"
  | "DOWNLOAD"
  | "DELETE_LOCAL"
  | "DELETE_REMOTE"
  | "CLEAN_MANIFEST"
  | "SKIP";

export interface LocalFileInfo {
  path: string;
  mtime: number;
  size: number;
}

export interface RemoteFileInfo {
  path: string; // Relative path
  remotePath: string; // Absolute path on Baidu Netdisk
  mtime: number;
  size: number;
  fsId: string | number;
  md5?: string;
}

export interface SyncPlanItem {
  path: string;
  remotePath: string;
  action: SyncActionType;
  reason: string;
  local?: LocalFileInfo;
  remote?: RemoteFileInfo;
  manifest?: ManifestItem;
}

export class SyncPlanner {
  static plan(
    localFiles: Map<string, LocalFileInfo>,
    remoteFiles: Map<string, RemoteFileInfo>,
    manifestFiles: Record<string, ManifestItem>,
    remoteBasePath: string
  ): SyncPlanItem[] {
    const plans: SyncPlanItem[] = [];
    const allPaths = new Set<string>([
      ...localFiles.keys(),
      ...remoteFiles.keys(),
      ...Object.keys(manifestFiles)
    ]);

    const normalizeRemoteBase = remoteBasePath.endsWith("/")
      ? remoteBasePath.slice(0, -1)
      : remoteBasePath;

    for (const path of allPaths) {
      const local = localFiles.get(path);
      const remote = remoteFiles.get(path);
      const manifest = manifestFiles[path];
      const remotePath = remote?.remotePath || `${normalizeRemoteBase}/${path}`;

      // Case 1: Both sides exist
      if (local && remote) {
        if (!manifest) {
          // No manifest, conflict resolution via LWW
          if (local.mtime >= remote.mtime) {
            plans.push({
              path,
              remotePath,
              action: "UPLOAD",
              reason: "双端均存在且无同步历史，本地时间戳较新 (LWW 胜出)",
              local,
              remote
            });
          } else {
            plans.push({
              path,
              remotePath,
              action: "DOWNLOAD",
              reason: "双端均存在且无同步历史，远端时间戳较新 (LWW 胜出)",
              local,
              remote
            });
          }
          continue;
        }

        // With manifest
        const localChanged =
          Math.abs(local.mtime - manifest.mtime) > 1000 || local.size !== manifest.size;
        const expectedRemoteSize =
          manifest.remoteSize !== undefined ? manifest.remoteSize : manifest.size;
        const remoteChanged =
          Math.abs(remote.mtime - manifest.remoteMtime) > 1000 ||
          remote.size !== expectedRemoteSize;

        if (!localChanged && !remoteChanged) {
          // Both unchanged
          continue;
        } else if (localChanged && !remoteChanged) {
          plans.push({
            path,
            remotePath,
            action: "UPLOAD",
            reason: "本地文件有更新，推送到网盘",
            local,
            remote,
            manifest
          });
        } else if (!localChanged && remoteChanged) {
          plans.push({
            path,
            remotePath,
            action: "DOWNLOAD",
            reason: "网盘端文件有更新，拉取到本地",
            local,
            remote,
            manifest
          });
        } else {
          // Both changed: Conflict resolved by LWW
          if (local.mtime >= remote.mtime) {
            plans.push({
              path,
              remotePath,
              action: "UPLOAD",
              reason: "双端并发修改产生冲突，本地时间戳较新 (LWW 覆盖远端)",
              local,
              remote,
              manifest
            });
          } else {
            plans.push({
              path,
              remotePath,
              action: "DOWNLOAD",
              reason: "双端并发修改产生冲突，远端时间戳较新 (LWW 覆盖本地)",
              local,
              remote,
              manifest
            });
          }
        }
        continue;
      }

      // Case 2: Only local exists
      if (local && !remote) {
        if (!manifest) {
          plans.push({
            path,
            remotePath,
            action: "UPLOAD",
            reason: "本地新增文件，推送到网盘",
            local
          });
        } else {
          // Remote was deleted
          const localChanged =
            Math.abs(local.mtime - manifest.mtime) > 1000 || local.size !== manifest.size;
          if (localChanged) {
            // Local was modified after remote deletion, keep local
            plans.push({
              path,
              remotePath,
              action: "UPLOAD",
              reason: "远端已删除但本地有新修改，重新推送到网盘",
              local,
              manifest
            });
          } else {
            // Remote was deleted and local unchanged -> Delete local
            plans.push({
              path,
              remotePath,
              action: "DELETE_LOCAL",
              reason: "网盘端已删除，同步移入本地回收站",
              local,
              manifest
            });
          }
        }
        continue;
      }

      // Case 3: Only remote exists
      if (!local && remote) {
        if (!manifest) {
          plans.push({
            path,
            remotePath,
            action: "DOWNLOAD",
            reason: "网盘端新增文件，拉取到本地",
            remote
          });
        } else {
          // Local was deleted
          const expectedRemoteSize =
            manifest.remoteSize !== undefined ? manifest.remoteSize : manifest.size;
          const remoteChanged =
            Math.abs(remote.mtime - manifest.remoteMtime) > 1000 ||
            remote.size !== expectedRemoteSize;
          if (remoteChanged) {
            // Remote was modified after local deletion, keep remote
            plans.push({
              path,
              remotePath,
              action: "DOWNLOAD",
              reason: "本地已删除但网盘端有新修改，重新拉取到本地",
              remote,
              manifest
            });
          } else {
            // Local was deleted and remote unchanged -> Delete remote
            plans.push({
              path,
              remotePath,
              action: "DELETE_REMOTE",
              reason: "本地已删除，同步移入网盘回收站",
              remote,
              manifest
            });
          }
        }
        continue;
      }

      // Case 4: Neither exists, but present in manifest
      if (!local && !remote && manifest) {
        plans.push({
          path,
          remotePath,
          action: "CLEAN_MANIFEST",
          reason: "两端均已不存在，清理元数据基线",
          manifest
        });
      }
    }

    return plans;
  }
}
