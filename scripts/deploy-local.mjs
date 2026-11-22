#!/usr/bin/env node

/**
 * Local Obsidian Test Vault Deployer
 * Builds (if requested or missing) and copies plugin release artifacts
 * (main.js, manifest.json, styles.css) into the isolated local test Vault,
 * then triggers `obsidian plugin:reload` when the test vault is open.
 *
 * Safety invariants:
 * - Never touches data.json or sync_manifest.json.
 * - Refuses to target production vaults or unconfigured vault paths.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, "..");
const PLUGIN_ID = "baidu-netdisk-sync";
const FORBIDDEN_VAULT_NAMES = new Set(["markdown", "main", "prod", "production"]);
const FORBIDDEN_REMOTE_BASES = new Set(["", "/", "/apps", "/apps/obsidian_vault"]);

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m"
};

function loadEnv() {
  const envPath = resolve(rootDir, ".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

function normalizeRemote(p) {
  if (!p || typeof p !== "string") return "";
  const t = p.trim();
  if (!t || t === "/") return "/";
  return t.replace(/\/+$/, "");
}

function getArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  const prefixed = process.argv.find((a) => a.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : undefined;
}

function runObsidianCli(args) {
  return execFileSync("obsidian", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000
  }).trim();
}

function main() {
  loadEnv();

  const shouldBuild = process.argv.includes("--build");
  const shouldInit = process.argv.includes("--init");
  const noReload = process.argv.includes("--no-reload");

  const vaultName = (getArgValue("--vault-name") || process.env.OBS_TEST_VAULT_NAME || "").trim();
  const vaultPathRaw = (getArgValue("--vault-path") || process.env.OBS_TEST_VAULT_PATH || "").trim();

  if (!vaultName || !vaultPathRaw) {
    console.error(`${colors.red}❌ Missing OBS_TEST_VAULT_NAME or OBS_TEST_VAULT_PATH.${colors.reset}`);
    console.error(`Please configure both in .env (refer to .env.example).`);
    process.exit(1);
  }

  const vaultPath = resolve(vaultPathRaw);
  const vaultBase = basename(vaultPath).toLowerCase();

  if (FORBIDDEN_VAULT_NAMES.has(vaultName.toLowerCase()) || FORBIDDEN_VAULT_NAMES.has(vaultBase)) {
    console.error(
      `${colors.red}🛑 Safety Abort: Refusing to deploy into protected/production vault "${vaultName}" (${vaultPath}).${colors.reset}`
    );
    process.exit(1);
  }

  if (!existsSync(vaultPath)) {
    if (!shouldInit) {
      console.error(`${colors.red}❌ Test vault directory does not exist: ${vaultPath}${colors.reset}`);
      console.error(`Re-run with --init to scaffold a clean isolated test vault directory.`);
      process.exit(1);
    }
    mkdirSync(vaultPath, { recursive: true });
    console.log(`${colors.cyan}📁 Created isolated test vault directory: ${vaultPath}${colors.reset}`);
  }

  // Build if requested or main.js is missing
  const mainJsPath = resolve(rootDir, "main.js");
  if (shouldBuild || !existsSync(mainJsPath)) {
    console.log(`${colors.cyan}🔨 Running production build (npm run build)...${colors.reset}`);
    execFileSync("npm", ["run", "build"], { cwd: rootDir, stdio: "inherit" });
  }

  const artifacts = ["main.js", "manifest.json", "styles.css"];
  for (const file of artifacts) {
    const src = resolve(rootDir, file);
    if (!existsSync(src)) {
      console.error(`${colors.red}❌ Missing build artifact: ${src}${colors.reset}`);
      process.exit(1);
    }
  }

  const obsidianDir = resolve(vaultPath, ".obsidian");
  const pluginDir = resolve(obsidianDir, "plugins", PLUGIN_ID);
  mkdirSync(pluginDir, { recursive: true });

  // Safety check on existing data.json (warn loudly if pointing to production remoteBasePath)
  const dataJsonPath = resolve(pluginDir, "data.json");
  if (existsSync(dataJsonPath)) {
    try {
      const existingData = JSON.parse(readFileSync(dataJsonPath, "utf-8"));
      const normalizedRemote = normalizeRemote(existingData?.remoteBasePath);
      if (existingData?.accessToken && FORBIDDEN_REMOTE_BASES.has(normalizedRemote)) {
        console.warn(
          `${colors.yellow}⚠️  WARNING: ${dataJsonPath} currently has remoteBasePath="${normalizedRemote}".${colors.reset}`
        );
        console.warn(
          `${colors.yellow}   Change it to your isolated test directory (e.g. ${process.env.BAIDU_E2E_REMOTE_BASE || "/apps/obsidian_vault_e2e_test"}) before syncing or running test:obsidian!${colors.reset}`
        );
      }
    } catch {
      // ignore malformed data.json during deploy
    }
  }

  // Scaffold minimal Obsidian config files when missing
  const communityPluginsPath = resolve(obsidianDir, "community-plugins.json");
  let enabledPlugins = [];
  if (existsSync(communityPluginsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(communityPluginsPath, "utf-8"));
      if (Array.isArray(parsed)) enabledPlugins = parsed;
    } catch {
      enabledPlugins = [];
    }
  }
  if (!enabledPlugins.includes(PLUGIN_ID)) {
    enabledPlugins.push(PLUGIN_ID);
    writeFileSync(communityPluginsPath, JSON.stringify(enabledPlugins, null, 2) + "\n", "utf-8");
  }

  const appJsonPath = resolve(obsidianDir, "app.json");
  if (!existsSync(appJsonPath)) {
    writeFileSync(appJsonPath, JSON.stringify({ trashOption: "local" }, null, 2) + "\n", "utf-8");
  }

  // Copy release artifacts
  for (const file of artifacts) {
    copyFileSync(resolve(rootDir, file), resolve(pluginDir, file));
  }

  const manifest = JSON.parse(readFileSync(resolve(rootDir, "manifest.json"), "utf-8"));
  console.log(
    `${colors.green}✅ Deployed ${PLUGIN_ID} v${manifest.version} -> ${pluginDir}${colors.reset}`
  );
  console.log(`${colors.dim}   Files copied: ${artifacts.join(", ")}${colors.reset}`);

  if (noReload) {
    return;
  }

  // Attempt Obsidian CLI hot-reload if the test vault is registered & open
  try {
    const vaultsOut = runObsidianCli(["vaults", "verbose"]);
    const registered = vaultsOut
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [name, ...rest] = l.split("\t");
        return { name: name?.trim(), path: rest.join("\t").trim() };
      });

    const match = registered.find((v) => v.name === vaultName && resolve(v.path) === vaultPath);
    if (!match) {
      console.log(
        `${colors.yellow}ℹ️  Test vault "${vaultName}" is not yet registered/open in Obsidian.${colors.reset}`
      );
      console.log(
        `${colors.dim}   Open "${vaultPath}" in Obsidian (Open folder as vault), then re-run or execute npm run test:obsidian.${colors.reset}`
      );
      return;
    }

    const reloadOut = runObsidianCli([`vault=${vaultName}`, "plugin:reload", `id=${PLUGIN_ID}`]);
    console.log(
      `${colors.green}🔄 Reloaded ${PLUGIN_ID} in Obsidian vault "${vaultName}"${reloadOut ? `: ${reloadOut}` : ""}${colors.reset}`
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    console.log(
      `${colors.yellow}ℹ️  Skipped automatic Obsidian reload (${detail}). Ensure Obsidian is running with vault "${vaultName}" open.${colors.reset}`
    );
  }
}

main();
