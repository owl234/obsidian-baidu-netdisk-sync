#!/usr/bin/env node

/**
 * Local Obsidian Full 9-Domain Real-Baidu E2E Business Test Suite
 *
 * Drives the running local Obsidian instance via `obsidian` CLI against an
 * isolated test Vault and an isolated Baidu Netdisk test directory.
 *
 * Safety & Security Invariants:
 * 1. Hard-aborts if target vault is production (e.g. `markdown`) or unregistered.
 * 2. Hard-aborts if `BAIDU_E2E_REMOTE_BASE` or `plugin.settings.remoteBasePath`
 *    is missing, root `/`, `/apps`, `/apps/obsidian_vault`, or mismatched.
 * 3. Never reads production vault files and never writes tokens/secrets to disk
 *    or gitignored reports.
 * 4. Always restores test vault settings (preserving rotated OAuth tokens),
 *    disables mobile emulation, and cleans up local & remote run artifacts in finally.
 *
 * Usage:
 *   npm run test:obsidian
 *   npm run test:obsidian -- --keep-artifacts   # Keep local/remote test files for debugging
 *   npm run test:obsidian -- --skip-deploy      # Skip automatic deploy:local before running
 *   npm run test:obsidian -- --cleanup-only     # Purge ALL residual local/remote/clipboard/report traces
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  cyan: "\x1b[36m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m"
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

function makeRunId() {
  const d = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function obsidianCli(vaultName, args, timeoutMs = 120000) {
  const fullArgs = vaultName ? [`vault=${vaultName}`, ...args] : args;
  return execFileSync("obsidian", fullArgs, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 25 * 1024 * 1024,
    timeout: timeoutMs
  }).trim();
}

/**
 * Executes an async JavaScript body inside Obsidian's renderer for the target vault
 * and parses its JSON return value. Any thrown error is captured and rethrown with details.
 */
