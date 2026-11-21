import { BaiduSyncSettings } from "../settings/settings";

export function globToRegex(glob: string): RegExp {
  const clean = glob.trim().replace(/\\/g, "/");
  let regexStr = "^";
  let i = 0;
  while (i < clean.length) {
    const c = clean[i];
    if (c === "*" && clean[i + 1] === "*") {
      if (clean[i + 2] === "/") {
        // "**/foo" matches "foo" at root as well as "a/b/foo" (on a path segment boundary)
        regexStr += "(?:^|.*/)";
        i += 3;
      } else if (i > 0 && clean[i - 1] === "/" && i + 2 === clean.length) {
        // "dir/**" matches everything inside dir
        regexStr += ".*";
        i += 2;
      } else {
        regexStr += ".*";
        i += 2;
      }
    } else if (c === "*") {
      regexStr += "[^/]*";
      i++;
    } else if (c === "?") {
      regexStr += "[^/]";
      i++;
    } else if (".+^$()|{}[]\\".includes(c)) {
      regexStr += "\\" + c;
      i++;
    } else {
      regexStr += c;
      i++;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function isUnderDir(normalized: string, dir: string): boolean {
  if (!dir) return false;
  return normalized === dir || normalized.startsWith(`${dir}/`);
}

export class SyncFilter {
  private compiledPatterns: RegExp[] = [];
  private cleanConfigDir: string;
  private cleanPluginDirs: string[];

  constructor(
    private settings: BaiduSyncSettings,
    configDir: string = "",
    pluginDir: string = ""
  ) {
    this.cleanConfigDir = normalizePath(configDir);
    const dirs = new Set<string>();
    if (pluginDir) {
      dirs.add(normalizePath(pluginDir));
    }
    if (this.cleanConfigDir) {
      dirs.add(`${this.cleanConfigDir}/plugins/baidu-netdisk-sync`);
      dirs.add(`${this.cleanConfigDir}/plugins/obsidian-baidu-netdisk-sync`);
    }
    this.cleanPluginDirs = Array.from(dirs);
    this.recompilePatterns();
  }

  updateSettings(settings: BaiduSyncSettings): void {
    this.settings = settings;
    this.recompilePatterns();
  }

  private recompilePatterns(): void {
    this.compiledPatterns = [];
    const lines = this.settings.ignoredPatterns.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        try {
          this.compiledPatterns.push(globToRegex(trimmed));
        } catch {
          // ignore invalid patterns
        }
      }
    }
  }

  shouldIgnore(relativePath: string): boolean {
    const normalized = normalizePath(relativePath);
    if (!normalized) {
      return false;
    }

    // Always ignore this plugin's own directory (data.json with secrets & sync_manifest.json)
    // without accidentally excluding regular user notes mentioning the plugin name
    for (const pluginDir of this.cleanPluginDirs) {
      if (isUnderDir(normalized, pluginDir)) {
        return true;
      }
    }
    if (
      normalized.includes("/plugins/baidu-netdisk-sync/") ||
      normalized.endsWith("/plugins/baidu-netdisk-sync") ||
      normalized.includes("/plugins/obsidian-baidu-netdisk-sync/") ||
      normalized.endsWith("/plugins/obsidian-baidu-netdisk-sync")
    ) {
      return true;
    }
    if (normalized === "sync_manifest.json" || normalized.endsWith("/sync_manifest.json")) {
      return true;
    }

    // Always ignore Obsidian trash folder
    if (isUnderDir(normalized, ".trash")) {
      return true;
    }

    // Always ignore Git metadata folders
    if (
      normalized === ".git" ||
      normalized.startsWith(".git/") ||
      normalized.includes("/.git/") ||
      normalized.endsWith("/.git")
    ) {
      return true;
    }

    // Handle Obsidian config directory rules (both folder-level pruning and files inside)
    if (this.cleanConfigDir && isUnderDir(normalized, this.cleanConfigDir)) {
      if (!this.settings.syncObsidianConfig) {
        return true;
      }

      if (normalized === this.cleanConfigDir) {
        return false;
      }

      const subPath = normalized.slice(this.cleanConfigDir.length + 1);

      // Hard-ignore device-specific workspaces and transient caches
      if (
        subPath === "workspace.json" ||
        subPath === "workspace-mobile.json" ||
        isUnderDir(subPath, "cache") ||
        isUnderDir(subPath, "indexeddb")
      ) {
        return true;
      }

      // Plugins rule
      if (!this.settings.syncPlugins && isUnderDir(subPath, "plugins")) {
        return true;
      }

      // Themes & CSS snippets rule
      if (
        !this.settings.syncThemes &&
        (isUnderDir(subPath, "themes") || isUnderDir(subPath, "snippets"))
      ) {
        return true;
      }
    }

    // Check user-configured glob patterns
    for (const pattern of this.compiledPatterns) {
      if (pattern.test(normalized)) {
        return true;
      }
    }

    return false;
  }
}
