import { BaiduSyncSettings } from "../settings/settings";

function globToRegex(glob: string): RegExp {
  const clean = glob.trim();
  let regexStr = "^";
  let i = 0;
  while (i < clean.length) {
    const c = clean[i];
    if (c === "*" && clean[i + 1] === "*") {
      regexStr += ".*";
      i += 2;
      if (clean[i] === "/") {
        i++;
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

export class SyncFilter {
  private compiledPatterns: RegExp[] = [];

  constructor(private settings: BaiduSyncSettings) {
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
        } catch (e) {
          console.warn("[BaiduSync] 忽略无效过滤规则:", trimmed, e);
        }
      }
    }
  }

  shouldIgnore(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, "/");

    // Always ignore plugin's own manifest and storage
    if (
      normalized.includes("baidu-netdisk-sync") ||
      normalized.includes("obsidian-baidu-netdisk-sync") ||
      normalized.endsWith("sync_manifest.json")
    ) {
      return true;
    }

    // Always ignore Obsidian trash folder
    if (normalized.startsWith(".trash/") || normalized === ".trash") {
      return true;
    }

    // Git metadata
    if (normalized.startsWith(".git/") || normalized.includes("/.git/")) {
      return true;
    }

    // Handle .obsidian folder configuration rules
    if (normalized.startsWith(".obsidian/")) {
      if (!this.settings.syncObsidianConfig) {
        return true;
      }

      // Hard-ignore device specific workspaces and cache
      if (
        normalized.includes("/workspace.json") ||
        normalized.includes("/workspace-mobile.json") ||
        normalized.startsWith(".obsidian/workspace.json") ||
        normalized.startsWith(".obsidian/workspace-mobile.json") ||
        normalized.startsWith(".obsidian/cache/") ||
        normalized.startsWith(".obsidian/indexeddb/")
      ) {
        return true;
      }

      // Plugins rule
      if (!this.settings.syncPlugins && normalized.startsWith(".obsidian/plugins/")) {
        return true;
      }

      // Themes rule
      if (!this.settings.syncThemes && normalized.startsWith(".obsidian/themes/")) {
        return true;
      }
    }

    // Check custom patterns
    for (const pattern of this.compiledPatterns) {
      if (pattern.test(normalized)) {
        return true;
      }
    }

    return false;
  }
}
