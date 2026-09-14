export interface BaiduSyncSettings {
  appKey: string;
  appSecret: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number; // Unix timestamp in ms
  remoteBasePath: string;  // e.g. "/apps/obsidian_vault"

  // Sync triggers
  syncOnStartup: boolean;
  syncIntervalMinutes: number; // 0 disables periodic sync
  syncOnSave: boolean;
  syncDebounceSeconds: number;

  // Sync Scope
  syncObsidianConfig: boolean;
  syncPlugins: boolean;
  syncThemes: boolean;
  ignoredPatterns: string; // Newline separated patterns

  // Concurrency and Network
  concurrency: number; // 1 to 5, default 3

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
    "**/.obsidian/workspace*.json",
    "**/.obsidian/cache/**",
    "**/.obsidian/indexeddb/**"
  ].join("\n"),

  concurrency: 3,

  enableE2EE: false,
  e2eePassword: "",

  lastSyncTime: 0
};
