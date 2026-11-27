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
  return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").normalize("NFC");
}

export function normalizeCanonicalPath(p: string): string {
  return normalizePath(p);
}

function isUnderDir(normalized: string, dir: string): boolean {
  if (!dir) return false;
  return normalized === dir || normalized.startsWith(`${dir}/`);
}

interface CompiledIgnoreRule {
  regex: RegExp;
  dirOnly: boolean;
  /**
   * When a glob ends with `/**` (e.g. `**\/attachments/**`), `dirPruneRegex` matches
   * the directory prefix itself (`**\/attachments`) so local scan can prune the folder
   * without descending while remaining 100% symmetric with remote file-level matching.
   */
  dirPruneRegex?: RegExp;
}

export class SyncFilter {
  private compiledRules: CompiledIgnoreRule[] = [];
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
    this.compiledRules = [];
    const combined = `${this.settings.ignoredPatterns || ""}\n${this.settings.localIgnoredPatterns || ""}`;
    const lines = combined.split("\n");
    for (const line of lines) {
      const trimmed = line.trim().replace(/\\/g, "/").replace(/^\/+/, "").normalize("NFC");
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      try {
        if (trimmed.endsWith("/")) {
          const stripped = trimmed.replace(/\/+$/, "");
          if (stripped) {
            this.compiledRules.push({
              regex: globToRegex(stripped),
              dirOnly: true
            });
          }
        } else if (trimmed.endsWith("/**")) {
          const prefix = trimmed.slice(0, -3).replace(/\/+$/, "");
          this.compiledRules.push({
            regex: globToRegex(trimmed),
            dirOnly: false,
            dirPruneRegex: prefix ? globToRegex(prefix) : undefined
          });
        } else {
          this.compiledRules.push({
            regex: globToRegex(trimmed),
            dirOnly: false
          });
        }
      } catch {
        // ignore invalid patterns
      }
    }
  }

  /**
   * Determines whether a relative vault/remote path should be excluded from sync.
   *
   * Uses .gitignore-style ancestor inheritance: if any strict ancestor directory matches
   * an ignore rule (whether `Private`, `Private/`, `**\/temp`, or `**\/attachments/**`),
   * all descendant files are guaranteed to be ignored as well. This guarantees exact
   * mathematical symmetry between local folder pruning (`isDir = true`) and remote
   * file-level filtering (`isDir = false`).
   */
  shouldIgnore(relativePath: string, isDir = false): boolean {
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
    if (
      normalized === "sync_manifest.json" ||
      normalized.endsWith("/sync_manifest.json") ||
      normalized === "sync_manifest.json.bak" ||
      normalized.endsWith("/sync_manifest.json.bak") ||
      normalized === "tombstone_cache.json" ||
      normalized.endsWith("/tombstone_cache.json") ||
      normalized === "tombstone_cache.json.bak" ||
      normalized.endsWith("/tombstone_cache.json.bak")
    ) {
      return true;
    }

    // Always ignore plugin cloud metadata staging folder & Obsidian trash folder
    if (isUnderDir(normalized, ".bdsync-meta") || isUnderDir(normalized, ".trash")) {
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

    // Precompute strict ancestor directory prefixes once for ancestor inheritance
    const ancestors: string[] = [];
    let slashIdx = normalized.indexOf("/");
    while (slashIdx !== -1) {
      ancestors.push(normalized.slice(0, slashIdx));
      slashIdx = normalized.indexOf("/", slashIdx + 1);
    }

    // Check user-configured rules with full ancestor inheritance
    for (const rule of this.compiledRules) {
      if (isDir) {
        if (rule.regex.test(normalized) || (rule.dirPruneRegex && rule.dirPruneRegex.test(normalized))) {
          return true;
        }
      } else {
        if (!rule.dirOnly && rule.regex.test(normalized)) {
          return true;
        }
      }

      for (const ancestor of ancestors) {
        if (rule.regex.test(ancestor) || (rule.dirPruneRegex && rule.dirPruneRegex.test(ancestor))) {
          return true;
        }
      }
    }

    return false;
  }
}
