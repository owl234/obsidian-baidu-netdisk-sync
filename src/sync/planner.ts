import { ManifestItem } from "./manifest";
import { ConflictStrategy } from "../settings/settings";
import { t } from "../i18n";

export type SyncActionType =
  | "UPLOAD"
  | "DOWNLOAD"
  | "CONFLICT"
  | "UPDATE_MANIFEST"
  | "DELETE_LOCAL"
  | "DELETE_REMOTE"
  | "CLEAN_MANIFEST"
  | "SKIP";

export interface LocalFileInfo {
  path: string;
  mtime: number;
  size: number;
  md5?: string;
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
  winner?: "local" | "remote";
  local?: LocalFileInfo;
  remote?: RemoteFileInfo;
  manifest?: ManifestItem;
}

export interface SyncPlanOptions {
  conflictStrategy?: ConflictStrategy;
  enableE2EE?: boolean;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Generates a deterministic conflict backup filename preserving extension and directory.
 * Example: "Notes/Daily.md" -> "Notes/Daily.conflict-20261121-183045.md"
 */
export function buildConflictPath(originalPath: string, date: Date = new Date()): string {
  const stamp =
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-` +
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;

  const lastSlash = originalPath.lastIndexOf("/");
  const dir = lastSlash >= 0 ? originalPath.slice(0, lastSlash + 1) : "";
  const fileName = lastSlash >= 0 ? originalPath.slice(lastSlash + 1) : originalPath;

  const dotIdx = fileName.lastIndexOf(".");
  // Handle dotfiles like ".gitignore" without splitting leading dot
  if (dotIdx > 0) {
    const stem = fileName.slice(0, dotIdx);
    const ext = fileName.slice(dotIdx);
    return `${dir}${stem}.conflict-${stamp}${ext}`;
  }
  return `${dir}${fileName}.conflict-${stamp}`;
}

function isPlaintextIdentical(
  local: LocalFileInfo,
  remote: RemoteFileInfo,
  enableE2EE: boolean
): boolean {
  if (enableE2EE) return false;
  if (local.size !== remote.size) return false;
  if (!local.md5 || !remote.md5) return false;
  return local.md5.toLowerCase() === remote.md5.toLowerCase();
}

export class SyncPlanner {
  static plan(
    localFiles: Map<string, LocalFileInfo>,
    remoteFiles: Map<string, RemoteFileInfo>,
    manifestFiles: Record<string, ManifestItem>,
    remoteBasePath: string,
    options: SyncPlanOptions = {}
  ): SyncPlanItem[] {
    const conflictStrategy: ConflictStrategy = options.conflictStrategy ?? "copy";
    const enableE2EE = options.enableE2EE ?? false;

    const plans: SyncPlanItem[] = [];
    const allPaths = new Set<string>([
      ...localFiles.keys(),
      ...remoteFiles.keys(),
      ...Object.keys(manifestFiles)
    ]);

    const rawBase = remoteBasePath.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "");
    const normalizeRemoteBase = rawBase && !rawBase.startsWith("/") ? `/${rawBase}` : rawBase;

    for (const path of allPaths) {
      const local = localFiles.get(path);
      const remote = remoteFiles.get(path);
      const manifest = manifestFiles[path];
      const remotePath = remote?.remotePath || `${normalizeRemoteBase}/${path}`;

      // Case 1: Both sides exist
      if (local && remote) {
        if (!manifest) {
          // If plaintext files have identical size & MD5, just record manifest baseline
          if (isPlaintextIdentical(local, remote, enableE2EE)) {
            plans.push({
              path,
              remotePath,
              action: "UPDATE_MANIFEST",
              reason: t("plan.identicalBaseline"),
              local,
              remote
            });
            continue;
          }

          const winner: "local" | "remote" = local.mtime >= remote.mtime ? "local" : "remote";
          if (conflictStrategy === "copy") {
            plans.push({
              path,
              remotePath,
              action: "CONFLICT",
              winner,
              reason: t("plan.noManifestConflict"),
              local,
              remote
            });
          } else if (winner === "local") {
            plans.push({
              path,
              remotePath,
              action: "UPLOAD",
              reason: t("plan.noManifestLocalNewer"),
              local,
              remote
            });
          } else {
            plans.push({
              path,
              remotePath,
              action: "DOWNLOAD",
              reason: t("plan.noManifestRemoteNewer"),
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
        const fsIdChanged =
          Boolean(manifest.fsId) &&
          Boolean(remote.fsId) &&
          String(remote.fsId) !== String(manifest.fsId);
        const remoteChanged =
          Math.abs(remote.mtime - manifest.remoteMtime) > 1000 ||
          remote.size !== expectedRemoteSize ||
          fsIdChanged;

        if (!localChanged && !remoteChanged) {
          continue;
        } else if (localChanged && !remoteChanged) {
          plans.push({
            path,
            remotePath,
            action: "UPLOAD",
            reason: t("plan.localModified"),
            local,
            remote,
            manifest
          });
        } else if (!localChanged && remoteChanged) {
          plans.push({
            path,
            remotePath,
            action: "DOWNLOAD",
            reason: t("plan.remoteModified"),
            local,
            remote,
            manifest
          });
        } else {
          // Both changed: check if plaintext edits converged to identical content
          if (isPlaintextIdentical(local, remote, enableE2EE)) {
            plans.push({
              path,
              remotePath,
              action: "UPDATE_MANIFEST",
              reason: t("plan.identicalBaseline"),
              local,
              remote,
              manifest
            });
            continue;
          }

          const winner: "local" | "remote" = local.mtime >= remote.mtime ? "local" : "remote";
          if (conflictStrategy === "copy") {
            plans.push({
              path,
              remotePath,
              action: "CONFLICT",
              winner,
              reason: t("plan.bothModifiedConflict"),
              local,
              remote,
              manifest
            });
          } else if (winner === "local") {
            plans.push({
              path,
              remotePath,
              action: "UPLOAD",
              reason: t("plan.bothModifiedLocalNewer"),
              local,
              remote,
              manifest
            });
          } else {
            plans.push({
              path,
              remotePath,
              action: "DOWNLOAD",
              reason: t("plan.bothModifiedRemoteNewer"),
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
            reason: t("plan.localAdded"),
            local
          });
        } else {
          // Remote was deleted
          const localChanged =
            Math.abs(local.mtime - manifest.mtime) > 1000 || local.size !== manifest.size;
          if (localChanged) {
            plans.push({
              path,
              remotePath,
              action: "UPLOAD",
              reason: t("plan.remoteDeletedLocalModified"),
              local,
              manifest
            });
          } else {
            plans.push({
              path,
              remotePath,
              action: "DELETE_LOCAL",
              reason: t("plan.remoteDeleted"),
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
            reason: t("plan.remoteAdded"),
            remote
          });
        } else {
          // Local was deleted
          const expectedRemoteSize =
            manifest.remoteSize !== undefined ? manifest.remoteSize : manifest.size;
          const fsIdChanged =
            Boolean(manifest.fsId) &&
            Boolean(remote.fsId) &&
            String(remote.fsId) !== String(manifest.fsId);
          const remoteChanged =
            Math.abs(remote.mtime - manifest.remoteMtime) > 1000 ||
            remote.size !== expectedRemoteSize ||
            fsIdChanged;
          if (remoteChanged) {
            plans.push({
              path,
              remotePath,
              action: "DOWNLOAD",
              reason: t("plan.localDeletedRemoteModified"),
              remote,
              manifest
            });
          } else {
            plans.push({
              path,
              remotePath,
              action: "DELETE_REMOTE",
              reason: t("plan.localDeleted"),
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
          reason: t("plan.cleanManifest"),
          manifest
        });
      }
    }

    return plans;
  }
}
