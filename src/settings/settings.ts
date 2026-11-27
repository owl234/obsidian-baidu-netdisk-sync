export type ConflictStrategy = "copy" | "lww";

export interface BaiduSyncSettings {
  appKey: string;
  appSecret: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number; // Unix timestamp in ms
  remoteBasePath: string; // e.g. "/apps/obsidian_vault"

  // Conflict resolution
  conflictStrategy: ConflictStrategy;

  // Sync triggers
  syncOnStartup: boolean;
  syncIntervalMinutes: number; // 0 disables periodic sync
  syncOnSave: boolean;
  syncDebounceSeconds: number;

  // Sync scope
  syncObsidianConfig: boolean;
  syncPlugins: boolean;
  syncThemes: boolean;
  ignoredPatterns: string; // Newline separated global patterns (included in device pairing)
  localIgnoredPatterns: string; // Newline separated device-only patterns (never exported/overwritten)

  // Concurrency and network safety
  concurrency: number; // 1 to 5, default 3
  maxFileSizeMB: number; // 0 disables size limit, default 100
  staleSyncThresholdDays: number; // 0 disables stale-device guard, default 30

  // Local device identity (never exported/overwritten during pairing)
  deviceId: string;

  // E2EE
  enableE2EE: boolean;
  e2eePassword: string;

  // Status
  lastSyncTime: number;
}

export const DEFAULT_SETTINGS: BaiduSyncSettings = {
  appKey: "",
  appSecret: "",
  accessToken: "",
  refreshToken: "",
  tokenExpiresAt: 0,
  remoteBasePath: "/apps/obsidian_vault",

  conflictStrategy: "copy",

  syncOnStartup: true,
  syncIntervalMinutes: 10,
  syncOnSave: false,
  syncDebounceSeconds: 5,

  syncObsidianConfig: true,
  syncPlugins: true,
  syncThemes: true,
  ignoredPatterns: [
    "**/.git/**",
    "**/.DS_Store",
    "**/Thumbs.db",
    "**/workspace*.json",
    "**/cache/**",
    "**/indexeddb/**"
  ].join("\n"),
  localIgnoredPatterns: "",

  concurrency: 3,
  maxFileSizeMB: 100,
  staleSyncThresholdDays: 30,

  deviceId: "",

  enableE2EE: false,
  e2eePassword: "",

  lastSyncTime: 0
};
