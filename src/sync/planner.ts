import { ManifestItem } from "./manifest";
import { TombstoneEntry } from "./tombstone";
import { ConflictStrategy } from "../settings/settings";
import { t } from "../i18n";

export type SyncActionType =
  | "UPLOAD"
  | "DOWNLOAD"
  | "CONFLICT"
  | "DELETE_CONFLICT"
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
  tombstoneVerified?: boolean;
  local?: LocalFileInfo;
  remote?: RemoteFileInfo;
  manifest?: ManifestItem;
  tombstone?: TombstoneEntry;
}

export interface SyncPlanOptions {
  conflictStrategy?: ConflictStrategy;
  enableE2EE?: boolean;
  tombstones?: Map<string, TombstoneEntry>;
  currentDeviceId?: string;
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

export function getBaselinePlainMd5(manifest: ManifestItem, enableE2EE: boolean): string | undefined {
  if (manifest.localMd5) {
    return manifest.localMd5.toLowerCase();
  }
  if (!enableE2EE && manifest.md5) {
    return manifest.md5.toLowerCase();
  }
  return undefined;
}

function isLocalUnchangedAgainstManifest(
  local: LocalFileInfo,
  manifest: ManifestItem,
  enableE2EE: boolean
): boolean {
  if (local.size !== manifest.size) {
    return false;
  }
  if (Math.abs(local.mtime - manifest.mtime) <= 1000) {
    return true;
  }
  const baselineMd5 = getBaselinePlainMd5(manifest, enableE2EE);
  if (baselineMd5 && local.md5) {
    return local.md5.toLowerCase() === baselineMd5;
  }
  return false;
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
    const tombstones = options.tombstones;
    const currentDeviceId = options.currentDeviceId;

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
        const localChanged = !isLocalUnchangedAgainstManifest(local, manifest, enableE2EE);
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
        const tombstone = tombstones?.get(path);
        const hashMatchesTombstone = Boolean(
          tombstone?.deletedHash &&
            local.md5 &&
            local.md5.toLowerCase() === tombstone.deletedHash.toLowerCase()
        );
        const isSameDeviceRestore = Boolean(
          tombstone &&
            currentDeviceId &&
            tombstone.deviceId === currentDeviceId &&
            local.mtime > tombstone.deletedAt + 1000
        );

        if (!manifest) {
          if (tombstone && !isSameDeviceRestore) {
            if (hashMatchesTombstone) {
              plans.push({
                path,
                remotePath,
                action: "DELETE_LOCAL",
                tombstoneVerified: true,
                reason: t("plan.remoteTombstoneMatched"),
                local,
                tombstone
              });
            } else if (local.mtime <= tombstone.deletedAt + 1000) {
              plans.push({
                path,
                remotePath,
                action: "DELETE_LOCAL",
                tombstoneVerified: true,
                reason: t("plan.remoteTombstoneOlderLocal"),
                local,
                tombstone
              });
            } else {
              plans.push({
                path,
                remotePath,
                action: "UPLOAD",
                reason: t("plan.recreatedAfterDelete"),
                local,
                tombstone
              });
            }
          } else if (tombstone && isSameDeviceRestore) {
            plans.push({
              path,
              remotePath,
              action: "UPLOAD",
              reason: t("plan.recreatedAfterDelete"),
              local,
              tombstone
            });
          } else {
            plans.push({
              path,
              remotePath,
              action: "UPLOAD",
              reason: t("plan.localAdded"),
              local
            });
          }
        } else {
          // Remote was deleted while this device still had a baseline entry
          const localUnchanged = isLocalUnchangedAgainstManifest(local, manifest, enableE2EE);
          if (localUnchanged) {
            plans.push({
              path,
              remotePath,
              action: "DELETE_LOCAL",
              tombstoneVerified: Boolean(tombstone),
              reason: tombstone ? t("plan.remoteTombstoneMatched") : t("plan.remoteDeleted"),
              local,
              manifest,
              tombstone
            });
          } else if (hashMatchesTombstone && !isSameDeviceRestore) {
            // Even if local manifest lagged behind disk (e.g. external copy), local content matches the exact deleted version
            plans.push({
              path,
              remotePath,
              action: "DELETE_LOCAL",
              tombstoneVerified: true,
              reason: t("plan.remoteTombstoneMatched"),
              local,
              manifest,
              tombstone
            });
          } else if (conflictStrategy === "copy") {
            plans.push({
              path,
              remotePath,
              action: "DELETE_CONFLICT",
              tombstoneVerified: Boolean(tombstone),
              reason: t("plan.remoteDeletedLocalModifiedConflict"),
              local,
              manifest,
              tombstone
            });
          } else if (tombstone && local.mtime <= tombstone.deletedAt + 1000) {
            plans.push({
              path,
              remotePath,
              action: "DELETE_LOCAL",
              tombstoneVerified: true,
              reason: t("plan.remoteDeletedLww"),
              local,
              manifest,
              tombstone
            });
          } else {
            plans.push({
              path,
              remotePath,
              action: "UPLOAD",
              reason: t("plan.remoteDeletedLocalModified"),
              local,
              manifest,
              tombstone
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