function obsidianEvalJson(vaultName, bodyCode, timeoutMs = 180000) {
  const wrapped = `
try {
  const __res = await (async () => {
${bodyCode}
  })();
  return JSON.stringify({ __ok: true, value: __res ?? null });
} catch (err) {
  return JSON.stringify({
    __ok: false,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : ""
  });
}
`.trim();

  const raw = obsidianCli(vaultName, ["eval", `code=${wrapped}`], timeoutMs);
  const cleaned = raw.startsWith("=> ") ? raw.slice(3).trim() : raw.trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Unexpected obsidian eval output: ${raw.slice(0, 400)}`);
  }

  if (!parsed.__ok) {
    const err = new Error(parsed.message || "Unknown error inside Obsidian eval");
    if (parsed.stack) {
      err.remoteStack = parsed.stack;
    }
    throw err;
  }
  return parsed.value;
}

/**
 * Shared JS helper prelude injected into eval blocks for real Baidu remote operations
 * (simulating a second device using only public BaiduClient methods + Node crypto).
 */
const REMOTE_HELPER_JS = `
const nodeCrypto = require("crypto");
function sha256Hex(buf) {
  return nodeCrypto.createHash("sha256").update(Buffer.from(buf)).digest("hex");
}
function md5Hex(buf) {
  return nodeCrypto.createHash("md5").update(Buffer.from(buf)).digest("hex");
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function remoteUploadPlain(plugin, remotePath, data) {
  const buf = typeof data === "string"
    ? new TextEncoder().encode(data).slice().buffer
    : data;
  const CHUNK = 4 * 1024 * 1024;
  const totalSize = buf.byteLength;
  const totalParts = Math.max(1, Math.ceil(totalSize / CHUNK));
  const blockList = [];
  for (let i = 0; i < totalParts; i++) {
    const start = i * CHUNK;
    const end = Math.min(start + CHUNK, totalSize);
    blockList.push(md5Hex(new Uint8Array(buf, start, end - start)));
  }
  const rapidHashes = totalSize > 0 ? {
    contentMd5: totalParts === 1 ? blockList[0] : md5Hex(new Uint8Array(buf)),
    sliceMd5: md5Hex(new Uint8Array(buf, 0, Math.min(256 * 1024, totalSize)))
  } : undefined;
  const pre = await plugin.client.precreate(remotePath, totalSize, blockList, rapidHashes);
  if (pre.return_type === 2 && pre.info) {
    return pre.info;
  }
  const needed = Array.isArray(pre.block_list) ? pre.block_list : [];
  for (const partseq of needed) {
    const start = partseq * CHUNK;
    const end = Math.min(start + CHUNK, totalSize);
    await plugin.client.uploadSlice(remotePath, pre.uploadid, partseq, buf.slice(start, end));
  }
  return await plugin.client.createFile(remotePath, totalSize, pre.uploadid, blockList);
}
async function remoteDownloadRaw(plugin, remoteBase, relPath) {
  const items = await plugin.client.listAll(remoteBase);
  const fullPath = remoteBase + "/" + relPath;
  const item = items.find((it) => it.path === fullPath && it.isdir !== 1);
  if (!item) throw new Error("Remote file not found: " + fullPath);
  const meta = await plugin.client.getFileMeta(item.fs_id);
  if (!meta.dlink) throw new Error("Missing dlink for: " + fullPath);
  return await plugin.client.downloadFile(meta.dlink);
}
async function ensureLocalDir(path) {
  const parts = path.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur = cur ? cur + "/" + p : p;
    if (!(await app.vault.adapter.exists(cur))) {
      await app.vault.adapter.mkdir(cur);
    }
  }
}
async function writeLocalText(filePath, text) {
  const slash = filePath.lastIndexOf("/");
  if (slash > 0) await ensureLocalDir(filePath.slice(0, slash));
  await app.vault.adapter.write(filePath, text);
}
async function writeLocalBinary(filePath, buf) {
  const slash = filePath.lastIndexOf("/");
  if (slash > 0) await ensureLocalDir(filePath.slice(0, slash));
  await app.vault.adapter.writeBinary(filePath, buf);
}
async function removeLocalPath(p) {
  if (await app.vault.adapter.exists(p)) {
    const st = await app.vault.adapter.stat(p);
    if (st && st.type === "folder") {
      await app.vault.adapter.rmdir(p, true);
    } else {
      await app.vault.adapter.remove(p);
    }
  }
}
function closeAllModalsAndSettings() {
  for (const btn of Array.from(document.querySelectorAll(".modal-close-button"))) {
    btn.click();
  }
  if (app.setting && app.setting.activeTab) {
    app.setting.close();
  }
}
function getPlugin() {
  const p = app.plugins.getPlugin("${PLUGIN_ID}");
  if (!p) throw new Error("Plugin ${PLUGIN_ID} is not loaded!");
  return p;
}
function assertTrue(cond, msg) {
  if (!cond) throw new Error("Assertion failed: " + msg);
}
`;

function sanitizeText(str, secrets) {
  let out = String(str ?? "");
  for (const secret of secrets) {
    if (secret && secret.length >= 6) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  return out;
}

function captureScreenshot(vaultName, outPath) {
  try {
    obsidianCli(vaultName, ["dev:screenshot", `path=${outPath}`], 30000);
    return existsSync(outPath) ? outPath : null;
  } catch {
    return null;
  }
}

/**
 * Clears the macOS system clipboard if it still holds a temporary E2E pairing code
 * (`BDSYNC:v1:...`) written by ExportConfigModal during D7.
 */
function clearPairingClipboardIfNeeded() {
  if (process.platform !== "darwin") {
    return { checked: false, cleared: false };
  }
  try {
    const current = execFileSync("pbpaste", [], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000
    }).trim();
    if (current.startsWith("BDSYNC:v1:")) {
      execFileSync("pbcopy", [], {
        input: "",
        encoding: "utf-8",
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 5000
      });
      return { checked: true, cleared: true };
    }
    return { checked: true, cleared: false };
  } catch {
    return { checked: false, cleared: false };
  }
}

/**
 * Removes temporary E2E report directories and compiled unit test bundle from dist/.
 */
function cleanWorkspaceTestArtifacts() {
  const removed = [];
  for (const rel of ["dist/e2e-reports", "dist/test.js"]) {
    const abs = resolve(rootDir, rel);
    if (existsSync(abs)) {
      rmSync(abs, { recursive: true, force: true });
      removed.push(rel);
    }
  }
  return removed;
}

async function main() {
  loadEnv();

  const keepArtifacts = process.argv.includes("--keep-artifacts");
  const skipDeploy = process.argv.includes("--skip-deploy");
  const cleanupOnly = process.argv.includes("--cleanup-only");

  const vaultName = (process.env.OBS_TEST_VAULT_NAME || "").trim();
  const vaultPathRaw = (process.env.OBS_TEST_VAULT_PATH || "").trim();
  const remoteBaseRaw = (process.env.BAIDU_E2E_REMOTE_BASE || "").trim();

  // ── 0. Hard Environment & Safety Preflight ───────────────────────────────
  if (!vaultName || !vaultPathRaw || !remoteBaseRaw) {
    console.error(
      `${colors.red}❌ Missing required E2E env vars: OBS_TEST_VAULT_NAME, OBS_TEST_VAULT_PATH, BAIDU_E2E_REMOTE_BASE.${colors.reset}`
    );
    console.error(`Please configure them in .env (refer to .env.example).`);
    process.exit(1);
  }

  const vaultPath = resolve(vaultPathRaw);
  const vaultBase = basename(vaultPath).toLowerCase();
  const allowedRemoteBase = normalizeRemote(remoteBaseRaw);

  if (FORBIDDEN_VAULT_NAMES.has(vaultName.toLowerCase()) || FORBIDDEN_VAULT_NAMES.has(vaultBase)) {
    console.error(
      `${colors.red}🛑 SAFETY ABORT: Vault "${vaultName}" (${vaultPath}) looks like a production vault.${colors.reset}`
    );
    process.exit(1);
  }

  if (
    FORBIDDEN_REMOTE_BASES.has(allowedRemoteBase) ||
    !allowedRemoteBase.startsWith("/apps/") ||
    !/(test|e2e|sandbox|dev)/i.test(allowedRemoteBase)
  ) {
    console.error(
      `${colors.red}🛑 SAFETY ABORT: BAIDU_E2E_REMOTE_BASE="${allowedRemoteBase}" must be under /apps/ and explicitly contain test/e2e/sandbox/dev (NEVER /apps/obsidian_vault).${colors.reset}`
    );
    process.exit(1);
  }

  // ── Optional Mode: --cleanup-only (Purge ALL residual traces) ────────────
  if (cleanupOnly) {
    console.log(`${colors.cyan}${colors.bold}🧹 Running Zero-Trace E2E Cleanup...${colors.reset}`);
    const clipRes = clearPairingClipboardIfNeeded();
    const removedLocalReports = cleanWorkspaceTestArtifacts();
    console.log(
      `${colors.dim}   Workspace artifacts removed : ${removedLocalReports.length > 0 ? removedLocalReports.join(", ") : "(none)"}${colors.reset}`
    );
    console.log(
      `${colors.dim}   Clipboard pairing code      : ${clipRes.cleared ? "cleared" : "clean"}${colors.reset}`
    );

    let vaultCleaned = false;
    let vaultResidual = { localResidual: [], remoteResidual: [] };
    try {
      const vaultsOut = obsidianCli(null, ["vaults", "verbose"], 15000);
      const match = vaultsOut
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [name, ...rest] = l.split("\t");
          return { name: name?.trim(), path: rest.join("\t").trim() };
        })
        .find((v) => v.name === vaultName && resolve(v.path) === vaultPath);

      if (match) {
        try {
          obsidianCli(vaultName, ["dev:mobile", "off"], 15000);
        } catch {
          // ignore
        }

        vaultResidual = obsidianEvalJson(
          vaultName,
          `
${REMOTE_HELPER_JS}
closeAllModalsAndSettings();
const plugin = getPlugin();
const allowedBase = ${JSON.stringify(allowedRemoteBase)};
const configDir = app.vault.configDir;

// 1. Clean remote run-* folders under allowedBase if authorized & remoteBasePath is safe
const remoteResidual = [];
if (plugin.settings.accessToken) {
  const curBase = (plugin.settings.remoteBasePath || "").trim().replace(/\\/+$/, "");
  if (curBase === allowedBase || curBase.startsWith(allowedBase + "/")) {
    const items = await plugin.client.listAll(allowedBase);
    const runDirs = new Set();
    const prefix = allowedBase + "/";
    for (const it of items) {
      if (!it.path || !it.path.startsWith(prefix)) continue;
      const rel = it.path.slice(prefix.length);
      const top = rel.split("/")[0];
      if (top.startsWith("run-")) {
        runDirs.add(allowedBase + "/" + top);
      }
    }
    if (runDirs.size > 0) {
      await plugin.client.deleteFiles(Array.from(runDirs));
    }
    // Re-verify remote zero residual for run-*
    const after = await plugin.client.listAll(allowedBase);
    for (const it of after) {
      if (!it.path || !it.path.startsWith(prefix)) continue;
      const top = it.path.slice(prefix.length).split("/")[0];
      if (top.startsWith("run-")) remoteResidual.push(it.path);
    }
    // Ensure remoteBasePath points cleanly back to allowedBase (not a run-* child)
    if (curBase !== allowedBase) {
      plugin.settings.remoteBasePath = allowedBase;
      await plugin.saveSettings();
    }
  }
}

// 2. Clean all local E2E artifacts & trash
const rootList = await app.vault.adapter.list("");
for (const f of rootList.files) {
  if (f.startsWith("e2e-")) await removeLocalPath(f);
}
for (const d of ["e2e-dir", "attachments"]) {
  await removeLocalPath(d);
}
await removeLocalPath(configDir + "/snippets/e2e-snippet.css");
if (await app.vault.adapter.exists(configDir + "/snippets")) {
  const sList = await app.vault.adapter.list(configDir + "/snippets");
  if (sList.files.length === 0 && sList.folders.length === 0) {
    await removeLocalPath(configDir + "/snippets");
  }
}
await removeLocalPath(configDir + "/plugins/e2e-dummy");
if (await app.vault.adapter.exists(".trash")) {
  const tList = await app.vault.adapter.list(".trash");
  for (const tf of tList.files) {
    if (tf.includes("e2e-") || tf.includes("nested-renamed")) await removeLocalPath(tf);
  }
  for (const td of tList.folders) {
    if (td.includes("e2e-")) await removeLocalPath(td);
  }
  const tAfter = await app.vault.adapter.list(".trash");
  if (tAfter.files.length === 0 && tAfter.folders.length === 0) {
    await removeLocalPath(".trash");
  }
}

// 3. Reset manifest baseline & remove .bak
await plugin.engine.resetLocalBaseline();
const pluginDir = plugin.manifest.dir || (configDir + "/plugins/${PLUGIN_ID}");
await removeLocalPath(pluginDir + "/sync_manifest.json.bak");

// 4. Verify local zero residual
const rootAfter = await app.vault.adapter.list("");
const localResidual = [
  ...rootAfter.files.filter((f) => f.startsWith("e2e-")),
  ...rootAfter.folders.filter((d) => d === "e2e-dir" || d === "attachments")
];

return { localResidual, remoteResidual };
`,
          90000
        );

        try {
          obsidianCli(vaultName, ["plugin:reload", `id=${PLUGIN_ID}`], 30000);
          obsidianCli(vaultName, ["dev:errors", "clear"], 15000);
          obsidianCli(vaultName, ["dev:console", "clear"], 15000);
        } catch {
          // ignore
        }
        vaultCleaned = true;
      } else {
        console.log(
          `${colors.yellow}ℹ️  Test vault "${vaultName}" is not open in Obsidian; skipped live vault/remote cleanup.${colors.reset}`
        );
      }
    } catch (err) {
      console.error(
        `${colors.red}❌ Cleanup failed: ${err instanceof Error ? err.message : String(err)}${colors.reset}`
      );
      process.exit(1);
    }

    if (
      vaultCleaned &&
      (vaultResidual.localResidual.length > 0 || vaultResidual.remoteResidual.length > 0)
    ) {
      console.error(
        `${colors.red}❌ Residual test traces remain! local=${vaultResidual.localResidual.length}, remote=${vaultResidual.remoteResidual.length}${colors.reset}`
      );
      process.exit(1);
    }

    console.log(
      `${colors.green}✅ Zero-Trace Cleanup Complete${vaultCleaned ? " (local=0 residual, remote=0 residual, plugin reloaded, console/errors cleared)" : " (workspace reports & clipboard cleaned)"}.${colors.reset}`
    );
    process.exit(0);
  }

  // Verify Obsidian CLI & registered vault
  let obsidianVersion = "";
  try {
    obsidianVersion = obsidianCli(null, ["version"], 15000);
  } catch (err) {
    console.error(
      `${colors.red}❌ Obsidian CLI unavailable. Ensure Obsidian is running and CLI is enabled.${colors.reset}`
    );
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const vaultsOut = obsidianCli(null, ["vaults", "verbose"], 15000);
  const registeredVaults = vaultsOut
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, ...rest] = l.split("\t");
      return { name: name?.trim(), path: rest.join("\t").trim() };
    });

  const targetVault = registeredVaults.find(
    (v) => v.name === vaultName && resolve(v.path) === vaultPath
  );
  if (!targetVault) {
    console.error(
      `${colors.red}❌ Test vault "${vaultName}" (${vaultPath}) is not open/registered in Obsidian.${colors.reset}`
    );
    console.error(`Currently registered vaults:`);
    for (const v of registeredVaults) {
      console.error(`  - ${v.name}\t${v.path}`);
    }
    console.error(
      `Open "${vaultPath}" in Obsidian (Open folder as vault), configure Baidu pairing + remoteBasePath="${allowedRemoteBase}", then re-run.`
    );
    process.exit(1);
  }

  // Deploy fresh artifacts unless --skip-deploy
  if (!skipDeploy) {
    execFileSync("node", [resolve(rootDir, "scripts/deploy-local.mjs"), "--build"], {
      cwd: rootDir,
      stdio: "inherit"
    });
  }

  const localManifest = JSON.parse(readFileSync(resolve(rootDir, "manifest.json"), "utf-8"));
  const runId = makeRunId();
  const runRemoteBase = `${allowedRemoteBase}/run-${runId}`;
  const altRemoteBase = `${allowedRemoteBase}/run-${runId}-alt`;
  const e2eeRemoteBase = `${runRemoteBase}/e2ee-sub`;

  const reportDir = resolve(rootDir, "dist", "e2e-reports", runId);
  mkdirSync(reportDir, { recursive: true });

  console.log("\n" + "=".repeat(72));
  console.log(`${colors.bold}${colors.cyan}🧪 Local Obsidian Full 9-Domain E2E Business Test Suite${colors.reset}`);
  console.log(`${colors.dim}Obsidian Version : ${obsidianVersion}${colors.reset}`);
  console.log(`${colors.dim}Plugin Version   : ${localManifest.version}${colors.reset}`);
  console.log(`${colors.dim}Target Vault     : ${vaultName} (${vaultPath})${colors.reset}`);
  console.log(`${colors.dim}Remote Run Root  : ${runRemoteBase}${colors.reset}`);
  console.log(`${colors.dim}Report Directory : ${reportDir}${colors.reset}`);
  console.log("=".repeat(72) + "\n");

  // Reload plugin & verify preflight inside Obsidian
  obsidianCli(vaultName, ["plugin:reload", `id=${PLUGIN_ID}`], 30000);

  const preflight = obsidianEvalJson(
    vaultName,
    `
${REMOTE_HELPER_JS}
await sleep(500);
const plugin = getPlugin();
const s = plugin.settings;
const configDir = app.vault.configDir;
return {
  loadedVersion: plugin.manifest?.version || "",
  hasAccessToken: Boolean(s.accessToken),
  remoteBasePath: (s.remoteBasePath || "").trim().replace(/\\/+$/, ""),
  configDir,
  hadSnippetsDir: await app.vault.adapter.exists(configDir + "/snippets"),
  hadTrashDir: await app.vault.adapter.exists(".trash"),
  hadAttachmentsDir: await app.vault.adapter.exists("attachments"),
  snapshot: JSON.parse(JSON.stringify(s)),
  secretHints: [s.accessToken, s.refreshToken, s.appSecret, s.e2eePassword].filter((x) => typeof x === "string" && x.length >= 6)
};
`
  );

  const secretsToRedact = [...(preflight.secretHints || []), "E2EE_Test_Pass#2026", "E2ePin!2026"];
  const originalSettingsSnapshot = preflight.snapshot;

  if (preflight.loadedVersion !== localManifest.version) {
    console.error(
      `${colors.red}❌ Loaded plugin version (${preflight.loadedVersion}) != repo manifest.json (${localManifest.version}). Run npm run deploy:local first.${colors.reset}`
    );
    process.exit(1);
  }

  if (!preflight.hasAccessToken) {
    console.error(
      `${colors.red}❌ Test vault "${vaultName}" is NOT authorized with Baidu Netdisk yet.${colors.reset}`
    );
    console.error(
      `Open Obsidian -> Vault "${vaultName}" -> Settings -> Baidu Netdisk Sync -> Import configuration (pairing code) and set Remote base path to "${allowedRemoteBase}".`
    );
    process.exit(1);
  }

  const currentRemoteBase = normalizeRemote(preflight.remoteBasePath);
  if (
    FORBIDDEN_REMOTE_BASES.has(currentRemoteBase) ||
    (currentRemoteBase !== allowedRemoteBase && !currentRemoteBase.startsWith(`${allowedRemoteBase}/`))
  ) {
    console.error(
      `${colors.red}🛑 SAFETY ABORT: Test vault remoteBasePath="${currentRemoteBase}" does NOT match allowed BAIDU_E2E_REMOTE_BASE="${allowedRemoteBase}".${colors.reset}`
    );
    console.error(
      `Refusing to run E2E tests! Please update Remote base path in vault "${vaultName}" to "${allowedRemoteBase}" first.`
    );
    process.exit(1);
  }

  // Clear console & error buffers before tests
  obsidianCli(vaultName, ["dev:errors", "clear"], 15000);
  obsidianCli(vaultName, ["dev:console", "clear"], 15000);

  const results = [];
  const screenshots = {};
  let cleanupReport = {
    executed: false,
    keepArtifacts,
    verified: false,
    localResidualCount: -1,
    remoteResidualCount: -1,
    clipboardCleared: false,
    error: ""
  };

  async function runDomain(id, title, fn) {
    const startedAt = Date.now();
    process.stdout.write(`${colors.cyan}▶ [${id}] ${title}...${colors.reset}\n`);
    try {
      const details = await fn();
      const durationMs = Date.now() - startedAt;
      results.push({ id, title, status: "PASS", durationMs, details: details || {} });
      console.log(
        `${colors.green}  ✅ PASS (${(durationMs / 1000).toFixed(1)}s)${colors.reset}` +
          (details?.summary ? ` ${colors.dim}- ${sanitizeText(details.summary, secretsToRedact)}${colors.reset}` : "")
      );
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const msg = sanitizeText(err instanceof Error ? err.message : String(err), secretsToRedact);
      results.push({ id, title, status: "FAIL", durationMs, error: msg });
      console.log(`${colors.red}  ❌ FAIL (${(durationMs / 1000).toFixed(1)}s): ${msg}${colors.reset}`);
    }
  }

  try {
    // ── D1: Lifecycle, UI, i18n, CSS & Zero Console Errors ─────────────────
    await runDomain("D1", "Lifecycle, UI Rendering, Commands & Zero Console Errors", async () => {
      obsidianCli(vaultName, ["plugin:reload", `id=${PLUGIN_ID}`], 30000);

      const d1 = obsidianEvalJson(
        vaultName,
        `
${REMOTE_HELPER_JS}
await sleep(400);
const plugin = getPlugin();
closeAllModalsAndSettings();

// 1. Commands & Status Bar & Ribbon
const hasSyncCmd = Boolean(app.commands.commands["${PLUGIN_ID}:baidu-sync-now"]);
const hasLogCmd = Boolean(app.commands.commands["${PLUGIN_ID}:baidu-sync-view-logs"]);
assertTrue(hasSyncCmd, "Command baidu-sync-now must be registered");
assertTrue(hasLogCmd, "Command baidu-sync-view-logs must be registered");

const statusBarEl = document.querySelector(".baidu-sync-status-bar");
assertTrue(Boolean(statusBarEl), "Status bar item .baidu-sync-status-bar must exist");

// 2. Open Settings Tab & verify 7 sections + no static inline style pollution
app.setting.open();
app.setting.openTabById("${PLUGIN_ID}");
await sleep(300);

const tabContainer = app.setting.activeTab?.containerEl;
assertTrue(Boolean(tabContainer), "Settings tab containerEl must be mounted");
const headings = Array.from(tabContainer.querySelectorAll(".setting-item-heading")).map((el) => el.textContent?.trim() || "");
assertTrue(headings.length >= 7, "Expected >= 7 settings headings, got " + headings.length);

const inlineStyled = Array.from(tabContainer.querySelectorAll("[style]")).filter((el) => {
  // Ignore Obsidian core slider/internal styles if any, focus on plugin classes
  return el.className && String(el.className).includes("baidu-sync-");
});
assertTrue(inlineStyled.length === 0, "Found forbidden inline styles on plugin elements: " + inlineStyled.length);

return { headingsCount: headings.length, statusBarText: statusBarEl.textContent?.trim() || "" };
`
      );

      const settingsShot = captureScreenshot(vaultName, resolve(reportDir, "desktop-settings.png"));
      if (settingsShot) screenshots.desktopSettings = settingsShot;

      // Open SyncLogModal via registered command & capture screenshot
      obsidianEvalJson(
        vaultName,
        `
${REMOTE_HELPER_JS}
closeAllModalsAndSettings();
await sleep(150);
app.commands.executeCommandById("${PLUGIN_ID}:baidu-sync-view-logs");
await sleep(300);
const modalEl = document.querySelector(".baidu-sync-log-modal");
assertTrue(Boolean(modalEl), "SyncLogModal .baidu-sync-log-modal must open");
const recoveryEl = modalEl.querySelector(".baidu-sync-recovery-section");
assertTrue(Boolean(recoveryEl), "SyncLogModal recovery controls must render");
return { modalOpened: true };
`
      );

      const logShot = captureScreenshot(vaultName, resolve(reportDir, "desktop-log-modal.png"));
      if (logShot) screenshots.desktopLogModal = logShot;

      obsidianEvalJson(
        vaultName,
        `
${REMOTE_HELPER_JS}
closeAllModalsAndSettings();
return true;
`
      );

      const errorsOut = obsidianCli(vaultName, ["dev:errors"], 15000);
      if (errorsOut && !errorsOut.includes("No errors captured")) {
        throw new Error(`Uncaught Obsidian errors during D1: ${errorsOut}`);
      }

      return {
        summary: `${d1.headingsCount} settings sections, statusBar="${d1.statusBarText}", 0 runtime errors`,
        ...d1
      };
    });

    // ── D2: Core Bidirectional Sync, Binary, >4MB Chunked Upload & Dual Trash
    await runDomain("D2", "Core Bidirectional Sync, Binary, >4MB Chunked Upload & Dual Trash", async () => {
      const d2 = obsidianEvalJson(
        vaultName,
        `
${REMOTE_HELPER_JS}
const plugin = getPlugin();
const runBase = ${JSON.stringify(runRemoteBase)};
const runTag = ${JSON.stringify(runId)};

// Configure clean deterministic test settings
Object.assign(plugin.settings, {
  remoteBasePath: runBase,
  enableE2EE: false,
  e2eePassword: "",
  conflictStrategy: "copy",
  syncOnStartup: false,
  syncIntervalMinutes: 0,
  syncOnSave: false,
  syncObsidianConfig: false,
  syncPlugins: false,
  syncThemes: false,
  maxFileSizeMB: 100,
  concurrency: 3
});
await plugin.saveSettings();
plugin.resetInterval();

// Clean any stale local e2e artifacts & reset baseline
for (const p of ["e2e-note.md", "e2e-dir", "e2e-bin.png", "e2e-chunked-4mb.bin", "e2e-remote-new.md"]) {
  await removeLocalPath(p);
}
await plugin.engine.resetLocalBaseline();

// 1. Seed local files (UTF-8 Chinese/emoji, nested, binary PNG, >4.25MB multi-chunk binary)
const noteV1 = "# E2E 双向同步测试\\n\\nRun: " + runTag + " 🚀\\n";
await writeLocalText("e2e-note.md", noteV1);
await writeLocalText("e2e-dir/nested.md", "Nested content " + runTag);

const pngBytes = new Uint8Array(2048);
for (let i = 0; i < pngBytes.length; i++) pngBytes[i] = (i * 31 + 17) & 0xff;
const pngHash = sha256Hex(pngBytes);
await writeLocalBinary("e2e-bin.png", pngBytes.buffer.slice(0));

const chunkSizeBytes = 4 * 1024 * 1024 + 256 * 1024; // 4.25 MB -> 2 Baidu superfile2 slices
const bigBytes = new Uint8Array(chunkSizeBytes);
const headerBytes = new TextEncoder().encode("E2E_CHUNK_" + runTag + "_");
bigBytes.set(headerBytes, 0);
for (let i = headerBytes.length; i < bigBytes.length; i += 97) {
  bigBytes[i] = (i + runTag.charCodeAt(i % runTag.length)) & 0xff;
}
const bigHash = sha256Hex(bigBytes);
await writeLocalBinary("e2e-chunked-4mb.bin", bigBytes.buffer.slice(0));

const r1 = await plugin.engine.startSync(false);
assertTrue(r1.success, "Initial upload sync failed: " + JSON.stringify(r1));
assertTrue(r1.stats.uploaded >= 4, "Expected >=4 uploads, got " + r1.stats.uploaded);

const remoteItems1 = await plugin.client.listAll(runBase);
const remotePaths1 = new Set(remoteItems1.map((i) => i.path));
for (const rel of ["e2e-note.md", "e2e-dir/nested.md", "e2e-bin.png", "e2e-chunked-4mb.bin"]) {
  assertTrue(remotePaths1.has(runBase + "/" + rel), "Missing on Baidu after upload: " + rel);
}

// 2. Local modify & rename -> sync
await sleep(1500);
await writeLocalText("e2e-note.md", noteV1 + "Local edit line\\n");
await writeLocalText("e2e-dir/nested-renamed.md", "Nested renamed " + runTag);
await removeLocalPath("e2e-dir/nested.md");

const r2 = await plugin.engine.startSync(false);
assertTrue(r2.success, "Modify/rename sync failed: " + JSON.stringify(r2));
const remoteItems2 = await plugin.client.listAll(runBase);
const remotePaths2 = new Set(remoteItems2.map((i) => i.path));
assertTrue(remotePaths2.has(runBase + "/e2e-dir/nested-renamed.md"), "Renamed file missing on remote");
assertTrue(!remotePaths2.has(runBase + "/e2e-dir/nested.md"), "Old renamed file still present on remote");

// 3. Simulated second device: remote create, remote modify, remote delete -> sync -> check Dual Trash
await sleep(2000);
const remoteNewContent = "Created directly on remote device " + runTag;
const remoteModifiedContent = "Modified directly on remote device " + runTag;
await remoteUploadPlain(plugin, runBase + "/e2e-remote-new.md", remoteNewContent);
await remoteUploadPlain(plugin, runBase + "/e2e-note.md", remoteModifiedContent);
await plugin.client.deleteFiles([runBase + "/e2e-dir/nested-renamed.md"]);

const r3 = await plugin.engine.startSync(false);
assertTrue(r3.success, "Remote->Local pull sync failed: " + JSON.stringify(r3));
assertTrue(await app.vault.adapter.exists("e2e-remote-new.md"), "Remote-created file not downloaded");
assertTrue((await app.vault.adapter.read("e2e-remote-new.md")) === remoteNewContent, "Remote-created file content mismatch");
assertTrue((await app.vault.adapter.read("e2e-note.md")) === remoteModifiedContent, "Remote-modified content not applied");
assertTrue(!(await app.vault.adapter.exists("e2e-dir/nested-renamed.md")), "Remote-deleted file still exists locally");
const inTrash =
  (await app.vault.adapter.exists(".trash/e2e-dir/nested-renamed.md")) ||
  (await app.vault.adapter.exists(".trash/nested-renamed.md"));
assertTrue(inTrash, "Remote-deleted local file must be moved to .trash (Dual Trash)");

// 4. Delete local binary & >4MB file + manifest entries -> re-download & verify SHA-256 byte-for-byte
await removeLocalPath("e2e-bin.png");
await removeLocalPath("e2e-chunked-4mb.bin");
plugin.manifestMgr.delete("e2e-bin.png");
plugin.manifestMgr.delete("e2e-chunked-4mb.bin");
await plugin.manifestMgr.save();

const r4 = await plugin.engine.startSync(false);
assertTrue(r4.success, "Binary re-download sync failed: " + JSON.stringify(r4));
const dlPngHash = sha256Hex(new Uint8Array(await app.vault.adapter.readBinary("e2e-bin.png")));
const dlBigHash = sha256Hex(new Uint8Array(await app.vault.adapter.readBinary("e2e-chunked-4mb.bin")));
assertTrue(dlPngHash === pngHash, "PNG binary SHA-256 mismatch after roundtrip");
assertTrue(dlBigHash === bigHash, ">4MB chunked binary SHA-256 mismatch after roundtrip");

// 5. Manifestless plaintext MD5 dedup (reset baseline -> sync -> 0 uploads, 0 downloads)
await plugin.engine.resetLocalBaseline();
const r5 = await plugin.engine.startSync(false);
assertTrue(r5.success, "Manifestless dedup sync failed: " + JSON.stringify(r5));
assertTrue(
  r5.stats.uploaded === 0 && r5.stats.downloaded === 0,
  "Expected 0 uploads & 0 downloads on manifestless MD5 dedup, got " + JSON.stringify(r5.stats)
);

return {
  summary: "upload/modify/rename/remote-pull/dual-trash/>4.25MB-chunked-SHA256/manifestless-MD5-dedup all verified",
  initialUploaded: r1.stats.uploaded,
  chunkBytes: chunkSizeBytes
};
`,
        240000
      );
      return d2;
    });

    // ── D3: Conflict Resolution (Copy & LWW) ───────────────────────────────
    await runDomain("D3", "Conflict Resolution (Conflict Copy & LWW)", async () => {
      const d3 = obsidianEvalJson(
        vaultName,
        `
${REMOTE_HELPER_JS}
const plugin = getPlugin();
const runBase = ${JSON.stringify(runRemoteBase)};
const runTag = ${JSON.stringify(runId)};

// Part A: Conflict Copy (default safe strategy)
plugin.settings.remoteBasePath = runBase;
plugin.settings.conflictStrategy = "copy";
plugin.settings.enableE2EE = false;
await plugin.saveSettings();

await writeLocalText("e2e-conflict.md", "BASE_VERSION_" + runTag);
let res = await plugin.engine.startSync(false);
assertTrue(res.success, "Conflict base sync failed");

await sleep(2000);
const localVer = "LOCAL_CONCURRENT_EDIT_" + runTag;
const remoteVer = "REMOTE_CONCURRENT_EDIT_" + runTag;
await writeLocalText("e2e-conflict.md", localVer);
await remoteUploadPlain(plugin, runBase + "/e2e-conflict.md", remoteVer);

res = await plugin.engine.startSync(false);
assertTrue(res.success, "Conflict copy sync failed: " + JSON.stringify(res));
assertTrue(res.stats.conflicts === 1, "Expected stats.conflicts === 1, got " + res.stats.conflicts);

const rootList = await app.vault.adapter.list("");
const conflictFiles = rootList.files.filter((f) => /^e2e-conflict\\.conflict-\\d{8}-\\d{6}.*\\.md$/.test(f));
assertTrue(conflictFiles.length >= 1, "Conflict copy file not created locally");
const mainText = await app.vault.adapter.read("e2e-conflict.md");
const copyText = await app.vault.adapter.read(conflictFiles[0]);
const combined = [mainText, copyText];
assertTrue(combined.includes(localVer) && combined.includes(remoteVer), "Conflict copy lost one side's content!");

const remoteItems = await plugin.client.listAll(runBase);
assertTrue(
  remoteItems.some((i) => i.path === runBase + "/" + conflictFiles[0]),
  "Conflict copy not uploaded to remote"
);

// Part B: LWW strategy
plugin.settings.conflictStrategy = "lww";
await plugin.saveSettings();

await writeLocalText("e2e-lww.md", "LWW_BASE_" + runTag);
res = await plugin.engine.startSync(false);
assertTrue(res.success, "LWW base sync failed");

await sleep(1500);
await writeLocalText("e2e-lww.md", "LWW_LOCAL_OLDER_" + runTag);
await sleep(2500);
const lwwRemoteNewer = "LWW_REMOTE_NEWER_" + runTag;
await remoteUploadPlain(plugin, runBase + "/e2e-lww.md", lwwRemoteNewer);

res = await plugin.engine.startSync(false);
assertTrue(res.success, "LWW sync failed: " + JSON.stringify(res));
assertTrue(res.stats.conflicts === 0, "LWW must not generate conflict copies");
assertTrue((await app.vault.adapter.read("e2e-lww.md")) === lwwRemoteNewer, "LWW did not apply newer remote content");

plugin.settings.conflictStrategy = "copy";
await plugin.saveSettings();

return {
  summary: "copy preserved both edits (" + conflictFiles[0] + ") & LWW applied newer remote cleanly",
  conflictFile: conflictFiles[0]
};
`,
        180000
      );
      return d3;
    });

    // ── D4: Sync Scope & Dual Ignore Layers (Global + Local Preset + Self-Exclusion)
    await runDomain("D4", "Sync Scope (.obsidian/snippets/plugins) & Dual Ignore Layers", async () => {
      const d4 = obsidianEvalJson(
        vaultName,
        `
${REMOTE_HELPER_JS}
const plugin = getPlugin();
const runBase = ${JSON.stringify(runRemoteBase)};
const configDir = app.vault.configDir;

plugin.settings.remoteBasePath = runBase;
plugin.settings.syncObsidianConfig = true;
plugin.settings.syncPlugins = false;
plugin.settings.syncThemes = true;
plugin.settings.ignoredPatterns = "**/.git/**\\n**/.DS_Store\\n**/workspace*.json\\n**/*.e2eignore";
plugin.settings.localIgnoredPatterns = "";
await plugin.saveSettings();

// Exercise the real Settings Tab "Add mobile preset" button for localIgnoredPatterns
closeAllModalsAndSettings();
app.setting.open();
app.setting.openTabById("${PLUGIN_ID}");
await sleep(300);

const tabEl = app.setting.activeTab.containerEl;
const textareas = Array.from(tabEl.querySelectorAll("textarea.baidu-sync-textarea"));
assertTrue(textareas.length >= 2, "Expected both global & local ignore textareas in settings");
const localSettingItem = textareas[1].closest(".setting-item");
const presetBtn = localSettingItem?.querySelector("button");
assertTrue(Boolean(presetBtn), "Missing mobile preset button in localIgnoredPatterns setting");
presetBtn.click();
await sleep(250);
closeAllModalsAndSettings();

assertTrue(
  plugin.settings.localIgnoredPatterns.includes("**/attachments/**") &&
  plugin.settings.localIgnoredPatterns.includes("**/*.mp4"),
  "Mobile preset button did not populate localIgnoredPatterns"
);

// Create scope & filter test files
await writeLocalText(configDir + "/snippets/e2e-snippet.css", "/* e2e snippet */\\nbody {}");
await writeLocalText(configDir + "/plugins/e2e-dummy/main.js", "module.exports = {};");
await writeLocalText("e2e-global-skip.e2eignore", "should be globally ignored");
await writeLocalText("attachments/e2e-local-skip.bin", "should be locally ignored");
await writeLocalText("e2e-video-skip.mp4", "fake video bytes");

const res = await plugin.engine.startSync(false);
assertTrue(res.success, "D4 scope sync failed: " + JSON.stringify(res));

const remoteItems = await plugin.client.listAll(runBase);
const remotePaths = new Set(remoteItems.map((i) => i.path));

assertTrue(
  remotePaths.has(runBase + "/" + configDir + "/snippets/e2e-snippet.css"),
  "CSS snippet must sync when syncThemes=true"
);
assertTrue(
  !remotePaths.has(runBase + "/" + configDir + "/plugins/e2e-dummy/main.js"),
  "Plugins must NOT sync when syncPlugins=false"
);
assertTrue(
  !remotePaths.has(runBase + "/" + configDir + "/plugins/${PLUGIN_ID}/data.json") &&
  !remotePaths.has(runBase + "/" + configDir + "/plugins/${PLUGIN_ID}/sync_manifest.json"),
  "Own plugin data.json / sync_manifest.json MUST NEVER be uploaded!"
);
assertTrue(!remotePaths.has(runBase + "/e2e-global-skip.e2eignore"), "Global ignoredPatterns failed");
assertTrue(!remotePaths.has(runBase + "/attachments/e2e-local-skip.bin"), "localIgnoredPatterns attachments rule failed");
assertTrue(!remotePaths.has(runBase + "/e2e-video-skip.mp4"), "localIgnoredPatterns *.mp4 rule failed");

// Verify syncThemes=false covers both themes and snippets
plugin.settings.syncThemes = false;
await plugin.saveSettings();
assertTrue(plugin.engine.shouldIgnore(configDir + "/snippets/e2e-snippet.css"), "syncThemes=false must ignore snippets");
assertTrue(plugin.engine.shouldIgnore(configDir + "/themes/Minimal/theme.css"), "syncThemes=false must ignore themes");

// Disable config sync for cleaner subsequent domains
plugin.settings.syncObsidianConfig = false;
await plugin.saveSettings();

return {
  summary: "snippets synced, plugins/global/local-preset/self-credentials strictly excluded"
};
`,
        180000
      );
      return d4;
    });

    // ── D5: Safety Guards (maxFileSize, remoteBase switch, mass-delete breaker, corrupted manifest .bak)
    await runDomain("D5", "Safety Circuit Breakers (Size Limit, Base Switch, Mass-Delete & Manifest .bak Recovery)", async () => {
      const d5 = obsidianEvalJson(
        vaultName,
        `
${REMOTE_HELPER_JS}
const plugin = getPlugin();
const runBase = ${JSON.stringify(runRemoteBase)};
const altBase = ${JSON.stringify(altRemoteBase)};

plugin.settings.remoteBasePath = runBase;
plugin.settings.syncObsidianConfig = false;
plugin.settings.maxFileSizeMB = 1;
await plugin.saveSettings();

// 1. maxFileSizeMB skip guard
const overBuf = new Uint8Array(Math.floor(1.3 * 1024 * 1024));
overBuf.fill(0x55);
await writeLocalBinary("e2e-oversized.bin", overBuf.buffer);
await writeLocalText("e2e-small-ok.md", "small file ok");

let res = await plugin.engine.startSync(false);
assertTrue(res.success, "Size-limit sync should still succeed: " + JSON.stringify(res));
assertTrue(res.stats.skipped >= 1, "Oversized file should increment stats.skipped");
const itemsAfterLimit = await plugin.client.listAll(runBase);
assertTrue(!itemsAfterLimit.some((i) => i.path === runBase + "/e2e-oversized.bin"), "Oversized file must not upload");
assertTrue(itemsAfterLimit.some((i) => i.path === runBase + "/e2e-small-ok.md"), "Normal file must upload alongside skipped oversized file");

await removeLocalPath("e2e-oversized.bin");
plugin.settings.maxFileSizeMB = 100;
await plugin.saveSettings();

// 2. remoteBasePath switch guard (switching to empty altBase must NEVER wipe local files)
plugin.settings.remoteBasePath = altBase;
await plugin.saveSettings();
res = await plugin.engine.startSync(false);
assertTrue(res.success, "remoteBasePath switch sync failed: " + JSON.stringify(res));
assertTrue(await app.vault.adapter.exists("e2e-small-ok.md"), "Switching remoteBasePath must NEVER delete local files!");
const altItems = await plugin.client.listAll(altBase);
assertTrue(altItems.some((i) => i.path === altBase + "/e2e-small-ok.md"), "Files should upload cleanly to new remoteBasePath");

// Switch back to runBase
plugin.settings.remoteBasePath = runBase;
await plugin.saveSettings();
res = await plugin.engine.startSync(false);
assertTrue(res.success, "Switch back to runBase failed");

// 3. Bidirectional mass-delete circuit breaker + SyncLogModal Force-Delete UI
const guardFiles = [];
for (let i = 1; i <= 10; i++) {
  const name = "e2e-guard-" + String(i).padStart(2, "0") + ".md";
  guardFiles.push(name);
  await writeLocalText(name, "guard content " + i);
}
res = await plugin.engine.startSync(false);
assertTrue(res.success, "Seeding 10 guard files failed: " + JSON.stringify(res));

// Wipe remote side directly via API (manifest still tracks all files)
const allRemote = await plugin.client.listAll(runBase);
assertTrue(allRemote.length >= 10, "Expected >=10 remote files before mass-delete test");
await plugin.client.deleteFiles(allRemote.map((i) => i.path));

// Sync must ABORT local wipe!
res = await plugin.engine.startSync(false);
assertTrue(res.success === false && res.massDeleteAborted === true, "Empty-remote mass-delete circuit breaker did NOT trigger!");
assertTrue(plugin.engine.wasLastRunMassDeleteAborted(), "wasLastRunMassDeleteAborted() must be true");
for (const gf of guardFiles) {
  assertTrue(await app.vault.adapter.exists(gf), "Guard file was deleted despite mass-delete abort: " + gf);
}

// Verify SyncLogModal surfaces the warning box & Force Delete recovery control
app.commands.executeCommandById("${PLUGIN_ID}:baidu-sync-view-logs");
await sleep(250);
const warnBox = document.querySelector(".baidu-sync-recovery-section.baidu-sync-warning-box");
assertTrue(Boolean(warnBox), "SyncLogModal must highlight recovery section on massDeleteAborted");
const warnButtons = warnBox.querySelectorAll("button.mod-warning");
assertTrue(warnButtons.length >= 1, "SyncLogModal must render Force Delete warning button");
closeAllModalsAndSettings();

// Reset baseline & re-upload so remote has >=10 files, then test opposite direction (local empty -> abort remote wipe)
await plugin.engine.resetLocalBaseline();
res = await plugin.engine.startSync(false);
assertTrue(res.success, "Re-sync before local-empty breaker failed");

// Delete ALL tracked local files at once
const rootNow = await app.vault.adapter.list("");
for (const f of rootNow.files) {
  if (f.startsWith("e2e-")) await removeLocalPath(f);
}
await removeLocalPath("e2e-dir");

res = await plugin.engine.startSync(false);
assertTrue(res.success === false && res.massDeleteAborted === true, "Empty-local mass-delete circuit breaker did NOT trigger!");
const remoteStillThere = await plugin.client.listAll(runBase);
assertTrue(remoteStillThere.length >= 10, "Remote files were wiped despite local-empty mass-delete abort!");

// 4. Corrupted sync_manifest.json recovery via sync_manifest.json.bak
await plugin.engine.resetLocalBaseline();
await writeLocalText("e2e-bak-test.md", "backup test 1");
res = await plugin.engine.startSync(false);
assertTrue(res.success, "Manifest backup step 1 failed");
await writeLocalText("e2e-bak-test.md", "backup test 2 updated");
res = await plugin.engine.startSync(false);
assertTrue(res.success, "Manifest backup step 2 failed");

const pluginDir = plugin.manifest.dir || (app.vault.configDir + "/plugins/${PLUGIN_ID}");
const manifestPath = pluginDir + "/sync_manifest.json";
const bakPath = manifestPath + ".bak";
assertTrue(await app.vault.adapter.exists(bakPath), "sync_manifest.json.bak must exist after second save");

// Corrupt main manifest JSON
await app.vault.adapter.write(manifestPath, "{ CORRUPTED_JSON_PAYLOAD");
res = await plugin.engine.startSync(false);
assertTrue(res.success, "Sync should transparently recover from sync_manifest.json.bak, got: " + JSON.stringify(res));

return {
  summary: "maxFileSize skip, remoteBase switch, bidirectional mass-delete abort + UI, and manifest .bak recovery all verified"
};
`,
        240000
      );
      return d5;
    });

    // ── D6: Triggers, Debounced syncOnSave, Echo Suppression & Single-Flight
    await runDomain("D6", "Triggers (syncOnSave Debounce), Echo Suppression & Single-Flight Lock", async () => {
      const d6 = obsidianEvalJson(
        vaultName,
        `
${REMOTE_HELPER_JS}
const plugin = getPlugin();
const runBase = ${JSON.stringify(runRemoteBase)};
const runTag = ${JSON.stringify(runId)};

plugin.settings.remoteBasePath = runBase;
plugin.settings.syncOnSave = true;
plugin.settings.syncDebounceSeconds = 1;
plugin.settings.syncIntervalMinutes = 0;
await plugin.saveSettings();
plugin.resetInterval();

// Ensure idle first
await plugin.engine.resetLocalBaseline();
await plugin.engine.startSync(false);

// 1. Create note via Vault API -> fires Obsidian "create" event -> debounced syncOnSave uploads automatically
const autoPath = "e2e-autosave-" + runTag + ".md";
await app.vault.create(autoPath, "Triggered automatically via syncOnSave " + runTag);

let foundRemote = false;
for (let i = 0; i < 20; i++) {
  await sleep(1000);
  if (!plugin.engine.isSyncing()) {
    const items = await plugin.client.listAll(runBase);
    if (items.some((it) => it.path === runBase + "/" + autoPath)) {
      foundRemote = true;
      break;
    }
  }
}
assertTrue(foundRemote, "syncOnSave debounced trigger did not upload " + autoPath + " within 20s");

// 2. Echo suppression on remote download
const echoPath = "e2e-echo-" + runTag + ".md";
await remoteUploadPlain(plugin, runBase + "/" + echoPath, "Remote echo test " + runTag);
const pullRes = await plugin.engine.startSync(false);
assertTrue(pullRes.success, "Echo test download sync failed");
assertTrue(
  plugin.engine.wasRecentlyWrittenBySync(echoPath),
  "wasRecentlyWrittenBySync() must be true immediately after download"
);

// 3. Single-flight concurrency guard (concurrent startSync calls)
const [p1, p2] = await Promise.all([
  plugin.engine.startSync(false),
  plugin.engine.startSync(false)
]);
assertTrue(
  (p1.success && !p2.success) || (!p1.success && p2.success),
  "Concurrent startSync must allow exactly one run and reject duplicate: " + JSON.stringify({ p1, p2 })
);
assertTrue(plugin.engine.getState() === "idle", "Engine must return to idle after single-flight test");

plugin.settings.syncOnSave = false;
await plugin.saveSettings();

return {
  summary: "debounced syncOnSave uploaded automatically, echo suppression active, single-flight lock verified"
};
`,
        180000
      );
      return d6;
    });

    // ── D7: Multi-Device Pairing (Export / Wrong PIN / Import Preserving localIgnoredPatterns)
    await runDomain("D7", "Multi-Device Encrypted Pairing (Export, Wrong PIN Reject, Local Ignore Preservation)", async () => {
      const d7 = obsidianEvalJson(
        vaultName,
        `
${REMOTE_HELPER_JS}
const plugin = getPlugin();
const testPin = "E2ePin!2026";
const originalConcurrency = 4;
const deviceCanary = "**/e2e-device-only-canary/**\\n**/*.localonly";

plugin.settings.concurrency = originalConcurrency;
plugin.settings.localIgnoredPatterns = deviceCanary;
await plugin.saveSettings();

// 1. Open Settings -> click Export configuration button -> generate pairing code via UI
closeAllModalsAndSettings();
app.setting.open();
app.setting.openTabById("${PLUGIN_ID}");
await sleep(300);

const tabEl = app.setting.activeTab.containerEl;
const pairingButtons = Array.from(tabEl.querySelectorAll("button"));
// Section 2 pairing row has CTA Export button followed by Import button in the same .setting-item
let exportBtn = null;
let importBtn = null;
for (const item of Array.from(tabEl.querySelectorAll(".setting-item"))) {
  const btns = Array.from(item.querySelectorAll("button"));
  if (btns.length === 2 && btns[0].classList.contains("mod-cta")) {
    exportBtn = btns[0];
    importBtn = btns[1];
    break;
  }
}
assertTrue(Boolean(exportBtn && importBtn), "Could not locate Export / Import pairing buttons in Settings Tab");

exportBtn.click();
await sleep(250);
const exportModal = document.querySelector(".modal-container .modal");
assertTrue(Boolean(exportModal), "ExportConfigModal failed to open");

const pinInput = exportModal.querySelector('input[type="password"]');
assertTrue(Boolean(pinInput), "ExportConfigModal PIN input missing");
pinInput.value = testPin;
pinInput.dispatchEvent(new Event("input", { bubbles: true }));

const genBtn = exportModal.querySelector("button.mod-cta");
assertTrue(Boolean(genBtn), "ExportConfigModal Generate button missing");
genBtn.click();

let pairingCode = "";
for (let i = 0; i < 40; i++) {
  await sleep(150);
  const ta = exportModal.querySelector("textarea.baidu-sync-code-area");
  if (ta && ta.value && ta.value.startsWith("BDSYNC:v1:")) {
    pairingCode = ta.value.trim();
    break;
  }
}
assertTrue(pairingCode.startsWith("BDSYNC:v1:"), "ExportConfigModal failed to generate BDSYNC:v1 pairing code");
exportModal.querySelector(".modal-close-button")?.click();
await sleep(200);

// 2. Mutate shared field (concurrency -> 1) and update localIgnoredPatterns canary
plugin.settings.concurrency = 1;
const updatedDeviceCanary = deviceCanary + "\\n**/second-local-rule/**";
plugin.settings.localIgnoredPatterns = updatedDeviceCanary;
await plugin.saveSettings();

// 3. Open ImportConfigModal -> test Wrong PIN first -> then Correct PIN
importBtn.click();
await sleep(250);
const importModal = document.querySelector(".modal-container .modal");
assertTrue(Boolean(importModal), "ImportConfigModal failed to open");

const codeArea = importModal.querySelector("textarea.baidu-sync-code-area");
const importPinInput = importModal.querySelector('input[type="password"]');
const applyBtn = importModal.querySelector("button.mod-cta");
assertTrue(Boolean(codeArea && importPinInput && applyBtn), "ImportConfigModal inputs/button missing");

codeArea.value = pairingCode;
codeArea.dispatchEvent(new Event("input", { bubbles: true }));
importPinInput.value = "WrongPin000";
importPinInput.dispatchEvent(new Event("input", { bubbles: true }));
applyBtn.click();
await sleep(800);

// Modal must still be open & concurrency must still be 1 (wrong PIN rejected)
assertTrue(document.body.contains(importModal), "ImportConfigModal should remain open after wrong PIN");
assertTrue(plugin.settings.concurrency === 1, "Settings must not mutate on wrong PIN");

// Now enter correct PIN
importPinInput.value = testPin;
importPinInput.dispatchEvent(new Event("input", { bubbles: true }));
applyBtn.click();

let importedOk = false;
for (let i = 0; i < 40; i++) {
  await sleep(150);
  if (!document.body.contains(importModal)) {
    importedOk = true;
    break;
  }
}
assertTrue(importedOk, "ImportConfigModal did not close after valid PIN import");
assertTrue(
  plugin.settings.concurrency === originalConcurrency,
  "Shared setting concurrency not restored (expected " + originalConcurrency + ", got " + plugin.settings.concurrency + ")"
);
assertTrue(
  plugin.settings.localIgnoredPatterns === updatedDeviceCanary,
  "Device-only localIgnoredPatterns was overwritten by pairing import!"
);

closeAllModalsAndSettings();
return {
  summary: "BDSYNC:v1 export/import UI verified, wrong PIN rejected, localIgnoredPatterns preserved"
};
`,
        120000
      );
      return d7;
    });

    // ── D8: E2EE v2 Roundtrip, Wrong Password Protection & One-Click Plaintext Migration
    await runDomain("D8", "E2EE v2 Ciphertext, Roundtrip Decrypt, Wrong Password Guard & Plaintext Migration", async () => {
      const d8 = obsidianEvalJson(
        vaultName,
        `
${REMOTE_HELPER_JS}
const plugin = getPlugin();
const e2eeBase = ${JSON.stringify(e2eeRemoteBase)};
const e2eePass = "E2EE_Test_Pass#2026";
const secretMarker = "TOP_SECRET_E2EE_CONTENT_" + ${JSON.stringify(runId)};

// Clear local e2e-* files so migration scope is fast & focused on our E2EE test notes
const rootList = await app.vault.adapter.list("");
for (const f of rootList.files) {
  if (f.startsWith("e2e-")) await removeLocalPath(f);
}
await removeLocalPath("e2e-dir");
await removeLocalPath("attachments");

plugin.settings.remoteBasePath = e2eeBase;
plugin.settings.syncObsidianConfig = false;
plugin.settings.enableE2EE = true;
plugin.settings.e2eePassword = e2eePass;
await plugin.saveSettings();
await plugin.engine.resetLocalBaseline();

// 1. Upload encrypted file
await writeLocalText("e2e-secret.md", secretMarker);
let res = await plugin.engine.startSync(false);
assertTrue(res.success && res.stats.uploaded >= 1, "E2EE upload sync failed: " + JSON.stringify(res));

// 2. Fetch raw remote bytes directly and verify E2EE v2 magic header ("BDSYNC_E2EE" + 0x02) & zero plaintext leak
const rawCipherBuf = await remoteDownloadRaw(plugin, e2eeBase, "e2e-secret.md");
const rawBytes = new Uint8Array(rawCipherBuf);
const magicStr = new TextDecoder().decode(rawBytes.slice(0, 11));
assertTrue(magicStr === "BDSYNC_E2EE" && rawBytes[11] === 0x02, "Remote file is NOT E2EE v2 format! magic=" + magicStr + " ver=" + rawBytes[11]);
const rawDecoded = new TextDecoder().decode(rawBytes);
assertTrue(!rawDecoded.includes(secretMarker), "Plaintext secret leaked into remote E2EE file!");

// 3. Delete local file & reset manifest -> pull -> verify exact decrypted plaintext
await removeLocalPath("e2e-secret.md");
await plugin.engine.resetLocalBaseline();
res = await plugin.engine.startSync(false);
assertTrue(res.success && res.stats.downloaded >= 1, "E2EE download/decrypt sync failed: " + JSON.stringify(res));
assertTrue((await app.vault.adapter.read("e2e-secret.md")) === secretMarker, "Decrypted content mismatch!");

// 4. Wrong password guard: must fail decryption and NOT write corrupted ciphertext to disk
await removeLocalPath("e2e-secret.md");
await plugin.engine.resetLocalBaseline();
plugin.settings.e2eePassword = "WRONG_E2EE_PASSWORD";
await plugin.saveSettings();
res = await plugin.engine.startSync(false);
assertTrue(!res.success && res.stats.errors >= 1, "Wrong E2EE password must fail download with error");
assertTrue(!(await app.vault.adapter.exists("e2e-secret.md")), "Failed E2EE decrypt must NOT write ciphertext to local disk");

// Restore correct password & pull back
plugin.settings.e2eePassword = e2eePass;
await plugin.saveSettings();
res = await plugin.engine.startSync(false);
assertTrue(res.success, "Re-pull with restored E2EE password failed");
assertTrue((await app.vault.adapter.read("e2e-secret.md")) === secretMarker, "Restored plaintext mismatch");

// 5. Verify DecryptMigrationModal opens from Settings Tab, then run one-click convertVaultToPlaintext
app.setting.open();
app.setting.openTabById("${PLUGIN_ID}");
await sleep(250);
const tabEl = app.setting.activeTab.containerEl;
const allBtns = Array.from(tabEl.querySelectorAll("button"));
const migrationBtn = allBtns[allBtns.length - 1];
assertTrue(Boolean(migrationBtn), "Missing DecryptMigrationModal button in Settings Section 7");
migrationBtn.click();
await sleep(250);
const migModal = document.querySelector(".modal-container .modal .baidu-sync-migration-status");
assertTrue(Boolean(migModal), "DecryptMigrationModal failed to render");
closeAllModalsAndSettings();

const migRes = await plugin.engine.convertVaultToPlaintext();
assertTrue(migRes.success && migRes.errors === 0, "convertVaultToPlaintext failed: " + JSON.stringify(migRes));

// Disable E2EE after migration & verify remote is now true readable plaintext
plugin.settings.enableE2EE = false;
plugin.settings.e2eePassword = "";
await plugin.saveSettings();

const rawPlainBuf = await remoteDownloadRaw(plugin, e2eeBase, "e2e-secret.md");
const rawPlainText = new TextDecoder().decode(new Uint8Array(rawPlainBuf));
assertTrue(rawPlainText === secretMarker, "Remote file after plaintext migration does not match expected plaintext!");

return {
  summary: "E2EE v2 header verified, roundtrip decrypt ok, wrong password blocked, plaintext migration verified",
  migratedFiles: migRes.total
};
`,
        240000
      );
      return d8;
    });

    // ── D9: Mobile Emulation, UI Layout & Log Secret Sanitization ──────────
    await runDomain("D9", "Mobile Emulation UI Check & Log/Console Secret Sanitization Audit", async () => {
      obsidianCli(vaultName, ["dev:mobile", "on"], 15000);
      try {
        obsidianEvalJson(
          vaultName,
          `
${REMOTE_HELPER_JS}
closeAllModalsAndSettings();
await sleep(250);
app.setting.open();
app.setting.openTabById("${PLUGIN_ID}");
await sleep(350);
const tabEl = app.setting.activeTab?.containerEl;
assertTrue(Boolean(tabEl), "Settings tab failed to render in mobile emulation");
const headings = tabEl.querySelectorAll(".setting-item-heading");
assertTrue(headings.length >= 7, "Expected >=7 headings in mobile settings view");
return true;
`
        );

        const mobileShot = captureScreenshot(vaultName, resolve(reportDir, "mobile-settings.png"));
        if (mobileShot) screenshots.mobileSettings = mobileShot;

        obsidianEvalJson(
          vaultName,
          `
${REMOTE_HELPER_JS}
closeAllModalsAndSettings();
await sleep(150);
app.commands.executeCommandById("${PLUGIN_ID}:baidu-sync-view-logs");
await sleep(250);
assertTrue(Boolean(document.querySelector(".baidu-sync-log-modal")), "SyncLogModal failed to render in mobile emulation");
closeAllModalsAndSettings();
return true;
`
        );
      } finally {
        obsidianCli(vaultName, ["dev:mobile", "off"], 15000);
      }

      // Secret sanitization audit across plugin logs + Obsidian console + dev:errors
      const secretAudit = obsidianEvalJson(
        vaultName,
        `
${REMOTE_HELPER_JS}
const plugin = getPlugin();
const logs = plugin.engine.getLogs();
const forbidden = ${JSON.stringify(secretsToRedact)}.filter((s) => typeof s === "string" && s.length >= 6);
const leaked = [];
for (const entry of logs) {
  const hay = (entry.message || "") + " " + (entry.detail || "");
  for (const sec of forbidden) {
    if (hay.includes(sec)) {
      leaked.push(entry.level + ":" + entry.message.slice(0, 60));
    }
  }
}
assertTrue(leaked.length === 0, "Secret leaked in plugin sync logs! Count=" + leaked.length);
return { totalLogsAudited: logs.length };
`
      );

      const consoleOut = obsidianCli(vaultName, ["dev:console", "limit=200"], 15000);
      for (const sec of secretsToRedact) {
        if (sec && sec.length >= 6 && consoleOut.includes(sec)) {
          throw new Error("Sensitive secret leaked into Obsidian developer console!");
        }
      }

      const errorsOut = obsidianCli(vaultName, ["dev:errors"], 15000);
      if (errorsOut && !errorsOut.includes("No errors captured")) {
        throw new Error(`Uncaught Obsidian runtime errors detected:\n${sanitizeText(errorsOut, secretsToRedact)}`);
      }

      return {
        summary: `mobile UI rendered cleanly, ${secretAudit.totalLogsAudited} sync logs & console audited (0 secret leaks, 0 uncaught errors)`
      };
    });
  } finally {
    // ── Guaranteed Zero-Trace Teardown & Verification ──────────────────────
    console.log(`\n${colors.dim}🧹 Restoring test vault settings & performing zero-trace cleanup...${colors.reset}`);
    try {
      obsidianCli(vaultName, ["dev:mobile", "off"], 15000);
    } catch {
      // ignore
    }

    const clipRes = clearPairingClipboardIfNeeded();
    cleanupReport.clipboardCleared = clipRes.cleared;

    try {
      const teardownRes = obsidianEvalJson(
        vaultName,
        `
${REMOTE_HELPER_JS}
closeAllModalsAndSettings();
const plugin = getPlugin();
const runBase = ${JSON.stringify(runRemoteBase)};
const altBase = ${JSON.stringify(altRemoteBase)};
const keep = ${JSON.stringify(keepArtifacts)};
const orig = ${JSON.stringify(originalSettingsSnapshot)};
const hadSnippetsDir = ${JSON.stringify(Boolean(preflight.hadSnippetsDir))};
const hadTrashDir = ${JSON.stringify(Boolean(preflight.hadTrashDir))};
const hadAttachmentsDir = ${JSON.stringify(Boolean(preflight.hadAttachmentsDir))};

let localResidual = [];
let remoteResidual = [];

// Delete remote & local test artifacts unless --keep-artifacts
if (!keep) {
  for (const dir of [runBase, altBase]) {
    try {
      await plugin.client.deleteFiles([dir]);
    } catch {
      // ignore if already absent
    }
  }

  // Delete local E2E artifacts created in test vault
  const rootList = await app.vault.adapter.list("");
  for (const f of rootList.files) {
    if (f.startsWith("e2e-")) await removeLocalPath(f);
  }
  await removeLocalPath("e2e-dir");
  if (!hadAttachmentsDir) {
    await removeLocalPath("attachments");
  } else {
    await removeLocalPath("attachments/e2e-local-skip.bin");
  }

  const configDir = app.vault.configDir;
  await removeLocalPath(configDir + "/snippets/e2e-snippet.css");
  if (!hadSnippetsDir && (await app.vault.adapter.exists(configDir + "/snippets"))) {
    const sList = await app.vault.adapter.list(configDir + "/snippets");
    if (sList.files.length === 0 && sList.folders.length === 0) {
      await removeLocalPath(configDir + "/snippets");
    }
  }
  await removeLocalPath(configDir + "/plugins/e2e-dummy");

  if (await app.vault.adapter.exists(".trash")) {
    const trashList = await app.vault.adapter.list(".trash");
    for (const tf of trashList.files) {
      if (tf.includes("e2e-") || tf.includes("nested-renamed")) await removeLocalPath(tf);
    }
    for (const td of trashList.folders) {
      if (td.includes("e2e-")) await removeLocalPath(td);
    }
    if (!hadTrashDir) {
      const trashAfter = await app.vault.adapter.list(".trash");
      if (trashAfter.files.length === 0 && trashAfter.folders.length === 0) {
        await removeLocalPath(".trash");
      }
    }
  }
}

// Restore original test vault settings while PRESERVING any refreshed OAuth token!
const live = plugin.settings;
plugin.settings = {
  ...orig,
  accessToken: live.accessToken || orig.accessToken,
  refreshToken: live.refreshToken || orig.refreshToken,
  tokenExpiresAt: live.tokenExpiresAt || orig.tokenExpiresAt
};
await plugin.saveSettings();
plugin.resetInterval();

if (!keep) {
  await plugin.engine.resetLocalBaseline();
  const pluginDir = plugin.manifest.dir || (app.vault.configDir + "/plugins/${PLUGIN_ID}");
  await removeLocalPath(pluginDir + "/sync_manifest.json.bak");

  // Post-cleanup empirical verification (local + remote)
  const rootAfter = await app.vault.adapter.list("");
  localResidual = [
    ...rootAfter.files.filter((f) => f.startsWith("e2e-")),
    ...rootAfter.folders.filter((d) => d === "e2e-dir" || (!hadAttachmentsDir && d === "attachments"))
  ];
  for (const dir of [runBase, altBase]) {
    try {
      const rem = await plugin.client.listAll(dir);
      for (const item of rem) remoteResidual.push(item.path);
    } catch {
      // directory not found -> cleanly deleted
    }
  }
}

return {
  restored: true,
  cleaned: !keep,
  localResidual,
  remoteResidual
};
`,
        90000
      );

      // Reload plugin & clear Obsidian dev buffers so test vault returns to pristine idle state
      try {
        obsidianCli(vaultName, ["plugin:reload", `id=${PLUGIN_ID}`], 30000);
        obsidianCli(vaultName, ["dev:errors", "clear"], 15000);
        obsidianCli(vaultName, ["dev:console", "clear"], 15000);
      } catch {
        // ignore
      }

      cleanupReport = {
        executed: true,
        keepArtifacts,
        verified:
          keepArtifacts ||
          (teardownRes.localResidual.length === 0 && teardownRes.remoteResidual.length === 0),
        localResidualCount: teardownRes.localResidual.length,
        remoteResidualCount: teardownRes.remoteResidual.length,
        clipboardCleared: clipRes.cleared,
        error: ""
      };
      console.log(
        `${colors.dim}   Zero-trace cleanup ${cleanupReport.verified ? "verified" : "INCOMPLETE"}: localResidual=${cleanupReport.localResidualCount}, remoteResidual=${cleanupReport.remoteResidualCount}, clipboard=${clipRes.cleared ? "cleared" : "clean"}${colors.reset}`
      );
    } catch (cleanupErr) {
      const cleanMsg = sanitizeText(
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        secretsToRedact
      );
      cleanupReport.error = cleanMsg;
      console.warn(`${colors.yellow}⚠️  Cleanup warning: ${cleanMsg}${colors.reset}`);
    }
  }

  // ── Generate Sanitized Reports (JSON + Markdown) ─────────────────────────
  const passedCount = results.filter((r) => r.status === "PASS").length;
  const failedCount = results.filter((r) => r.status === "FAIL").length;
  const cleanupOk = keepArtifacts || cleanupReport.verified;
  const allPassed = failedCount === 0 && results.length === 9 && cleanupOk;

  const reportPayload = {
    runId,
    timestamp: new Date().toISOString(),
    pluginId: PLUGIN_ID,
    pluginVersion: localManifest.version,
    obsidianVersion,
    vaultName,
    remoteBase: allowedRemoteBase,
    overall: allPassed ? "PASS" : "FAIL",
    passed: passedCount,
    failed: failedCount,
    total: results.length,
    cleanup: cleanupReport,
    screenshots,
    domains: results
  };

  const jsonPath = resolve(reportDir, "report.json");
  const mdPath = resolve(reportDir, "report.md");
  writeFileSync(jsonPath, JSON.stringify(reportPayload, null, 2) + "\n", "utf-8");

  const mdLines = [
    `# Local Obsidian Full 9-Domain E2E Test Report (${runId})`,
    "",
    `- **Overall Status**: ${allPassed ? "✅ PASS (9/9 + Zero-Trace Cleanup Verified)" : `❌ FAIL (${passedCount}/${results.length} passed, cleanupVerified=${cleanupReport.verified})`}`,
    `- **Plugin Version**: \`${localManifest.version}\``,
    `- **Obsidian Version**: \`${obsidianVersion}\``,
    `- **Test Vault**: \`${vaultName}\``,
    `- **Remote Test Base**: \`${allowedRemoteBase}\``,
    `- **Zero-Trace Cleanup**: ${keepArtifacts ? "Skipped (`--keep-artifacts`)" : cleanupReport.verified ? "✅ Verified (local=0, remote=0, plugin reloaded)" : `❌ Incomplete (local=${cleanupReport.localResidualCount}, remote=${cleanupReport.remoteResidualCount}${cleanupReport.error ? `, err=${cleanupReport.error}` : ""})`}`,
    `- **Executed At**: ${reportPayload.timestamp}`,
    "",
    "## Domain Results",
    "",
    "| Domain | Scope | Status | Duration | Notes |",
    "| :--- | :--- | :---: | ---: | :--- |"
  ];

  for (const r of results) {
    const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
    const note =
      r.status === "PASS"
        ? (r.details?.summary || "OK").replace(/\|/g, "\\|")
        : `ERROR: ${(r.error || "").replace(/\n/g, " ").replace(/\|/g, "\\|")}`;
    mdLines.push(`| ${r.id} | ${r.title} | ${r.status === "PASS" ? "✅ PASS" : "❌ FAIL"} | ${dur} | ${note} |`);
  }

  mdLines.push("", "## Captured Screenshots", "");
  if (Object.keys(screenshots).length === 0) {
    mdLines.push("- (No screenshots captured)");
  } else {
    for (const [k, p] of Object.entries(screenshots)) {
      mdLines.push(`- **${k}**: \`${p}\``);
    }
  }
  mdLines.push(
    "",
    "> After reviewing this report and screenshots, run `npm run test:obsidian -- --cleanup-only` to purge `dist/e2e-reports/` and confirm zero residual test traces.",
    ""
  );
  writeFileSync(mdPath, mdLines.join("\n"), "utf-8");

  // ── Print Terminal Summary ───────────────────────────────────────────────
  console.log("\n" + "=".repeat(72));
  const badge = allPassed
    ? `${colors.bgGreen}${colors.bold} ALL 9 DOMAINS PASSED (${passedCount}/9) + ZERO-TRACE CLEANUP ${colors.reset}`
    : `${colors.bgRed}${colors.bold} E2E FAILED (${passedCount}/${results.length} PASSED, ${failedCount} FAILED, CLEANUP=${cleanupOk ? "OK" : "FAIL"}) ${colors.reset}`;
  console.log(`🏁 Result     : ${badge}`);
  console.log(
    `🧹 Cleanup    : ${keepArtifacts ? "kept (--keep-artifacts)" : cleanupReport.verified ? "VERIFIED (local=0, remote=0)" : `FAILED (local=${cleanupReport.localResidualCount}, remote=${cleanupReport.remoteResidualCount})`}`
  );
  console.log(`📄 Report MD  : ${mdPath}`);
  console.log(`📊 Report JSON: ${jsonPath}`);
  for (const [k, p] of Object.entries(screenshots)) {
    console.log(`🖼️  Screenshot : [${k}] ${p}`);
  }
  console.log("=".repeat(72) + "\n");

  if (!allPassed) {
    console.error(`${colors.red}🚫 Release Gate BLOCKED: Fix failing domain(s) / cleanup residual and re-run npm run test:obsidian before release.${colors.reset}\n`);
    process.exit(1);
  }

  console.log(`${colors.green}✨ Ready for human visual review & sign-off. After approval, run: npm run test:obsidian -- --cleanup-only${colors.reset}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${colors.red}Fatal E2E runner error:${colors.reset}`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
