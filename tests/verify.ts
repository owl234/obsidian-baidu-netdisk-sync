import assert from "assert";

// Provide minimal browser timer shim for Node test runner (matches Obsidian renderer window API)
if (typeof window === "undefined") {
  (globalThis as unknown as { window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } }).window = {
    setTimeout,
    clearTimeout
  };
}
import { md5 } from "../src/crypto/md5";
import { SyncPlanner, LocalFileInfo, RemoteFileInfo, buildConflictPath } from "../src/sync/planner";
import { SyncFilter, globToRegex } from "../src/sync/filter";
import { AsyncQueue, QueueCancelledError } from "../src/sync/queue";
import { ManifestManager, ManifestStorageAdapter } from "../src/sync/manifest";
import {
  REMOTE_TOMBSTONE_DIR_REL,
  TombstoneManager,
  buildRemoteTombstonePath,
  extractTombstoneDeviceId,
  generateDeviceId,
  isValidDeviceId
} from "../src/sync/tombstone";
import { SyncEngine, VaultSyncBridge, normalizeAndValidateRemoteBasePath } from "../src/sync/engine";
import { OperationTimeoutError } from "../src/sync/timeout";
import { BaiduSyncSettings, DEFAULT_SETTINGS } from "../src/settings/settings";
import { exportEncryptedConfig, importEncryptedConfig } from "../src/crypto/configShare";
import {
  encryptData,
  decryptData,
  deriveKey,
  clearKeyCache,
  getEncryptionVersion,
  LEGACY_PBKDF2_ITERATIONS,
  isEncrypted
} from "../src/crypto/e2ee";
import { BaiduOAuthManager } from "../src/baidu/oauth";
import { BaiduClient } from "../src/baidu/client";
import { BaiduUploader } from "../src/baidu/uploader";
import { BaiduDownloader } from "../src/baidu/downloader";
import {
  HttpRequestFn,
  HttpRequestParam,
  HttpResponse,
  parseJsonPreserveIds,
  sanitizeErrorMessage
} from "../src/baidu/types";
import { initLocale, t } from "../src/i18n";
import { en } from "../src/i18n/en";
import { zh } from "../src/i18n/zh";

function makeJsonResponse(obj: unknown, status = 200, rawText?: string): HttpResponse {
  const text = rawText ?? JSON.stringify(obj);
  const bytes = new TextEncoder().encode(text);
  return {
    status,
    headers: { "content-type": "application/json" },
    arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text
  };
}

function makeBinaryResponse(buf: ArrayBuffer, contentType = "application/octet-stream", status = 200): HttpResponse {
  return {
    status,
    headers: { "content-type": contentType },
    arrayBuffer: buf,
    get text(): string {
      throw new Error("Binary download must NOT access resp.text / resp.json!");
    }
  };
}

const zeroDelay = async () => Promise.resolve();

function createMemoryVault(configDir = ".obsidian") {
  const files = new Map<string, { data: ArrayBuffer; mtime: number }>();
  const folders = new Set<string>([""]);
  const trashed: string[] = [];

  const ensureParentFolders = (path: string) => {
    const parts = path.split("/");
    parts.pop();
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      folders.add(cur);
    }
  };

  const bridge: VaultSyncBridge & ManifestStorageAdapter & {
    files: typeof files;
    trashed: string[];
    listCalls: string[];
    seedFile: (path: string, content: string | ArrayBuffer, mtime?: number) => void;
    readText: (path: string) => string;
  } = {
    configDir,
    files,
    trashed,
    listCalls: [],
    seedFile(path: string, content: string | ArrayBuffer, mtime = Date.now()) {
      ensureParentFolders(path);
      const data = typeof content === "string"
        ? new TextEncoder().encode(content).slice().buffer
        : content;
      files.set(path, { data, mtime });
    },
    readText(path: string): string {
      const entry = files.get(path);
      if (!entry) throw new Error(`Missing file: ${path}`);
      return new TextDecoder().decode(entry.data);
    },
    async exists(path: string): Promise<boolean> {
      return files.has(path) || folders.has(path);
    },
    async stat(path: string) {
      const f = files.get(path);
      if (f) return { type: "file", mtime: f.mtime, size: f.data.byteLength };
      if (folders.has(path)) return { type: "folder", mtime: 0, size: 0 };
      return null;
    },
    async list(dir: string) {
      bridge.listCalls.push(dir);
      const prefix = dir ? `${dir}/` : "";
      const directFiles: string[] = [];
      const directFolders = new Set<string>();

      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) {
          directFiles.push(path);
        } else {
          directFolders.add(prefix + rest.slice(0, slash));
        }
      }
      for (const f of folders) {
        if (!f || !f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        if (rest && !rest.includes("/")) {
          directFolders.add(f);
        }
      }
      return { files: directFiles, folders: Array.from(directFolders) };
    },
    async mkdir(path: string): Promise<void> {
      folders.add(path);
    },
    async readBinary(path: string): Promise<ArrayBuffer> {
      const f = files.get(path);
      if (!f) throw new Error(`File not found: ${path}`);
      return f.data.slice(0);
    },
    async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
      ensureParentFolders(path);
      files.set(path, { data: data.slice(0), mtime: Date.now() });
    },
    async read(path: string): Promise<string> {
      return bridge.readText(path);
    },
    async write(path: string, data: string): Promise<void> {
      ensureParentFolders(path);
      const buf = new TextEncoder().encode(data).slice().buffer;
      files.set(path, { data: buf, mtime: Date.now() });
    },
    async trashFile(path: string): Promise<void> {
      files.delete(path);
      trashed.push(path);
    }
  };

  return bridge;
}

function testMD5() {
  console.log("-> Testing MD5...");
  const enc = new TextEncoder();

  assert.strictEqual(md5(enc.encode("")), "d41d8cd98f00b204e9800998ecf8427e");
  assert.strictEqual(md5(enc.encode("hello world")), "5eb63bbbe01eeed093cb22bb8f5acdc3");

  const largeBuf = new Uint8Array(4 * 1024 * 1024);
  largeBuf.fill(0x42);
  const largeHash = md5(largeBuf);
  assert.strictEqual(largeHash.length, 32);
  console.log("   MD5 tests passed!");
}

function testI18n() {
  console.log("-> Testing i18n key parity & interpolation...");
  const enKeys = Object.keys(en).sort();
  const zhKeys = Object.keys(zh).sort();
  assert.deepStrictEqual(enKeys, zhKeys, "EN and ZH translation keys must match 100%");

  initLocale("en-US");
  assert.strictEqual(t("command.syncNow"), "Sync now");
  assert.strictEqual(t("engine.planReady", { count: 7 }), "Sync plan ready. Pending operations: 7");

  initLocale("zh-CN");
  assert.strictEqual(t("command.syncNow"), "立即执行同步");
  assert.strictEqual(t("engine.planReady", { count: 7 }), "规划完成，待执行操作数: 7");
  console.log("   i18n tests passed!");
}

function testFilter() {
  console.log("-> Testing SyncFilter (configDir, snippets, glob boundary, plugin self-exclusion)...");
  const filter = new SyncFilter(DEFAULT_SETTINGS, ".obsidian", ".obsidian/plugins/baidu-netdisk-sync");

  // Plugin's own folder & manifest must be ignored
  assert.strictEqual(filter.shouldIgnore(".obsidian/plugins/baidu-netdisk-sync/data.json"), true);
  assert.strictEqual(filter.shouldIgnore(".obsidian/plugins/baidu-netdisk-sync/sync_manifest.json"), true);
  assert.strictEqual(filter.shouldIgnore(".obsidian/plugins/obsidian-baidu-netdisk-sync/main.js"), true);
  assert.strictEqual(filter.shouldIgnore("sync_manifest.json"), true);

  // Regular user note mentioning plugin name MUST NOT be ignored!
  assert.strictEqual(filter.shouldIgnore("Notes/baidu-netdisk-sync-guide.md"), false);
  assert.strictEqual(filter.shouldIgnore("Projects/obsidian-baidu-netdisk-sync-review.md"), false);

  // Trash & git
  assert.strictEqual(filter.shouldIgnore(".trash"), true);
  assert.strictEqual(filter.shouldIgnore(".trash/some-note.md"), true);
  assert.strictEqual(filter.shouldIgnore(".git"), true);
  assert.strictEqual(filter.shouldIgnore(".git/config"), true);

  // Workspace boundary check (globToRegex fix: **/ must not match partial filename)
  assert.strictEqual(filter.shouldIgnore(".obsidian/workspace.json"), true);
  assert.strictEqual(filter.shouldIgnore(".obsidian/workspace-mobile.json"), true);
  assert.strictEqual(filter.shouldIgnore("workspace-custom.json"), true);
  assert.strictEqual(filter.shouldIgnore("Notes/my-workspace.json"), false);
  assert.strictEqual(globToRegex("**/workspace*.json").test("my-workspace.json"), false);

  // Config directory toggling & folder-level pruning
  const noConfigFilter = new SyncFilter({ ...DEFAULT_SETTINGS, syncObsidianConfig: false }, ".obsidian");
  assert.strictEqual(noConfigFilter.shouldIgnore(".obsidian"), true);
  assert.strictEqual(noConfigFilter.shouldIgnore(".obsidian/app.json"), true);

  const noPluginsFilter = new SyncFilter({ ...DEFAULT_SETTINGS, syncPlugins: false }, ".obsidian");
  assert.strictEqual(noPluginsFilter.shouldIgnore(".obsidian/plugins"), true);
  assert.strictEqual(noPluginsFilter.shouldIgnore(".obsidian/plugins/dataview/main.js"), true);
  assert.strictEqual(noPluginsFilter.shouldIgnore(".obsidian/app.json"), false);

  // syncThemes must cover BOTH themes and snippets
  const noThemesFilter = new SyncFilter({ ...DEFAULT_SETTINGS, syncThemes: false }, ".obsidian");
  assert.strictEqual(noThemesFilter.shouldIgnore(".obsidian/themes"), true);
  assert.strictEqual(noThemesFilter.shouldIgnore(".obsidian/themes/Minimal/theme.css"), true);
  assert.strictEqual(noThemesFilter.shouldIgnore(".obsidian/snippets"), true);
  assert.strictEqual(noThemesFilter.shouldIgnore(".obsidian/snippets/custom.css"), true);

  // Regular notes & custom patterns (global + device-only localIgnoredPatterns)
  assert.strictEqual(filter.shouldIgnore("Notes/Daily.md"), false);
  const customFilter = new SyncFilter(
    {
      ...DEFAULT_SETTINGS,
      ignoredPatterns: "**/*.secret\ntemp/**",
      localIgnoredPatterns: "**/attachments/**\n**/*.mp4"
    },
    ".obsidian"
  );
  assert.strictEqual(customFilter.shouldIgnore("sub/test.secret"), true);
  assert.strictEqual(customFilter.shouldIgnore("temp/file.txt"), true);
  assert.strictEqual(customFilter.shouldIgnore("temp2/file.txt"), false);
  assert.strictEqual(customFilter.shouldIgnore("attachments/photo.png"), true);
  assert.strictEqual(customFilter.shouldIgnore("Media/attachments/clip.jpg"), true);
  assert.strictEqual(customFilter.shouldIgnore("Videos/demo.mp4"), true);
  assert.strictEqual(customFilter.shouldIgnore("Notes/keep.md"), false);

  console.log("   SyncFilter tests passed!");
}

function testPlanner() {
  console.log("-> Testing SyncPlanner (Conflict Copy, LWW, Manifestless MD5 Dedup, Deletions)...");
  const remoteBasePath = "/apps/obsidian_vault";

  // buildConflictPath
  const sampleDate = new Date(2026, 10, 21, 18, 5, 9);
  assert.strictEqual(buildConflictPath("Notes/Daily.md", sampleDate), "Notes/Daily.conflict-20261121-180509.md");
  assert.strictEqual(buildConflictPath("README", sampleDate), "README.conflict-20261121-180509");
  assert.strictEqual(buildConflictPath(".obsidian/app.json", sampleDate), ".obsidian/app.conflict-20261121-180509.json");

  // Scenario 1: Brand new local file -> UPLOAD
  {
    const local = new Map<string, LocalFileInfo>([["new.md", { path: "new.md", mtime: 1000, size: 50 }]]);
    const plans = SyncPlanner.plan(local, new Map(), {}, remoteBasePath);
    assert.strictEqual(plans.length, 1);
    assert.strictEqual(plans[0].action, "UPLOAD");
  }

  // Scenario 2: Brand new remote file -> DOWNLOAD
  {
    const remote = new Map<string, RemoteFileInfo>([
      ["remote.md", { path: "remote.md", remotePath: "/apps/obsidian_vault/remote.md", mtime: 2000, size: 100, fsId: "123" }]
    ]);
    const plans = SyncPlanner.plan(new Map(), remote, {}, remoteBasePath);
    assert.strictEqual(plans.length, 1);
    assert.strictEqual(plans[0].action, "DOWNLOAD");
  }

  // Scenario 3: Manifestless identical plaintext MD5 + size -> UPDATE_MANIFEST (no transfer)
  {
    const local = new Map<string, LocalFileInfo>([
      ["same.md", { path: "same.md", mtime: 5000, size: 50, md5: "5eb63bbbe01eeed093cb22bb8f5acdc3" }]
    ]);
    const remote = new Map<string, RemoteFileInfo>([
      ["same.md", { path: "same.md", remotePath: "/apps/obsidian_vault/same.md", mtime: 2000, size: 50, fsId: "100", md5: "5eb63bbbe01eeed093cb22bb8f5acdc3" }]
    ]);
    const plans = SyncPlanner.plan(local, remote, {}, remoteBasePath, { conflictStrategy: "copy", enableE2EE: false });
    assert.strictEqual(plans.length, 1);
    assert.strictEqual(plans[0].action, "UPDATE_MANIFEST");
  }

  // Scenario 4: Concurrent edit conflict with default "copy" strategy -> CONFLICT
  {
    const local = new Map<string, LocalFileInfo>([["conflict.md", { path: "conflict.md", mtime: 5000, size: 80 }]]);
    const remote = new Map<string, RemoteFileInfo>([
      ["conflict.md", { path: "conflict.md", remotePath: "/apps/obsidian_vault/conflict.md", mtime: 4000, size: 70, fsId: "456" }]
    ]);
    const manifest = {
      "conflict.md": { path: "conflict.md", remotePath: "/apps/obsidian_vault/conflict.md", mtime: 1000, remoteMtime: 1000, md5: "abc", size: 60 }
    };
    const plans = SyncPlanner.plan(local, remote, manifest, remoteBasePath, { conflictStrategy: "copy" });
    assert.strictEqual(plans.length, 1);
    assert.strictEqual(plans[0].action, "CONFLICT");
    assert.strictEqual(plans[0].winner, "local");
  }

  // Scenario 5: Concurrent edit conflict with explicit "lww" strategy -> UPLOAD / DOWNLOAD
  {
    const local = new Map<string, LocalFileInfo>([["conflict.md", { path: "conflict.md", mtime: 3000, size: 80 }]]);
    const remote = new Map<string, RemoteFileInfo>([
      ["conflict.md", { path: "conflict.md", remotePath: "/apps/obsidian_vault/conflict.md", mtime: 6000, size: 70, fsId: "456" }]
    ]);
    const manifest = {
      "conflict.md": { path: "conflict.md", remotePath: "/apps/obsidian_vault/conflict.md", mtime: 1000, remoteMtime: 1000, md5: "abc", size: 60 }
    };
    const plans = SyncPlanner.plan(local, remote, manifest, remoteBasePath, { conflictStrategy: "lww" });
    assert.strictEqual(plans.length, 1);
    assert.strictEqual(plans[0].action, "DOWNLOAD");
  }

  // Scenario 6 & 7: Remote delete / Local delete
  {
    const manifest = {
      "del.md": { path: "del.md", remotePath: "/apps/obsidian_vault/del.md", mtime: 1000, remoteMtime: 1000, md5: "abc", size: 50 }
    };
    const p1 = SyncPlanner.plan(new Map([["del.md", { path: "del.md", mtime: 1000, size: 50 }]]), new Map(), manifest, remoteBasePath);
    assert.strictEqual(p1[0].action, "DELETE_LOCAL");

    const p2 = SyncPlanner.plan(new Map(), new Map([["del.md", { path: "del.md", remotePath: "/apps/obsidian_vault/del.md", mtime: 1000, size: 50, fsId: "789" }]]), manifest, remoteBasePath);
    assert.strictEqual(p2[0].action, "DELETE_REMOTE");
  }

  console.log("   SyncPlanner tests passed!");
}

async function testAsyncQueueConcurrency() {
  console.log("-> Testing AsyncQueue true concurrency & zero-polling waitAll...");
  const queue = new AsyncQueue(3);
  let active = 0;
  let maxObserved = 0;

  const promises = Array.from({ length: 6 }, () =>
    queue.add(async () => {
      active++;
      maxObserved = Math.max(maxObserved, active);
      await new Promise((r) => setTimeout(r, 25));
      active--;
    })
  );

  await Promise.all(promises);
  await queue.waitAll();
  assert.strictEqual(maxObserved, 3, `Expected max concurrency 3, observed ${maxObserved}`);
  assert.strictEqual(active, 0);

  // Verify clear() immediately rejects unstarted queued tasks with QueueCancelledError
  const cancelQueue = new AsyncQueue(1);
  let releaseFirst!: () => void;
  const firstDone = cancelQueue.add(
    () =>
      new Promise<string>((resolve) => {
        releaseFirst = () => resolve("first");
      })
  );
  const queuedTask = cancelQueue.add(async () => "never-runs");
  const clearedCount = cancelQueue.clear();
  assert.strictEqual(clearedCount, 1);
  await assert.rejects(() => queuedTask, (err: unknown) => err instanceof QueueCancelledError);
  releaseFirst();
  assert.strictEqual(await firstDone, "first");
  await cancelQueue.waitAll();

  console.log("   AsyncQueue concurrency & cancellation tests passed!");
}

async function testE2EEv2AndLegacyV1() {
  console.log("-> Testing E2EE v2 (cached master key + HKDF + AAD) & Legacy v1 fallback...");
  clearKeyCache();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const testPassword = "VaultSecretPassword!@#";
  const rawData = enc.encode(JSON.stringify({ plugin: "terminal", enabled: true })).slice().buffer;

  // 1. Encrypt with v2 and verify format version
  const enc1 = await encryptData(rawData, testPassword);
  assert.strictEqual(getEncryptionVersion(enc1), 2, "New encryptions must use v2 format");
  assert.strictEqual(isEncrypted(enc1), true);
  assert.strictEqual(dec.decode(await decryptData(enc1, testPassword)), dec.decode(rawData));

  // 2. Verify batch performance via cached master key (20 files should complete well under 1s!)
  const batchStart = Date.now();
  for (let i = 0; i < 20; i++) {
    const sample = enc.encode(`Note #${i} content`).slice().buffer;
    const cipher = await encryptData(sample, testPassword);
    const plain = await decryptData(cipher, testPassword);
    assert.strictEqual(dec.decode(plain), `Note #${i} content`);
  }
  const batchElapsed = Date.now() - batchStart;
  assert.ok(batchElapsed < 2000, `Expected fast HKDF batch (<2000ms), took ${batchElapsed}ms`);

  // 3. Header tamper detection (AAD authentication on v2 header)
  const tampered = new Uint8Array(enc1.slice(0));
  tampered[15] ^= 0xff; // Flip byte in masterSalt header
  let tamperRejected = false;
  try {
    await decryptData(tampered.buffer, testPassword);
  } catch {
    tamperRejected = true;
  }
  assert.ok(tamperRejected, "Tampered v2 header must fail GCM AAD authentication");

  // 4. Legacy v1 (100,000 iterations pre-v1.0.7) compatibility
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const legacyKey = await deriveKey(testPassword, salt, LEGACY_PBKDF2_ITERATIONS);
  const legacyCipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, legacyKey, rawData);
  const MAGIC_V1 = new Uint8Array([0x42, 0x44, 0x53, 0x59, 0x4e, 0x43, 0x5f, 0x45, 0x32, 0x45, 0x45, 0x01]);
  const legacyBuf = new Uint8Array(MAGIC_V1.length + salt.length + iv.length + legacyCipher.byteLength);
  legacyBuf.set(MAGIC_V1, 0);
  legacyBuf.set(salt, MAGIC_V1.length);
  legacyBuf.set(iv, MAGIC_V1.length + salt.length);
  legacyBuf.set(new Uint8Array(legacyCipher), MAGIC_V1.length + salt.length + iv.length);

  assert.strictEqual(getEncryptionVersion(legacyBuf.buffer), 1);
  assert.strictEqual(dec.decode(await decryptData(legacyBuf.buffer, testPassword)), dec.decode(rawData));

  // 5. Wrong password fails
  let wrongPwdFailed = false;
  try {
    await decryptData(enc1, "WrongPassword");
  } catch {
    wrongPwdFailed = true;
  }
  assert.ok(wrongPwdFailed, "Wrong password must fail decryption");
  clearKeyCache();

  console.log(`   E2EE v2 + legacy v1 tests passed! (20-file HKDF batch: ${batchElapsed}ms)`);
}

async function testConfigShare() {
  console.log("-> Testing ConfigShare (Multi-device encrypted export/import + downgrade defense)...");
  const dummySettings: BaiduSyncSettings = {
    ...DEFAULT_SETTINGS,
    appKey: "testAppKey123",
    appSecret: "testAppSecret456",
    accessToken: "fakeToken123456",
    refreshToken: "fakeRefresh789",
    tokenExpiresAt: 1735689600000,
    remoteBasePath: "/apps/test_sync",
    conflictStrategy: "copy",
    localIgnoredPatterns: "**/attachments/**\n**/*.mp4",
    maxFileSizeMB: 50,
    concurrency: 4,
    enableE2EE: true,
    e2eePassword: "MyMasterVaultPassword!"
  };

  const pin = "SafePin9876";
  const pairingCode = await exportEncryptedConfig(dummySettings, pin);
  assert.ok(pairingCode.startsWith("BDSYNC:v1:"));

  const imported = await importEncryptedConfig(pairingCode, pin);
  assert.strictEqual(imported.appKey, dummySettings.appKey);
  assert.strictEqual(imported.conflictStrategy, "copy");
  assert.strictEqual(imported.maxFileSizeMB, 50);
  assert.strictEqual(imported.e2eePassword, "MyMasterVaultPassword!");
  assert.strictEqual(
    "localIgnoredPatterns" in imported,
    false,
    "Device-only localIgnoredPatterns must NEVER be exported in pairing config"
  );

  // Wrong PIN
  await assert.rejects(() => importEncryptedConfig(pairingCode, "WrongPin"));

  // Plaintext downgrade attack blocked
  const fakePlain = Buffer.from(JSON.stringify({ remoteBasePath: "/hacked" })).toString("base64");
  await assert.rejects(() => importEncryptedConfig(`BDSYNC:v1:${fakePlain}`, "AnyPin"));

  console.log("   ConfigShare tests passed!");
}

async function testBaiduProtocolAndSafety() {
  console.log("-> Testing BaiduOAuth mutex, errno -6 fresh token retry, 64-bit fs_id, listall fallback, rapid upload & binary download...");

  // 1. 64-bit fs_id preservation & secret sanitization
  const rawBigFsIdJson = '{"errno":0,"list":[{"fs_id":1092837465123456789,"path":"/apps/vault/a.md"}]}';
  const parsed = parseJsonPreserveIds<{ list: Array<{ fs_id: string }> }>(rawBigFsIdJson);
  assert.strictEqual(parsed.list[0].fs_id, "1092837465123456789", "64-bit fs_id must not lose precision!");

  const redacted = sanitizeErrorMessage("Request failed https://pan.baidu.com/api?access_token=SECRET_TOK_123&foo=bar");
  assert.ok(!redacted.includes("SECRET_TOK_123") && redacted.includes("access_token=[REDACTED]"));

  // 2. OAuth concurrent refresh mutex + errno -6 retry uses NEW token in URL
  let settings: BaiduSyncSettings = {
    ...DEFAULT_SETTINGS,
    appKey: "k",
    appSecret: "s",
    accessToken: "OLD_TOKEN",
    refreshToken: "REF_TOKEN",
    tokenExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
  };
  let tokenRefreshCalls = 0;
  const seenListTokens: string[] = [];

  const mockHttp: HttpRequestFn = async (param: HttpRequestParam) => {
    if (param.url.includes("openapi.baidu.com/oauth/2.0/token")) {
      tokenRefreshCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return makeJsonResponse({
        access_token: "NEW_TOKEN",
        refresh_token: "REF_TOKEN_2",
        expires_in: 2592000,
        scope: "basic,netdisk"
      });
    }
    if (param.url.includes("method=listall")) {
      const m = param.url.match(/access_token=([^&]+)/);
      const tok = m ? decodeURIComponent(m[1]) : "";
      seenListTokens.push(tok);
      if (tok === "OLD_TOKEN") {
        return makeJsonResponse({ errno: -6 });
      }
      // Simulate listall unsupported (errno 2) to test automatic BFS fallback!
      return makeJsonResponse({ errno: 2 });
    }
    if (param.url.includes("method=list&")) {
      return makeJsonResponse(
        null,
        200,
        '{"errno":0,"list":[{"fs_id":1092837465123456789,"path":"/apps/obsidian_vault/note.md","server_filename":"note.md","size":12,"isdir":0,"server_mtime":1700000000,"server_ctime":1700000000,"md5":"abc"}]}'
      );
    }
    if (param.url.includes("method=filemetas")) {
      return makeJsonResponse(
        null,
        200,
        '{"errno":0,"list":[{"fs_id":1092837465123456789,"path":"/apps/obsidian_vault/note.md","server_filename":"note.md","size":12,"isdir":0,"category":6,"md5":"abc","dlink":"https://d.pcs.baidu.com/file/1"}]}'
      );
    }
    if (param.url.startsWith("https://d.pcs.baidu.com/file/1")) {
      // Binary response throws if resp.text is accessed!
      return makeBinaryResponse(new TextEncoder().encode("binary-safe!").slice().buffer);
    }
    if (param.url.includes("method=precreate")) {
      // Verify rapid-upload hashes were sent and test return_type=2 instant hit
      const body = String(param.body || "");
      assert.ok(body.includes("content-md5="), "precreate should send content-md5");
      assert.ok(body.includes("slice-md5="), "precreate should send slice-md5");
      return makeJsonResponse({
        errno: 0,
        return_type: 2,
        uploadid: "",
        block_list: [],
        info: {
          fs_id: "999888777666555444",
          path: "/apps/obsidian_vault/rapid.md",
          size: 5,
          mtime: 1700000100,
          md5: md5(new TextEncoder().encode("rapid"))
        }
      });
    }
    if (param.url.includes("pcs/superfile2")) {
      return makeJsonResponse({ error_code: 31066, error_msg: "slice failed" });
    }
    throw new Error(`Unexpected URL: ${param.url}`);
  };

  const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, mockHttp);
  const client = new BaiduClient(oauth, mockHttp, { delayFn: zeroDelay });

  // Fire 3 concurrent listAll calls while token is OLD_TOKEN -> must refresh ONCE and retry with NEW_TOKEN
  const [res1, res2, res3] = await Promise.all([
    client.listAll("/apps/obsidian_vault"),
    client.listAll("/apps/obsidian_vault"),
    client.listAll("/apps/obsidian_vault")
  ]);
  assert.strictEqual(tokenRefreshCalls, 1, `OAuth refresh mutex failed: called ${tokenRefreshCalls} times`);
  assert.ok(seenListTokens.includes("OLD_TOKEN"), "Initial request must use OLD_TOKEN before errno -6");
  assert.ok(seenListTokens.includes("NEW_TOKEN"), "Retry MUST send refreshed NEW_TOKEN in URL!");
  assert.strictEqual(res1[0].fs_id, "1092837465123456789");
  assert.strictEqual(res2.length, 1);
  assert.strictEqual(res3.length, 1);

  // Binary download MUST NOT access resp.text / JSON.parse
  const downloader = new BaiduDownloader(client);
  const downloaded = await downloader.downloadByFsId("1092837465123456789");
  assert.strictEqual(new TextDecoder().decode(downloaded), "binary-safe!");

  // Rapid upload (return_type === 2) succeeds without uploadSlice / createFile
  const uploader = new BaiduUploader(client);
  const rapidRes = await uploader.uploadFile("/apps/obsidian_vault/rapid.md", new TextEncoder().encode("rapid").slice().buffer);
  assert.strictEqual(rapidRes.fs_id, "999888777666555444");

  // uploadSlice must throw on PCS error_code even when HTTP 200
  await assert.rejects(
    () => client.uploadSlice("/apps/obsidian_vault/x.md", "uid", 0, new ArrayBuffer(4)),
    /31066/
  );

  console.log("   Baidu protocol & safety tests passed!");
}

async function testSyncEngineIntegration() {
  console.log("-> Testing SyncEngine end-to-end (concurrency, conflict copy, maxFileSize, batched delete, migration abort)...");
  const vault = createMemoryVault(".obsidian");
  const nowSec = Math.floor(Date.now() / 1000);

  // Seed local files:
  // 1. Conflict file (local modified vs remote modified)
  vault.seedFile("conflict.md", "local version", (nowSec + 10) * 1000);
  // 2. Oversized file (> 1 MB limit)
  vault.seedFile("huge.bin", new ArrayBuffer(2 * 1024 * 1024), nowSec * 1000);
  // 3. Normal file inside .obsidian to verify no double-scan
  vault.seedFile(".obsidian/app.json", '{"theme":"obsidian"}', nowSec * 1000);
  // 4. Three new local files to verify true concurrent uploads
  vault.seedFile("a.md", "file a", nowSec * 1000);
  vault.seedFile("b.md", "file b", nowSec * 1000);
  vault.seedFile("c.md", "file c", nowSec * 1000);

  // Seed manifest with conflict.md & two deleted-locally files (for batch delete test)
  const manifestMgr = new ManifestManager(vault, ".obsidian/plugins/baidu-netdisk-sync/sync_manifest.json");
  manifestMgr.set({
    path: "conflict.md",
    remotePath: "/apps/obsidian_vault/conflict.md",
    mtime: (nowSec - 100) * 1000,
    remoteMtime: (nowSec - 100) * 1000,
    md5: "old",
    size: 5,
    remoteSize: 5,
    fsId: "5001"
  });
  manifestMgr.set({
    path: "deleted1.md",
    remotePath: "/apps/obsidian_vault/deleted1.md",
    mtime: (nowSec - 50) * 1000,
    remoteMtime: (nowSec - 50) * 1000,
    md5: "d1",
    size: 4,
    remoteSize: 4,
    fsId: "5002"
  });
  manifestMgr.set({
    path: "deleted2.md",
    remotePath: "/apps/obsidian_vault/deleted2.md",
    mtime: (nowSec - 50) * 1000,
    remoteMtime: (nowSec - 50) * 1000,
    md5: "d2",
    size: 4,
    remoteSize: 4,
    fsId: "5003"
  });
  await manifestMgr.save();

  let settings: BaiduSyncSettings = {
    ...DEFAULT_SETTINGS,
    appKey: "k",
    appSecret: "s",
    accessToken: "VALID_TOK",
    refreshToken: "REF",
    tokenExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    conflictStrategy: "copy",
    concurrency: 3,
    maxFileSizeMB: 1
  };

  let activeUploads = 0;
  let maxConcurrentUploads = 0;
  const deleteBatches: string[][] = [];
  const uploadedPaths: string[] = [];
  let failListAll = false;

  const remoteStore = new Map<string, ArrayBuffer>([
    ["/apps/obsidian_vault/conflict.md", new TextEncoder().encode("remote version").slice().buffer]
  ]);

  const mockHttp: HttpRequestFn = async (param: HttpRequestParam) => {
    if (param.url.includes("method=listall")) {
      if (failListAll) {
        return makeJsonResponse({ errno: 50001 }, 500);
      }
      return makeJsonResponse({
        errno: 0,
        has_more: 0,
        list: [
          {
            fs_id: "5001",
            path: "/apps/obsidian_vault/conflict.md",
            server_filename: "conflict.md",
            size: 14,
            isdir: 0,
            server_mtime: nowSec + 5,
            server_ctime: nowSec,
            md5: "remote-md5"
          },
          {
            fs_id: "5002",
            path: "/apps/obsidian_vault/deleted1.md",
            server_filename: "deleted1.md",
            size: 4,
            isdir: 0,
            server_mtime: nowSec - 50,
            server_ctime: nowSec - 50,
            md5: "d1"
          },
          {
            fs_id: "5003",
            path: "/apps/obsidian_vault/deleted2.md",
            server_filename: "deleted2.md",
            size: 4,
            isdir: 0,
            server_mtime: nowSec - 50,
            server_ctime: nowSec - 50,
            md5: "d2"
          },
          // Should be excluded by strict prefix check!
          {
            fs_id: "9999",
            path: "/apps/obsidian_vault2/other.md",
            server_filename: "other.md",
            size: 5,
            isdir: 0,
            server_mtime: nowSec,
            server_ctime: nowSec,
            md5: "x"
          }
        ]
      });
    }
    if (param.url.includes("method=filemetas")) {
      return makeJsonResponse({
        errno: 0,
        list: [
          {
            fs_id: "5001",
            path: "/apps/obsidian_vault/conflict.md",
            server_filename: "conflict.md",
            size: 14,
            isdir: 0,
            category: 6,
            md5: "remote-md5",
            dlink: "https://d.pcs.baidu.com/conflict"
          }
        ]
      });
    }
    if (param.url.startsWith("https://d.pcs.baidu.com/conflict")) {
      return makeBinaryResponse(remoteStore.get("/apps/obsidian_vault/conflict.md")!.slice(0));
    }
    if (param.url.includes("method=filemanager&opera=delete")) {
      const params = new URLSearchParams(String(param.body || ""));
      const list = JSON.parse(params.get("filelist") || "[]") as string[];
      deleteBatches.push(list);
      return makeJsonResponse({ errno: 0 });
    }
    if (param.url.includes("method=precreate")) {
      activeUploads++;
      maxConcurrentUploads = Math.max(maxConcurrentUploads, activeUploads);
      await new Promise((r) => setTimeout(r, 25));
      activeUploads--;

      const params = new URLSearchParams(String(param.body || ""));
      const p = params.get("path") || "";
      uploadedPaths.push(p);
      return makeJsonResponse({
        errno: 0,
        return_type: 2,
        uploadid: "",
        block_list: [],
        info: {
          fs_id: String(Math.floor(Math.random() * 1e15)),
          path: p,
          size: Number(params.get("size") || 0),
          mtime: nowSec + 20,
          md5: params.get("content-md5") || ""
        }
      });
    }
    throw new Error(`Unexpected engine mock URL: ${param.url}`);
  };

  const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, mockHttp);
  const client = new BaiduClient(oauth, mockHttp, { delayFn: zeroDelay });
  const engine = new SyncEngine(
    vault,
    () => settings,
    async (s) => { settings = s; },
    client,
    manifestMgr,
    ".obsidian/plugins/baidu-netdisk-sync"
  );

  const res = await engine.startSync(false);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.stats.conflicts, 1, "Must detect and preserve 1 conflict");
  assert.strictEqual(res.stats.skipped, 1, "Must skip 2MB file exceeding 1MB limit");
  assert.strictEqual(res.stats.deleted, 2, "Must delete 2 remote files");
  assert.strictEqual(deleteBatches.length, 1, "Remote deletes must be batched into 1 API call!");
  assert.strictEqual(deleteBatches[0].length, 2);
  assert.ok(maxConcurrentUploads >= 2, `Expected parallel uploads >= 2, got ${maxConcurrentUploads}`);

  // Verify conflict copy preserved remote content while canonical kept local content
  assert.strictEqual(vault.readText("conflict.md"), "local version");
  const conflictCopyPath = Array.from(vault.files.keys()).find((p) => p.startsWith("conflict.conflict-"));
  assert.ok(conflictCopyPath, "Conflict backup copy must exist locally");
  assert.strictEqual(vault.readText(conflictCopyPath!), "remote version");
  assert.ok(engine.wasRecentlyWrittenBySync(conflictCopyPath!), "Engine must suppress echo for written conflict copy");

  // Verify .obsidian was NOT double-scanned
  const obsidianListCount = vault.listCalls.filter((d) => d === ".obsidian").length;
  assert.strictEqual(obsidianListCount, 1, `Expected .obsidian scanned once, scanned ${obsidianListCount} times`);

  // Verify strict prefix check ignored /apps/obsidian_vault2/other.md
  assert.strictEqual(vault.files.has("other.md"), false);

  // Verify convertVaultToPlaintext aborts cleanly on fatal step-1 error (when stats.errors === 0!)
  failListAll = true;
  const uploadsBeforeMigration = uploadedPaths.length;
  await assert.rejects(
    () => engine.convertVaultToPlaintext(),
    /pre-sync|预拉取/i,
    "Migration MUST abort when step 1 fails fatally"
  );
  assert.strictEqual(uploadedPaths.length, uploadsBeforeMigration, "Migration must NOT upload anything if step 1 failed");
  assert.strictEqual(engine.getState(), "error");

  console.log("   SyncEngine integration tests passed!");
}

async function testBridgeDeadlockCheckpointsAndFastScan() {
  console.log("-> Testing Issue #1 protections (tiered timeout, bridge probe circuit-breaker, incremental manifest checkpoints, re-entrancy guard, HTTP timeout retry, statFast)...");

  // 1. HTTP timeout retry in BaiduClient
  {
    let settings: BaiduSyncSettings = {
      ...DEFAULT_SETTINGS,
      appKey: "k",
      appSecret: "s",
      accessToken: "TOK",
      refreshToken: "REF",
      tokenExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
    };
    let attempts = 0;
    const flakyHttp: HttpRequestFn = async () => {
      attempts++;
      if (attempts === 1) {
        // Simulate hung HTTP socket on attempt 1
        return new Promise<HttpResponse>(() => {});
      }
      return makeJsonResponse({ errno: 0, has_more: 0, list: [] });
    };
    const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, flakyHttp);
    const client = new BaiduClient(oauth, flakyHttp, { delayFn: zeroDelay, requestTimeoutMs: 30 });
    const items = await client.listAll("/apps/obsidian_vault");
    assert.strictEqual(items.length, 0);
    assert.strictEqual(attempts, 2, "Hung HTTP request should time out and retry automatically");
  }

  // 2. ManifestManager.load() must rethrow OperationTimeoutError instead of silently wiping baseline
  {
    const hangingAdapter: ManifestStorageAdapter = {
      exists: () => new Promise<boolean>(() => {}),
      mkdir: async () => {},
      read: async () => "",
      write: async () => {}
    };
    const mgr = new ManifestManager(hangingAdapter, ".obsidian/plugins/baidu-netdisk-sync/sync_manifest.json", {
      adapterTimeoutMs: 25
    });
    await assert.rejects(
      () => mgr.load(),
      (err: unknown) => err instanceof OperationTimeoutError,
      "Manifest load timeout must not be swallowed as empty manifest"
    );
  }

  // 3. Single timed-out file on a healthy bridge: probe passes -> skip file, finish remaining uploads, use statFast
  {
    const baseVault = createMemoryVault(".obsidian");
    const nowSec = Math.floor(Date.now() / 1000);
    baseVault.seedFile("ok1.md", "hello 1", nowSec * 1000);
    baseVault.seedFile("slow.md", "stuck file", nowSec * 1000);
    baseVault.seedFile("ok2.md", "hello 2", nowSec * 1000);

    let rawStatCalls = 0;
    let fastStatCalls = 0;
    const instrumentedVault: VaultSyncBridge & ManifestStorageAdapter = {
      ...baseVault,
      stat: async (path: string) => {
        rawStatCalls++;
        return baseVault.stat(path);
      },
      statFast: async (path: string) => {
        fastStatCalls++;
        return baseVault.stat(path);
      },
      readBinary: async (path: string) => {
        if (path === "slow.md") {
          return new Promise<ArrayBuffer>(() => {});
        }
        return baseVault.readBinary(path);
      }
    };

    let settings: BaiduSyncSettings = {
      ...DEFAULT_SETTINGS,
      appKey: "k",
      appSecret: "s",
      accessToken: "TOK",
      refreshToken: "REF",
      tokenExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      syncObsidianConfig: false,
      concurrency: 2
    };

    const mockHttp: HttpRequestFn = async (param: HttpRequestParam) => {
      if (param.url.includes("method=listall")) {
        return makeJsonResponse({ errno: 0, has_more: 0, list: [] });
      }
      if (param.url.includes("method=precreate")) {
        const params = new URLSearchParams(String(param.body || ""));
        const p = params.get("path") || "";
        return makeJsonResponse({
          errno: 0,
          return_type: 2,
          uploadid: "",
          block_list: [],
          info: {
            fs_id: String(Math.floor(Math.random() * 1e12)),
            path: p,
            size: Number(params.get("size") || 0),
            mtime: nowSec + 5,
            md5: params.get("content-md5") || ""
          }
        });
      }
      throw new Error(`Unexpected URL: ${param.url}`);
    };

    const manifestPath = ".obsidian/plugins/baidu-netdisk-sync/sync_manifest.json";
    const manifestMgr = new ManifestManager(instrumentedVault, manifestPath, { adapterTimeoutMs: 100 });
    const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, mockHttp);
    const client = new BaiduClient(oauth, mockHttp, { delayFn: zeroDelay });
    const engine = new SyncEngine(
      instrumentedVault,
      () => settings,
      async (s) => { settings = s; },
      client,
      manifestMgr,
      ".obsidian/plugins/baidu-netdisk-sync",
      { fsMetaTimeoutMs: 40, fsBinaryTimeoutMs: 40, bridgeProbeTimeoutMs: 40 }
    );

    const res = await engine.startSync(false);
    assert.strictEqual(res.bridgeDead, undefined, "Healthy bridge probe must not trip circuit breaker");
    assert.strictEqual(res.stats.uploaded, 2, "Remaining healthy files must still upload");
    assert.strictEqual(res.stats.errors, 1, "Single timed-out file must be counted as 1 error");
    assert.strictEqual(engine.getState(), "idle", "Engine must return to idle after single-file timeout");
    assert.strictEqual(fastStatCalls, 3, "scanLocalFiles must use zero-IPC statFast");
    assert.strictEqual(rawStatCalls, 0, "Raw adapter.stat must NOT be called during fast local scan + upload");
  }

  // 4. Wedged Capacitor bridge deadlock + incremental manifest checkpoint + queue abort + resume + re-entrancy guard
  {
    const baseVault = createMemoryVault(".obsidian");
    const nowSec = Math.floor(Date.now() / 1000);
    for (let i = 1; i <= 10; i++) {
      const name = `f${String(i).padStart(2, "0")}.md`;
      baseVault.seedFile(name, `content-${i}`, nowSec * 1000);
    }

    let bridgeWedged = false;
    let readAttemptsAfterWedge = 0;
    let manifestWriteCount = 0;
    let uploadedCount = 0;
    const remoteItems = new Map<string, { fs_id: string; path: string; size: number; mtime: number; md5: string }>();

    const manifestPath = ".obsidian/plugins/baidu-netdisk-sync/sync_manifest.json";
    const wedgingVault: VaultSyncBridge & ManifestStorageAdapter = {
      ...baseVault,
      exists: async (path: string) => {
        if (bridgeWedged) return new Promise<boolean>(() => {});
        return baseVault.exists(path);
      },
      statFast: async (path: string) => baseVault.stat(path),
      readBinary: async (path: string) => {
        if (bridgeWedged) {
          readAttemptsAfterWedge++;
          return new Promise<ArrayBuffer>(() => {});
        }
        if (path === "f05.md") {
          bridgeWedged = true;
          return new Promise<ArrayBuffer>(() => {});
        }
        return baseVault.readBinary(path);
      },
      write: async (path: string, data: string) => {
        if (bridgeWedged) return new Promise<void>(() => {});
        if (path === manifestPath) manifestWriteCount++;
        return baseVault.write(path, data);
      }
    };

    let settings: BaiduSyncSettings = {
      ...DEFAULT_SETTINGS,
      appKey: "k",
      appSecret: "s",
      accessToken: "TOK",
      refreshToken: "REF",
      tokenExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      syncObsidianConfig: false,
      conflictStrategy: "lww",
      enableE2EE: true,
      e2eePassword: "TestE2eePassword!123",
      concurrency: 1
    };

    const mockHttp: HttpRequestFn = async (param: HttpRequestParam) => {
      if (param.url.includes("method=listall")) {
        return makeJsonResponse({
          errno: 0,
          has_more: 0,
          list: Array.from(remoteItems.values()).map((r) => ({
            fs_id: r.fs_id,
            path: r.path,
            server_filename: r.path.split("/").pop() || "",
            size: r.size,
            isdir: 0,
            server_mtime: r.mtime,
            server_ctime: r.mtime,
            md5: r.md5
          }))
        });
      }
      if (param.url.includes("method=precreate")) {
        await new Promise((r) => setTimeout(r, 5));
        const params = new URLSearchParams(String(param.body || ""));
        const p = params.get("path") || "";
        const size = Number(params.get("size") || 0);
        const contentMd5 = params.get("content-md5") || "";
        const fsId = String(100000 + ++uploadedCount);
        remoteItems.set(p, { fs_id: fsId, path: p, size, mtime: nowSec, md5: contentMd5 });
        return makeJsonResponse({
          errno: 0,
          return_type: 2,
          uploadid: "",
          block_list: [],
          info: { fs_id: fsId, path: p, size, mtime: nowSec, md5: contentMd5 }
        });
      }
      throw new Error(`Unexpected URL: ${param.url}`);
    };

    const manifestMgr = new ManifestManager(wedgingVault, manifestPath, {
      adapterTimeoutMs: 50,
      checkpointItemThreshold: 3,
      checkpointIntervalMs: 60_000
    });
    const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, mockHttp);
    const client = new BaiduClient(oauth, mockHttp, { delayFn: zeroDelay });
    const engine = new SyncEngine(
      wedgingVault,
      () => settings,
      async (s) => { settings = s; },
      client,
      manifestMgr,
      ".obsidian/plugins/baidu-netdisk-sync",
      {
        fsMetaTimeoutMs: 40,
        fsBinaryTimeoutMs: 40,
        bridgeProbeTimeoutMs: 30,
        checkpointItems: 3,
        checkpointIntervalMs: 60_000
      }
    );

    // Fire concurrent second trigger immediately -> must be rejected by re-entrancy guard
    const run1Promise = engine.startSync(false);
    const concurrentTrigger = await engine.startSync(true);
    assert.strictEqual(concurrentTrigger.success, false, "Concurrent startSync trigger must be blocked");

    const run1 = await run1Promise;
    assert.strictEqual(run1.success, false);
    assert.strictEqual(run1.bridgeDead, true, "Wedged Capacitor bridge must trip circuit breaker");
    assert.strictEqual(engine.getState(), "error", "Engine state must transition to error, never stuck in syncing");
    assert.strictEqual(readAttemptsAfterWedge, 0, "Remaining queued files must be cancelled immediately without dispatch");
    assert.ok(manifestWriteCount >= 1, `Expected incremental manifest checkpoint before wedge, got ${manifestWriteCount}`);

    // Simulate process restart: un-wedge bridge and load manifest strictly from disk
    bridgeWedged = false;
    const reloadedManifest = new ManifestManager(baseVault, manifestPath);
    await reloadedManifest.load();
    const persistedKeys = Object.keys(reloadedManifest.getAll());
    assert.ok(
      persistedKeys.length >= 3,
      `Expected >= 3 files persisted to disk via incremental checkpoint, found ${persistedKeys.length}`
    );

    // Resume sync after restart (E2EE enabled, so MD5 dedup is off) ->
    // MUST skip the 3 already-checkpointed files (f01..f03) and only handle remaining 7!
    const uploadsBeforeResume = uploadedCount;
    const resumedEngine = new SyncEngine(
      baseVault,
      () => settings,
      async (s) => { settings = s; },
      client,
      reloadedManifest,
      ".obsidian/plugins/baidu-netdisk-sync",
      { checkpointItems: 3 }
    );
    const run2 = await resumedEngine.startSync(false);
    assert.strictEqual(run2.success, true, "Resumed sync after bridge recovery must succeed");
    assert.strictEqual(
      uploadedCount - uploadsBeforeResume,
      10 - persistedKeys.length,
      `Expected resumed E2EE sync to skip ${persistedKeys.length} checkpointed files and upload ${10 - persistedKeys.length}, uploaded ${uploadedCount - uploadsBeforeResume}`
    );
  }

  console.log("   Issue #1 deadlock protection, checkpoint & fast-scan tests passed!");
}

async function testDataLossProtectionSuite() {
  console.log("-> Testing P0/P1 data-loss protections (errno 20020 fallback, cursor truncation, BFS errors, download JSON guard, mass-delete circuit breaker, remoteBasePath switch, manifest corruption, E2EE empty pwd, TOCTOU delete)...");

  const makeSettings = (overrides: Partial<BaiduSyncSettings> = {}): BaiduSyncSettings => ({
    ...DEFAULT_SETTINGS,
    appKey: "k",
    appSecret: "s",
    accessToken: "VALID_TOK",
    refreshToken: "REF",
    tokenExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    syncObsidianConfig: false,
    ...overrides
  });

  // 1. listall errno 20020 MUST fall back to BFS (NOT return []) and cache unsupported path
  {
    let settings = makeSettings();
    let listallCalls = 0;
    let bfsCalls = 0;
    const mockHttp: HttpRequestFn = async (param) => {
      if (param.url.includes("method=listall")) {
        listallCalls++;
        return makeJsonResponse({ errno: 20020, show_msg: "该路径不在允许的访问范围内" });
      }
      if (param.url.includes("method=list&")) {
        bfsCalls++;
        return makeJsonResponse({
          errno: 0,
          list: [
            {
              fs_id: "10001",
              path: "/apps/obsidian_vault/resume.md",
              server_filename: "resume.md",
              size: 120,
              isdir: 0,
              server_mtime: 1700000000,
              server_ctime: 1700000000,
              md5: "abc"
            }
          ]
        });
      }
      throw new Error(`Unexpected URL: ${param.url}`);
    };
    const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, mockHttp);
    const client = new BaiduClient(oauth, mockHttp, { delayFn: zeroDelay });

    const first = await client.listAll("/apps/obsidian_vault");
    assert.strictEqual(first.length, 1, "errno 20020 from listall must fall back to BFS and return files");
    assert.strictEqual(first[0].path, "/apps/obsidian_vault/resume.md");
    assert.strictEqual(listallCalls, 1);
    assert.strictEqual(bfsCalls, 1);

    // Second call on same path must skip listall directly
    const second = await client.listAll("/apps/obsidian_vault");
    assert.strictEqual(second.length, 1);
    assert.strictEqual(listallCalls, 1, "Unsupported listall path should be cached for the session");
    assert.strictEqual(bfsCalls, 2);
  }

  // 2. listall stuck/invalid pagination cursor MUST fall back to BFS instead of returning partial list
  {
    let settings = makeSettings();
    let bfsUsed = false;
    const mockHttp: HttpRequestFn = async (param) => {
      if (param.url.includes("method=listall")) {
        return makeJsonResponse({
          errno: 0,
          has_more: 1,
          cursor: 0, // stuck cursor!
          list: [{ fs_id: "1", path: "/apps/obsidian_vault/p1.md", server_filename: "p1.md", size: 5, isdir: 0, server_mtime: 1, server_ctime: 1 }]
        });
      }
      if (param.url.includes("method=list&")) {
        bfsUsed = true;
        return makeJsonResponse({
          errno: 0,
          list: [
            { fs_id: "1", path: "/apps/obsidian_vault/p1.md", server_filename: "p1.md", size: 5, isdir: 0, server_mtime: 1, server_ctime: 1 },
            { fs_id: "2", path: "/apps/obsidian_vault/p2.md", server_filename: "p2.md", size: 5, isdir: 0, server_mtime: 1, server_ctime: 1 }
          ]
        });
      }
      throw new Error(`Unexpected URL: ${param.url}`);
    };
    const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, mockHttp);
    const client = new BaiduClient(oauth, mockHttp, { delayFn: zeroDelay });
    const items = await client.listAll("/apps/obsidian_vault");
    assert.strictEqual(bfsUsed, true, "Stuck listall cursor must fall back to BFS");
    assert.strictEqual(items.length, 2, "BFS fallback must recover complete listing");
  }

  // 3. listAllByBfs errno 20020 & subdir -9 MUST throw; root -9 returns []
  {
    let settings = makeSettings();
    let mode: "20020" | "root-9" | "subdir-9" = "20020";
    const mockHttp: HttpRequestFn = async (param) => {
      if (param.url.includes("method=listall")) {
        return makeJsonResponse({ errno: 2 });
      }
      if (param.url.includes("method=list&")) {
        if (mode === "20020") {
          return makeJsonResponse({ errno: 20020, show_msg: "denied" });
        }
        if (mode === "root-9") {
          return makeJsonResponse({ errno: -9 });
        }
        if (param.url.includes("subdir")) {
          return makeJsonResponse({ errno: -9 });
        }
        return makeJsonResponse({
          errno: 0,
          list: [{ fs_id: "99", path: "/apps/obsidian_vault/subdir", server_filename: "subdir", size: 0, isdir: 1, server_mtime: 1, server_ctime: 1 }]
        });
      }
      throw new Error(`Unexpected URL: ${param.url}`);
    };
    const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, mockHttp);
    const client = new BaiduClient(oauth, mockHttp, { delayFn: zeroDelay });

    await assert.rejects(() => client.listAll("/apps/forbidden"), /20020/, "BFS errno 20020 must throw");
    mode = "root-9";
    assert.deepStrictEqual(await client.listAll("/apps/new_empty"), [], "Root -9 is empty uninitialized dir");
    mode = "subdir-9";
    await assert.rejects(() => client.listAll("/apps/obsidian_vault"), /-9/, "Subdir -9 mid-BFS must throw to avoid partial listing");
  }

  // 4. Binary download HTTP 200 JSON Baidu error MUST throw; user JSON files MUST pass through
  {
    let settings = makeSettings();
    const mockHttp: HttpRequestFn = async (param) => {
      if (param.url.startsWith("https://d.pcs.baidu.com/expired")) {
        return makeJsonResponse({ error_code: 31360, error_msg: "url expired", request_id: 987654 });
      }
      if (param.url.startsWith("https://d.pcs.baidu.com/userjson")) {
        return makeJsonResponse({ theme: "Minimal", showRibbon: true });
      }
      if (param.url.includes("method=filemetas")) {
        return makeJsonResponse({ errno: 2 });
      }
      if (param.url.includes("opera=delete")) {
        const body = String(param.body || "");
        if (body.includes("already_gone")) {
          return makeJsonResponse({ errno: 12, info: [{ errno: -9, path: "/apps/obsidian_vault/already_gone.md" }] });
        }
        return makeJsonResponse({ errno: 12, info: [{ errno: 20020, path: "/apps/obsidian_vault/forbidden.md" }] });
      }
      throw new Error(`Unexpected URL: ${param.url}`);
    };
    const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, mockHttp);
    const client = new BaiduClient(oauth, mockHttp, { delayFn: zeroDelay });

    await assert.rejects(
      () => client.downloadFile("https://d.pcs.baidu.com/expired"),
      /31360/,
      "HTTP 200 Baidu JSON error envelope must be rejected instead of overwriting user file"
    );
    const okJsonBuf = await client.downloadFile("https://d.pcs.baidu.com/userjson");
    assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(okJsonBuf)), { theme: "Minimal", showRibbon: true });
    await assert.rejects(() => client.getFileMetas(["123"]), /2/, "getFileMetas must throw on non-zero errno");
    await client.deleteFiles(["/apps/obsidian_vault/already_gone.md"]);
    await assert.rejects(() => client.deleteFiles(["/apps/obsidian_vault/forbidden.md"]), /12|20020/);
  }

  // 5. E2EE enabled with empty password MUST refuse plaintext upload
  {
    let settings = makeSettings();
    const mockHttp: HttpRequestFn = async () => {
      throw new Error("HTTP must not be invoked when E2EE password is missing");
    };
    const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, mockHttp);
    const client = new BaiduClient(oauth, mockHttp, { delayFn: zeroDelay });
    const uploader = new BaiduUploader(client);
    await assert.rejects(
      () => uploader.uploadFile("/apps/obsidian_vault/secret.md", new ArrayBuffer(8), { enableE2EE: true, e2eePassword: "" }),
      /password|密码/i,
      "Uploader must refuse plaintext upload when enableE2EE is true with blank password"
    );
  }

  // 6. ManifestManager.load() must throw on corrupted JSON instead of silently wiping baseline
  {
    const vault = createMemoryVault(".obsidian");
    const manifestPath = ".obsidian/plugins/baidu-netdisk-sync/sync_manifest.json";
    vault.seedFile(manifestPath, "{corrupted-json");
    const mgr = new ManifestManager(vault, manifestPath);
    await assert.rejects(() => mgr.load(), /corrupted|损坏/i, "Corrupted manifest must abort instead of resetting empty");
  }

  // 7. Bidirectional mass-deletion circuit breaker (both local wipe & remote wipe blocked!)
  {
    const nowSec = Math.floor(Date.now() / 1000);
    const manifestPath = ".obsidian/plugins/baidu-netdisk-sync/sync_manifest.json";

    // 7a. Remote returns empty while 6 files exist locally & in manifest -> MUST abort local wipe
    const localVault = createMemoryVault(".obsidian");
    const localManifest = new ManifestManager(localVault, manifestPath);
    localManifest.setRemoteBasePath("/apps/obsidian_vault");
    for (let i = 1; i <= 6; i++) {
      const p = `note${i}.md`;
      localVault.seedFile(p, `hello ${i}`, nowSec * 1000);
      localManifest.set({
        path: p,
        remotePath: `/apps/obsidian_vault/${p}`,
        mtime: nowSec * 1000,
        remoteMtime: nowSec * 1000,
        md5: "m",
        size: 7,
        remoteSize: 7,
        fsId: String(100 + i)
      });
    }
    await localManifest.save();

    let settings = makeSettings();
    const emptyRemoteHttp: HttpRequestFn = async (param) => {
      if (param.url.includes("method=listall")) return makeJsonResponse({ errno: 0, has_more: 0, list: [] });
      throw new Error(`Unexpected URL: ${param.url}`);
    };
    const oauthA = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, emptyRemoteHttp);
    const engineA = new SyncEngine(
      localVault,
      () => settings,
      async (s) => { settings = s; },
      new BaiduClient(oauthA, emptyRemoteHttp, { delayFn: zeroDelay }),
      localManifest,
      ".obsidian/plugins/baidu-netdisk-sync"
    );
    const resA = await engineA.startSync(false);
    assert.strictEqual(resA.success, false);
    assert.strictEqual(resA.massDeleteAborted, true, "Empty remote must trip local wipe circuit breaker");
    assert.strictEqual(localVault.trashed.length, 0, "Zero local files may be trashed when circuit breaker trips");
    assert.strictEqual(localVault.files.has("note1.md"), true);

    // 7b. Local returns empty while 6 files exist remotely & in manifest -> MUST abort remote wipe
    const emptyLocalVault = createMemoryVault(".obsidian");
    const remoteManifest = new ManifestManager(emptyLocalVault, manifestPath);
    remoteManifest.setRemoteBasePath("/apps/obsidian_vault");
    const remoteList = [];
    for (let i = 1; i <= 6; i++) {
      const p = `note${i}.md`;
      remoteManifest.set({
        path: p,
        remotePath: `/apps/obsidian_vault/${p}`,
        mtime: nowSec * 1000,
        remoteMtime: nowSec * 1000,
        md5: "m",
        size: 7,
        remoteSize: 7,
        fsId: String(200 + i)
      });
      remoteList.push({
        fs_id: String(200 + i),
        path: `/apps/obsidian_vault/${p}`,
        server_filename: p,
        size: 7,
        isdir: 0,
        server_mtime: nowSec,
        server_ctime: nowSec,
        md5: "m"
      });
    }
    await remoteManifest.save();

    let remoteDeleteCalled = false;
    const populatedRemoteHttp: HttpRequestFn = async (param) => {
      if (param.url.includes("method=listall")) return makeJsonResponse({ errno: 0, has_more: 0, list: remoteList });
      if (param.url.includes("opera=delete")) {
        remoteDeleteCalled = true;
        return makeJsonResponse({ errno: 0 });
      }
      throw new Error(`Unexpected URL: ${param.url}`);
    };
    const oauthB = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, populatedRemoteHttp);
    const engineB = new SyncEngine(
      emptyLocalVault,
      () => settings,
      async (s) => { settings = s; },
      new BaiduClient(oauthB, populatedRemoteHttp, { delayFn: zeroDelay }),
      remoteManifest,
      ".obsidian/plugins/baidu-netdisk-sync"
    );
    const resB = await engineB.startSync(false);
    assert.strictEqual(resB.success, false);
    assert.strictEqual(resB.massDeleteAborted, true, "Empty local vault must trip remote wipe circuit breaker");
    assert.strictEqual(remoteDeleteCalled, false, "Zero remote deletes may execute when circuit breaker trips");
  }

  // 8. Switching remoteBasePath resets stale manifest instead of wiping local vault
  {
    const nowSec = Math.floor(Date.now() / 1000);
    const manifestPath = ".obsidian/plugins/baidu-netdisk-sync/sync_manifest.json";
    const vault = createMemoryVault(".obsidian");
    const manifestMgr = new ManifestManager(vault, manifestPath);
    for (let i = 1; i <= 3; i++) {
      const p = `doc${i}.md`;
      vault.seedFile(p, `doc-${i}`, nowSec * 1000);
      manifestMgr.set({
        path: p,
        remotePath: `/apps/old_vault/${p}`,
        mtime: nowSec * 1000,
        remoteMtime: nowSec * 1000,
        md5: "m",
        size: 5,
        remoteSize: 5,
        fsId: String(300 + i)
      });
    }
    await manifestMgr.save();

    let settings = makeSettings({ remoteBasePath: "/apps/new_vault" });
    const uploaded: string[] = [];
    const mockHttp: HttpRequestFn = async (param) => {
      if (param.url.includes("method=listall")) return makeJsonResponse({ errno: 0, has_more: 0, list: [] });
      if (param.url.includes("method=precreate")) {
        const params = new URLSearchParams(String(param.body || ""));
        const p = params.get("path") || "";
        uploaded.push(p);
        return makeJsonResponse({
          errno: 0,
          return_type: 2,
          uploadid: "",
          block_list: [],
          info: { fs_id: "777", path: p, size: Number(params.get("size") || 0), mtime: nowSec, md5: "x" }
        });
      }
      throw new Error(`Unexpected URL: ${param.url}`);
    };
    const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, mockHttp);
    const engine = new SyncEngine(
      vault,
      () => settings,
      async (s) => { settings = s; },
      new BaiduClient(oauth, mockHttp, { delayFn: zeroDelay }),
      manifestMgr,
      ".obsidian/plugins/baidu-netdisk-sync"
    );
    const res = await engine.startSync(false);
    assert.strictEqual(res.success, true);
    assert.strictEqual(vault.trashed.length, 0, "Changing remoteBasePath must never delete local files");
    assert.strictEqual(uploaded.length, 3, "Local files must upload to new remoteBasePath");
    assert.ok(uploaded.every((p) => p.startsWith("/apps/new_vault/")));
  }

  // 9. DELETE_LOCAL TOCTOU protection: file edited during remote scan must NOT be trashed
  {
    const nowSec = Math.floor(Date.now() / 1000);
    const manifestPath = ".obsidian/plugins/baidu-netdisk-sync/sync_manifest.json";
    const vault = createMemoryVault(".obsidian");
    vault.seedFile("active.md", "old", nowSec * 1000);
    const manifestMgr = new ManifestManager(vault, manifestPath);
    manifestMgr.setRemoteBasePath("/apps/obsidian_vault");
    manifestMgr.set({
      path: "active.md",
      remotePath: "/apps/obsidian_vault/active.md",
      mtime: nowSec * 1000,
      remoteMtime: nowSec * 1000,
      md5: "old",
      size: 3,
      remoteSize: 3,
      fsId: "401"
    });
    await manifestMgr.save();

    let settings = makeSettings();
    const mockHttp: HttpRequestFn = async (param) => {
      if (param.url.includes("method=listall")) {
        // User edits active.md right while remote scan is in flight!
        vault.seedFile("active.md", "freshly edited content", (nowSec + 60) * 1000);
        return makeJsonResponse({ errno: 0, has_more: 0, list: [] });
      }
      throw new Error(`Unexpected URL: ${param.url}`);
    };
    const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, mockHttp);
    const engine = new SyncEngine(
      vault,
      () => settings,
      async (s) => { settings = s; },
      new BaiduClient(oauth, mockHttp, { delayFn: zeroDelay }),
      manifestMgr,
      ".obsidian/plugins/baidu-netdisk-sync"
    );
    const res = await engine.startSync(false);
    assert.strictEqual(res.success, true);
    assert.strictEqual(vault.trashed.length, 0, "Modified file must not be trashed by stale DELETE_LOCAL plan");
    assert.strictEqual(vault.readText("active.md"), "freshly edited content");
    assert.ok(manifestMgr.get("active.md"), "Manifest entry should stay so next sync re-uploads modified file");
  }

  console.log("   All P0/P1 data-loss protection tests passed!");
}

async function testDeepAuditProtectionsSuite() {
  console.log(
    "-> Testing deep-audit P0/P1 protections (SyncFilter symmetry, gateway error_code, download size/octet-stream/dlink refresh, OAuth refresh storm/fatal, DOWNLOAD/CONFLICT/DELETE_REMOTE TOCTOU, case-rename race, case collision, NFC/NFD, remoteBasePath guardrails, settings snapshot, statFast reverify, manifest .bak/save errors)..."
  );

  const makeSettings = (overrides: Partial<BaiduSyncSettings> = {}): BaiduSyncSettings => ({
    ...DEFAULT_SETTINGS,
    appKey: "k",
    appSecret: "s",
    accessToken: "VALID_TOK",
    refreshToken: "REF",
    tokenExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    syncObsidianConfig: false,
    ...overrides
  });

  // 1. SyncFilter .gitignore ancestor inheritance & trailing slash symmetry (prevents remote folder wipe!)
  {
    const f = new SyncFilter(
      {
        ...DEFAULT_SETTINGS,
        ignoredPatterns: "Private\nExports/\n**/temp\n*.tmp",
        localIgnoredPatterns: "**/attachments/**"
      },
      ".obsidian"
    );

    // Every directory ignored during local pruning MUST also ignore every child file during remote scan!
    assert.strictEqual(f.shouldIgnore("Private", true), true);
    assert.strictEqual(f.shouldIgnore("Private/secret.md", false), true);
    assert.strictEqual(f.shouldIgnore("Private/sub/deep.md", false), true);

    // Trailing slash matches directory and its children, NOT a root file literally named "Exports"
    assert.strictEqual(f.shouldIgnore("Exports", true), true);
    assert.strictEqual(f.shouldIgnore("Exports/report.pdf", false), true);
    assert.strictEqual(f.shouldIgnore("Exports", false), false);

    // Nested folder rule without /** and wildcard folder name
    assert.strictEqual(f.shouldIgnore("work/temp", true), true);
    assert.strictEqual(f.shouldIgnore("work/temp/draft.md", false), true);
    assert.strictEqual(f.shouldIgnore("bak.tmp", true), true);
    assert.strictEqual(f.shouldIgnore("bak.tmp/data.md", false), true);

    // **/attachments/** prunes directory immediately AND ignores children
    assert.strictEqual(f.shouldIgnore("attachments", true), true);
    assert.strictEqual(f.shouldIgnore("attachments/pic.png", false), true);
    assert.strictEqual(f.shouldIgnore("sync_manifest.json.bak", false), true);

    // End-to-end: adding `Private` (without /**) MUST NOT delete remote Private/secret.md!
    const nowSec = Math.floor(Date.now() / 1000);
    const vault = createMemoryVault(".obsidian");
    vault.seedFile("Private/secret.md", "top secret", nowSec * 1000);
    const manifestPath = ".obsidian/plugins/baidu-netdisk-sync/sync_manifest.json";
    const manifestMgr = new ManifestManager(vault, manifestPath);
    manifestMgr.setRemoteBasePath("/apps/obsidian_vault");
    manifestMgr.set({
      path: "Private/secret.md",
      remotePath: "/apps/obsidian_vault/Private/secret.md",
      mtime: nowSec * 1000,
      remoteMtime: nowSec * 1000,
      md5: "s",
      size: 10,
      remoteSize: 10,
      fsId: "901"
    });
    await manifestMgr.save();

    let remoteDeleteCalled = false;
    let settings = makeSettings({ ignoredPatterns: "Private" });
    const mockHttp: HttpRequestFn = async (param) => {
      if (param.url.includes("method=listall")) {
        return makeJsonResponse({
          errno: 0,
          has_more: 0,
          list: [
            {
              fs_id: "901",
              path: "/apps/obsidian_vault/Private/secret.md",
              server_filename: "secret.md",
              size: 10,
              isdir: 0,
              server_mtime: nowSec,
              server_ctime: nowSec,
              md5: "s"
            }
          ]
        });
      }
      if (param.url.includes("opera=delete")) {
        remoteDeleteCalled = true;
        return makeJsonResponse({ errno: 0 });
      }
      throw new Error(`Unexpected URL: ${param.url}`);
    };
    const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, mockHttp);
    const engine = new SyncEngine(
      vault,
      () => settings,
      async (s) => { settings = s; },
      new BaiduClient(oauth, mockHttp, { delayFn: zeroDelay }),
      manifestMgr,
      ".obsidian/plugins/baidu-netdisk-sync"
    );
    const res = await engine.startSync(false);
    assert.strictEqual(res.success, true);
    assert.strictEqual(remoteDeleteCalled, false, "Folder-name ignore rule without /** MUST NEVER delete remote files");
    assert.strictEqual(vault.readText("Private/secret.md"), "top secret");
  }

  // 2. Baidu gateway error_code-only JSON (no errno field) MUST throw instead of returning []
  {
    let settings = makeSettings();
    const mockHttp: HttpRequestFn = async (param) => {
      if (param.url.includes("method=listall") || param.url.includes("method=list&") || param.url.includes("method=filemetas")) {
        return makeJsonResponse({ error_code: 31024, error_msg: "no permission", request_id: 12345 });
      }
      throw new Error(`Unexpected URL: ${param.url}`);
    };
    const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, mockHttp);
    const client = new BaiduClient(oauth, mockHttp, { delayFn: zeroDelay });
    await assert.rejects(() => client.listAll("/apps/obsidian_vault"), /31024/, "Gateway error_code must throw, never return []");
    await assert.rejects(() => client.getFileMetas(["1"]), /31024/, "filemetas gateway error_code must throw");
  }

  // 3. Download integrity: octet-stream JSON error, truncated/HTML size mismatch, and expired dlink auto-refresh
  {
    let settings = makeSettings();
    const expiredBytes = new TextEncoder().encode(
      JSON.stringify({ error_code: 31360, error_msg: "dlink expired", request_id: 42 })
    ).slice().buffer;
    const htmlWafBytes = new TextEncoder().encode("<html><body>Captive Portal</body></html>").slice().buffer;
    const goodBytes = new TextEncoder().encode("hello valid note!").slice().buffer; // 17 bytes

    let filemetasCalls = 0;
    const mockHttp: HttpRequestFn = async (param) => {
      if (param.url.startsWith("https://d.pcs.baidu.com/octet-err")) {
        return makeBinaryResponse(expiredBytes, "application/octet-stream");
      }
      if (param.url.startsWith("https://d.pcs.baidu.com/waf")) {
        return makeBinaryResponse(htmlWafBytes, "text/html");
      }
      if (param.url.startsWith("https://d.pcs.baidu.com/fresh-ok")) {
        return makeBinaryResponse(goodBytes, "application/octet-stream");
      }
      if (param.url.includes("method=listall")) {
        return makeJsonResponse({
          errno: 0,
          has_more: 0,
          list: [
            {
              fs_id: "801",
              path: "/apps/obsidian_vault/refreshed.md",
              server_filename: "refreshed.md",
              size: goodBytes.byteLength,
              isdir: 0,
              server_mtime: Math.floor(Date.now() / 1000),
              server_ctime: Math.floor(Date.now() / 1000),
              md5: md5(goodBytes)
            }
          ]
        });
      }
      if (param.url.includes("method=filemetas")) {
        filemetasCalls++;
        const dlink = filemetasCalls === 1 ? "https://d.pcs.baidu.com/octet-err" : "https://d.pcs.baidu.com/fresh-ok";
        return makeJsonResponse({
          errno: 0,
          list: [
            {
              fs_id: "801",
              path: "/apps/obsidian_vault/refreshed.md",
              server_filename: "refreshed.md",
              size: goodBytes.byteLength,
              isdir: 0,
              category: 6,
              md5: md5(goodBytes),
              dlink
            }
          ]
        });
      }
      throw new Error(`Unexpected URL: ${param.url}`);
    };
    const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, mockHttp);
    const client = new BaiduClient(oauth, mockHttp, { delayFn: zeroDelay });
    const downloader = new BaiduDownloader(client);

    await assert.rejects(
      () => client.downloadFile("https://d.pcs.baidu.com/octet-err"),
      /31360/,
      "JSON error under application/octet-stream must still be caught"
    );
    await assert.rejects(
      () =>
        downloader.downloadWithMeta(
          {
            fs_id: "801",
            path: "/apps/obsidian_vault/refreshed.md",
            server_filename: "refreshed.md",
            size: goodBytes.byteLength,
            isdir: 0,
            category: 6,
            md5: md5(goodBytes),
            dlink: "https://d.pcs.baidu.com/waf"
          },
          { expectedSize: goodBytes.byteLength }
        ),
      /mismatch|校验失败/i,
      "HTML/truncated response with mismatched byte length must be rejected"
    );

    // End-to-end: prefetched dlink returns 31360 -> engine automatically re-fetches fresh dlink & succeeds!
    const vault = createMemoryVault(".obsidian");
    const manifestMgr = new ManifestManager(vault, ".obsidian/plugins/baidu-netdisk-sync/sync_manifest.json");
    const engine = new SyncEngine(
      vault,
      () => settings,
      async (s) => { settings = s; },
      client,
      manifestMgr,
      ".obsidian/plugins/baidu-netdisk-sync"
    );
    const res = await engine.startSync(false);
    assert.strictEqual(res.success, true, "Expired prefetched dlink should auto-refresh and succeed");
    assert.strictEqual(filemetasCalls, 2, "Should refresh filemetas once on 31360");
    assert.strictEqual(vault.readText("refreshed.md"), "hello valid note!");
  }

  // 4. OAuth failedToken dedupe (no refresh storm) & revoked refresh_token fails fast without retries
  {
    let settings = makeSettings({ accessToken: "TOKEN_V2" });
    let refreshCalls = 0;
    const mockHttp: HttpRequestFn = async (param) => {
      if (param.url.includes("oauth/2.0/token")) {
        refreshCalls++;
        return makeJsonResponse({ error: "invalid_grant", error_description: "revoked" }, 400);
      }
      if (param.url.includes("method=listall")) {
        return makeJsonResponse({ errno: -6 });
      }
      throw new Error(`Unexpected URL: ${param.url}`);
    };
    const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, mockHttp);
    // Worker had stale TOKEN_V1, but settings already holds TOKEN_V2 -> must return TOKEN_V2 with 0 HTTP calls!
    const reused = await oauth.refreshTokenIfNeeded(true, "TOKEN_V1");
    assert.strictEqual(reused, "TOKEN_V2");
    assert.strictEqual(refreshCalls, 0, "Stale failedToken must reuse already-refreshed accessToken");

    // Now force refresh on current token with revoked grant -> BaiduClient must fail fast (1 refresh call, NOT 4 retries!)
    const client = new BaiduClient(oauth, mockHttp, { delayFn: zeroDelay });
    await assert.rejects(() => client.listAll("/apps/obsidian_vault"), /invalid_grant|400/);
    assert.strictEqual(refreshCalls, 1, "Fatal OAuth 400 invalid_grant must not be retried");
  }

  // 5. TOCTOU protection for DOWNLOAD (edited & newly created local), CONFLICT (winner=local), DELETE_REMOTE (restored local)
  {
    const nowSec = Math.floor(Date.now() / 1000);
    const vault = createMemoryVault(".obsidian");
    vault.seedFile("edit_during_dl.md", "v1-local", nowSec * 1000);
    const manifestMgr = new ManifestManager(vault, ".obsidian/plugins/baidu-netdisk-sync/sync_manifest.json");
    manifestMgr.setRemoteBasePath("/apps/obsidian_vault");
    manifestMgr.set({
      path: "edit_during_dl.md",
      remotePath: "/apps/obsidian_vault/edit_during_dl.md",
      mtime: nowSec * 1000,
      remoteMtime: nowSec * 1000,
      md5: "old",
      size: 8,
      remoteSize: 8,
      fsId: "601"
    });
    manifestMgr.set({
      path: "restored_local.md",
      remotePath: "/apps/obsidian_vault/restored_local.md",
      mtime: nowSec * 1000,
      remoteMtime: nowSec * 1000,
      md5: "old",
      size: 4,
      remoteSize: 4,
      fsId: "603"
    });
    await manifestMgr.save();

    let settings = makeSettings();
    const remoteNewContent = new TextEncoder().encode("remote-update-v2").slice().buffer;
    const brandNewRemote = new TextEncoder().encode("remote-brand-new").slice().buffer;
    let deletedRemotePaths: string[] = [];

    const mockHttp: HttpRequestFn = async (param) => {
      if (param.url.includes("method=listall")) {
        // User restores restored_local.md during remote scan!
        vault.seedFile("restored_local.md", "back alive", (nowSec + 10) * 1000);
        return makeJsonResponse({
          errno: 0,
          has_more: 0,
          list: [
            {
              fs_id: "601",
              path: "/apps/obsidian_vault/edit_during_dl.md",
              server_filename: "edit_during_dl.md",
              size: remoteNewContent.byteLength,
              isdir: 0,
              server_mtime: nowSec + 20,
              server_ctime: nowSec,
              md5: md5(remoteNewContent)
            },
            {
              fs_id: "602",
              path: "/apps/obsidian_vault/created_during_dl.md",
              server_filename: "created_during_dl.md",
              size: brandNewRemote.byteLength,
              isdir: 0,
              server_mtime: nowSec + 20,
              server_ctime: nowSec,
              md5: md5(brandNewRemote)
            },
            {
              fs_id: "603",
              path: "/apps/obsidian_vault/restored_local.md",
              server_filename: "restored_local.md",
              size: 4,
              isdir: 0,
              server_mtime: nowSec,
              server_ctime: nowSec,
              md5: "old"
            }
          ]
        });
      }
      if (param.url.includes("method=filemetas")) {
        return makeJsonResponse({
          errno: 0,
          list: [
            {
              fs_id: "601",
              path: "/apps/obsidian_vault/edit_during_dl.md",
              server_filename: "edit_during_dl.md",
              size: remoteNewContent.byteLength,
              isdir: 0,
              category: 6,
              md5: md5(remoteNewContent),
              dlink: "https://d.pcs.baidu.com/dl601"
            },
            {
              fs_id: "602",
              path: "/apps/obsidian_vault/created_during_dl.md",
              server_filename: "created_during_dl.md",
              size: brandNewRemote.byteLength,
              isdir: 0,
              category: 6,
              md5: md5(brandNewRemote),
              dlink: "https://d.pcs.baidu.com/dl602"
            }
          ]
        });
      }
      if (param.url.startsWith("https://d.pcs.baidu.com/dl601")) {
        // User edits edit_during_dl.md while download is in flight!
        vault.seedFile("edit_during_dl.md", "user fresh typing!", (nowSec + 60) * 1000);
        return makeBinaryResponse(remoteNewContent);
      }
      if (param.url.startsWith("https://d.pcs.baidu.com/dl602")) {
        // User creates created_during_dl.md locally while download is in flight!
        vault.seedFile("created_during_dl.md", "user new note", (nowSec + 60) * 1000);
        return makeBinaryResponse(brandNewRemote);
      }
      if (param.url.includes("opera=delete")) {
        const params = new URLSearchParams(String(param.body || ""));
        deletedRemotePaths = JSON.parse(params.get("filelist") || "[]") as string[];
        return makeJsonResponse({ errno: 0 });
      }
      throw new Error(`Unexpected URL: ${param.url}`);
    };

    const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, mockHttp);
    const engine = new SyncEngine(
      vault,
      () => settings,
      async (s) => { settings = s; },
      new BaiduClient(oauth, mockHttp, { delayFn: zeroDelay }),
      manifestMgr,
      ".obsidian/plugins/baidu-netdisk-sync"
    );
    const res = await engine.startSync(false);
    assert.strictEqual(res.success, true);
    assert.strictEqual(vault.readText("edit_during_dl.md"), "user fresh typing!", "DOWNLOAD must not overwrite mid-sync local edits");
    assert.strictEqual(vault.readText("created_during_dl.md"), "user new note", "DOWNLOAD must not overwrite mid-sync newly created local file");
    assert.strictEqual(deletedRemotePaths.length, 0, "DELETE_REMOTE must skip file restored locally during remote scan");
    assert.strictEqual(res.stats.skipped, 3);
  }

  // 6. Case-only rename (Note.md -> note.md) on case-insensitive OS MUST NOT delete newly downloaded note.md!
  {
    const nowSec = Math.floor(Date.now() / 1000);
    // Simulate a macOS/Windows/iOS case-insensitive filesystem!
    const ciFiles = new Map<string, { actualPath: string; data: ArrayBuffer; mtime: number }>();
    const folders = new Set<string>([""]);
    const ciVault: VaultSyncBridge & ManifestStorageAdapter = {
      configDir: ".obsidian",
      async exists(p: string) {
        return ciFiles.has(p.toLowerCase()) || folders.has(p.toLowerCase());
      },
      async stat(p: string) {
        const f = ciFiles.get(p.toLowerCase());
        if (f) return { type: "file", mtime: f.mtime, size: f.data.byteLength };
        if (folders.has(p.toLowerCase())) return { type: "folder", mtime: 0, size: 0 };
        return null;
      },
      async list(dir: string) {
        if (dir !== "") return { files: [], folders: [] };
        return {
          files: Array.from(ciFiles.values())
            .map((v) => v.actualPath)
            .filter((p) => !p.includes("/")),
          folders: []
        };
      },
      async mkdir(p: string) {
        folders.add(p.toLowerCase());
      },
      async readBinary(p: string) {
        const f = ciFiles.get(p.toLowerCase());
        if (!f) throw new Error(`Missing ${p}`);
        return f.data.slice(0);
      },
      async writeBinary(p: string, data: ArrayBuffer) {
        ciFiles.set(p.toLowerCase(), { actualPath: p, data: data.slice(0), mtime: Date.now() });
      },
      async read(p: string) {
        const f = ciFiles.get(p.toLowerCase());
        if (!f) throw new Error(`Missing ${p}`);
        return new TextDecoder().decode(f.data);
      },
      async write(p: string, data: string) {
        const buf = new TextEncoder().encode(data).slice().buffer;
        ciFiles.set(p.toLowerCase(), { actualPath: p, data: buf, mtime: Date.now() });
      },
      async trashFile(p: string) {
        // Deliberately slow trashFile to expose concurrency race if DELETE_LOCAL ran parallel to DOWNLOAD!
        await new Promise((r) => setTimeout(r, 30));
        ciFiles.delete(p.toLowerCase());
      }
    };

    const origBytes = new TextEncoder().encode("renamed body").slice().buffer;
    ciFiles.set("note.md", { actualPath: "Note.md", data: origBytes, mtime: nowSec * 1000 });
    const manifestMgr = new ManifestManager(ciVault, ".obsidian/plugins/baidu-netdisk-sync/sync_manifest.json");
    manifestMgr.setRemoteBasePath("/apps/obsidian_vault");
    manifestMgr.set({
      path: "Note.md",
      remotePath: "/apps/obsidian_vault/Note.md",
      mtime: nowSec * 1000,
      remoteMtime: nowSec * 1000,
      md5: md5(origBytes),
      size: origBytes.byteLength,
      remoteSize: origBytes.byteLength,
      fsId: "700"
    });
    await manifestMgr.save();

    let settings = makeSettings({ concurrency: 3 });
    const mockHttp: HttpRequestFn = async (param) => {
      if (param.url.includes("method=listall")) {
        return makeJsonResponse({
          errno: 0,
          has_more: 0,
          list: [
            {
              fs_id: "701",
              path: "/apps/obsidian_vault/note.md",
              server_filename: "note.md",
              size: origBytes.byteLength,
              isdir: 0,
              server_mtime: nowSec + 5,
              server_ctime: nowSec + 5,
              md5: md5(origBytes)
            }
          ]
        });
      }
      if (param.url.includes("method=filemetas")) {
        return makeJsonResponse({
          errno: 0,
          list: [
            {
              fs_id: "701",
              path: "/apps/obsidian_vault/note.md",
              server_filename: "note.md",
              size: origBytes.byteLength,
              isdir: 0,
              category: 6,
              md5: md5(origBytes),
              dlink: "https://d.pcs.baidu.com/ci701"
            }
          ]
        });
      }
      if (param.url.startsWith("https://d.pcs.baidu.com/ci701")) {
        return makeBinaryResponse(origBytes);
      }
      throw new Error(`Unexpected URL: ${param.url}`);
    };
    const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, mockHttp);
    const engine = new SyncEngine(
      ciVault,
      () => settings,
      async (s) => { settings = s; },
      new BaiduClient(oauth, mockHttp, { delayFn: zeroDelay }),
      manifestMgr,
      ".obsidian/plugins/baidu-netdisk-sync"
    );
    const res = await engine.startSync(false);
    assert.strictEqual(res.success, true);
    const survived = ciFiles.get("note.md");
    assert.ok(survived, "note.md MUST survive case-only rename on case-insensitive OS!");
    assert.strictEqual(survived!.actualPath, "note.md");
    assert.strictEqual(new TextDecoder().decode(survived!.data), "renamed body");
  }

  // 7. Remote case-collision detection & Unicode NFD/NFC matching
  {
    const nowSec = Math.floor(Date.now() / 1000);
    const vault = createMemoryVault(".obsidian");
    const nfdName = "cafe\u0301.md";
    const nfcName = "caf\u00e9.md";
    const cafeContent = "espresso";
    vault.seedFile(nfdName, cafeContent, nowSec * 1000);

    const manifestMgr = new ManifestManager(vault, ".obsidian/plugins/baidu-netdisk-sync/sync_manifest.json");
    let settings = makeSettings();
    let uploadCalls = 0;
    const mockHttp: HttpRequestFn = async (param) => {
      if (param.url.includes("method=listall")) {
        return makeJsonResponse({
          errno: 0,
          has_more: 0,
          list: [
            {
              fs_id: "910",
              path: `/apps/obsidian_vault/${nfcName}`,
              server_filename: nfcName,
              size: cafeContent.length,
              isdir: 0,
              server_mtime: nowSec,
              server_ctime: nowSec,
              md5: md5(new TextEncoder().encode(cafeContent))
            },
            // Case-colliding pair on remote!
            {
              fs_id: "911",
              path: "/apps/obsidian_vault/Dup.md",
              server_filename: "Dup.md",
              size: 4,
              isdir: 0,
              server_mtime: nowSec,
              server_ctime: nowSec,
              md5: "aaaa"
            },
            {
              fs_id: "912",
              path: "/apps/obsidian_vault/dup.md",
              server_filename: "dup.md",
              size: 4,
              isdir: 0,
              server_mtime: nowSec,
              server_ctime: nowSec,
              md5: "bbbb"
            }
          ]
        });
      }
      if (param.url.includes("method=precreate")) {
        uploadCalls++;
        throw new Error("Should not upload NFD/NFC identical file");
      }
      throw new Error(`Unexpected URL: ${param.url}`);
    };
    const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, mockHttp);
    const engine = new SyncEngine(
      vault,
      () => settings,
      async (s) => { settings = s; },
      new BaiduClient(oauth, mockHttp, { delayFn: zeroDelay }),
      manifestMgr,
      ".obsidian/plugins/baidu-netdisk-sync"
    );
    const res = await engine.startSync(false);
    assert.strictEqual(res.success, false, "Case collision must count as error");
    assert.strictEqual(res.stats.errors, 1);
    assert.strictEqual(uploadCalls, 0, "NFD local and NFC remote identical file must match without re-uploading");
    assert.strictEqual(vault.files.has("Dup.md"), false, "Colliding remote files must not be downloaded");
    assert.strictEqual(vault.files.has("dup.md"), false, "Colliding remote files must not be downloaded");
    assert.ok(manifestMgr.get(nfcName), "Manifest should record canonical NFC key for matched NFD/NFC file");
  }

  // 8. remoteBasePath guardrails, missing leading '/', parent-dir switch on legacy manifest, and settings snapshot isolation
  {
    assert.ok(normalizeAndValidateRemoteBasePath("").error);
    assert.ok(normalizeAndValidateRemoteBasePath("   ").error);
    assert.ok(normalizeAndValidateRemoteBasePath("/").error);
    assert.ok(normalizeAndValidateRemoteBasePath("/apps/../etc").error);
    assert.strictEqual(normalizeAndValidateRemoteBasePath("apps/vault/").normalized, "/apps/vault");

    // Legacy manifest (no remoteBasePath) switching from /apps/obsidian_vault -> parent /apps
    const nowSec = Math.floor(Date.now() / 1000);
    const vault = createMemoryVault(".obsidian");
    vault.seedFile("keep.md", "precious", nowSec * 1000);
    const manifestPath = ".obsidian/plugins/baidu-netdisk-sync/sync_manifest.json";
    vault.seedFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        lastSyncTime: nowSec * 1000,
        files: {
          "keep.md": {
            path: "keep.md",
            remotePath: "/apps/obsidian_vault/keep.md",
            mtime: nowSec * 1000,
            remoteMtime: nowSec * 1000,
            md5: "x",
            size: 8,
            remoteSize: 8,
            fsId: "555"
          }
        }
      })
    );

    const manifestMgr = new ManifestManager(vault, manifestPath);
    let settings = makeSettings({
      remoteBasePath: "apps", // Missing leading '/' AND parent directory of /apps/obsidian_vault!
      enableE2EE: true,
      e2eePassword: "FullStrongPassword!"
    });

    let uploadedCipherPayload: ArrayBuffer | null = null;
    const mockHttp: HttpRequestFn = async (param) => {
      if (param.url.includes("method=listall")) {
        // Mid-sync user edits e2eePassword character-by-character in Settings!
        settings.e2eePassword = "p";
        return makeJsonResponse({ errno: 0, has_more: 0, list: [] });
      }
      if (param.url.includes("method=precreate")) {
        return makeJsonResponse({
          errno: 0,
          return_type: 1,
          uploadid: "u-snap",
          block_list: [0]
        });
      }
      if (param.url.includes("pcs/superfile2")) {
        // Extract raw slice from multipart body using the exact Content-Type boundary
        const raw = new Uint8Array(param.body as ArrayBuffer);
        const ct = param.headers?.["Content-Type"] || "";
        const bMatch = ct.match(/boundary=(.+)$/);
        const boundary = bMatch ? bMatch[1].trim() : "";
        let startIdx = -1;
        for (let i = 0; i <= raw.length - 4; i++) {
          if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) {
            startIdx = i + 4;
            break;
          }
        }
        const tailMarker = new TextEncoder().encode(`\r\n--${boundary}--`);
        let endIdx = raw.length;
        for (let i = startIdx; i <= raw.length - tailMarker.length; i++) {
          let ok = true;
          for (let j = 0; j < tailMarker.length; j++) {
            if (raw[i + j] !== tailMarker[j]) {
              ok = false;
              break;
            }
          }
          if (ok) {
            endIdx = i;
            break;
          }
        }
        uploadedCipherPayload = raw.slice(startIdx, endIdx).buffer;
        return makeJsonResponse({ md5: md5(uploadedCipherPayload) });
      }
      if (param.url.includes("method=create")) {
        const params = new URLSearchParams(String(param.body || ""));
        return makeJsonResponse({
          errno: 0,
          fs_id: "7777",
          path: params.get("path") || "",
          size: Number(params.get("size") || 0),
          mtime: nowSec + 5,
          md5: "ok"
        });
      }
      throw new Error(`Unexpected URL: ${param.url}`);
    };
    const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, mockHttp);
    const engine = new SyncEngine(
      vault,
      () => settings,
      async (s) => { settings = s; },
      new BaiduClient(oauth, mockHttp, { delayFn: zeroDelay }),
      manifestMgr,
      ".obsidian/plugins/baidu-netdisk-sync"
    );
    const res = await engine.startSync(false);
    assert.strictEqual(res.success, true);
    assert.strictEqual(vault.trashed.length, 0, "Parent-dir remoteBasePath switch must never delete local files");
    assert.ok(uploadedCipherPayload, "File should have been uploaded encrypted");
    // Must decrypt with the SNAPSHOTTED password ("FullStrongPassword!"), NOT the mid-sync keystroke "p"!
    const decrypted = await decryptData(uploadedCipherPayload!, "FullStrongPassword!");
    assert.strictEqual(new TextDecoder().decode(decrypted), "precious");
    // And saving lastSyncTime must NOT have clobbered the live settings edit!
    assert.strictEqual(settings.e2eePassword, "p", "Live settings edits during sync must not be clobbered by snapshot");
  }

  // 9. statFast lagging cache pre-plan real-disk re-verify prevents false local-modified upload
  {
    const nowSec = Math.floor(Date.now() / 1000);
    const baseVault = createMemoryVault(".obsidian");
    baseVault.seedFile("cached.md", "synced body", nowSec * 1000);
    const manifestPath = ".obsidian/plugins/baidu-netdisk-sync/sync_manifest.json";
    const manifestMgr = new ManifestManager(baseVault, manifestPath);
    manifestMgr.setRemoteBasePath("/apps/obsidian_vault");
    manifestMgr.set({
      path: "cached.md",
      remotePath: "/apps/obsidian_vault/cached.md",
      mtime: nowSec * 1000,
      remoteMtime: nowSec * 1000,
      md5: md5(new TextEncoder().encode("synced body")),
      size: 11,
      remoteSize: 11,
      fsId: "444"
    });
    await manifestMgr.save();

    const laggingVault: VaultSyncBridge & ManifestStorageAdapter = {
      ...baseVault,
      // Simulate stale Obsidian TFile.stat lagging behind real disk adapter.stat!
      statFast: async (path: string) => {
        if (path === "cached.md") {
          return { type: "file", mtime: (nowSec - 120) * 1000, size: 5 };
        }
        return baseVault.stat(path);
      }
    };

    let settings = makeSettings();
    let uploadAttempted = false;
    const mockHttp: HttpRequestFn = async (param) => {
      if (param.url.includes("method=listall")) {
        return makeJsonResponse({
          errno: 0,
          has_more: 0,
          list: [
            {
              fs_id: "444",
              path: "/apps/obsidian_vault/cached.md",
              server_filename: "cached.md",
              size: 11,
              isdir: 0,
              server_mtime: nowSec,
              server_ctime: nowSec,
              md5: md5(new TextEncoder().encode("synced body"))
            }
          ]
        });
      }
      if (param.url.includes("method=precreate")) {
        uploadAttempted = true;
      }
      throw new Error(`Unexpected URL: ${param.url}`);
    };
    const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, mockHttp);
    const engine = new SyncEngine(
      laggingVault,
      () => settings,
      async (s) => { settings = s; },
      new BaiduClient(oauth, mockHttp, { delayFn: zeroDelay }),
      manifestMgr,
      ".obsidian/plugins/baidu-netdisk-sync"
    );
    const res = await engine.startSync(false);
    assert.strictEqual(res.success, true);
    assert.strictEqual(uploadAttempted, false, "Real disk re-verify must eliminate false upload from stale statFast");
  }

  // 10. Manifest .bak backup auto-recovery, save error propagation, bypassMassDeleteGuard & resetLocalBaseline
  {
    const vault = createMemoryVault(".obsidian");
    const manifestPath = ".obsidian/plugins/baidu-netdisk-sync/sync_manifest.json";
    const mgr = new ManifestManager(vault, manifestPath);
    mgr.setRemoteBasePath("/apps/obsidian_vault");
    mgr.set({
      path: "v1.md",
      remotePath: "/apps/obsidian_vault/v1.md",
      mtime: 1000,
      remoteMtime: 1000,
      md5: "m1",
      size: 2,
      remoteSize: 2,
      fsId: "1"
    });
    await mgr.save();

    // Second save must preserve v1 in .bak before writing v2
    mgr.set({
      path: "v2.md",
      remotePath: "/apps/obsidian_vault/v2.md",
      mtime: 2000,
      remoteMtime: 2000,
      md5: "m2",
      size: 2,
      remoteSize: 2,
      fsId: "2"
    });
    await mgr.save();
    assert.strictEqual(vault.files.has(`${manifestPath}.bak`), true, ".bak backup must exist after second save");

    // Corrupt main sync_manifest.json -> load() MUST automatically recover from .bak!
    vault.seedFile(manifestPath, "{half-written-crash");
    const recoveredMgr = new ManifestManager(vault, manifestPath);
    await recoveredMgr.load();
    assert.strictEqual(recoveredMgr.wasRecoveredFromBackup(), true, "Should recover automatically from .bak");
    assert.ok(recoveredMgr.get("v1.md"), "Recovered backup must contain previous baseline entries");

    // Manifest save write error MUST propagate (not silently report success!)
    const failingSaveAdapter: ManifestStorageAdapter = {
      ...vault,
      write: async () => {
        throw new Error("ENOSPC disk full");
      }
    };
    const failMgr = new ManifestManager(failingSaveAdapter, manifestPath);
    failMgr.set({
      path: "x.md",
      remotePath: "/apps/obsidian_vault/x.md",
      mtime: 1,
      remoteMtime: 1,
      md5: "x",
      size: 1,
      remoteSize: 1,
      fsId: "9"
    });
    await assert.rejects(() => failMgr.save(), /ENOSPC/, "ManifestManager.save() must propagate write failures");

    // Circuit breaker bypass once + resetLocalBaseline
    const nowSec = Math.floor(Date.now() / 1000);
    const cbVault = createMemoryVault(".obsidian");
    const cbManifest = new ManifestManager(cbVault, manifestPath);
    cbManifest.setRemoteBasePath("/apps/obsidian_vault");
    for (let i = 1; i <= 5; i++) {
      const p = `n${i}.md`;
      cbVault.seedFile(p, `body${i}`, nowSec * 1000);
      cbManifest.set({
        path: p,
        remotePath: `/apps/obsidian_vault/${p}`,
        mtime: nowSec * 1000,
        remoteMtime: nowSec * 1000,
        md5: "m",
        size: 5,
        remoteSize: 5,
        fsId: String(i)
      });
    }
    await cbManifest.save();

    let cbSettings = makeSettings();
    const emptyHttp: HttpRequestFn = async (param) => {
      if (param.url.includes("method=listall")) return makeJsonResponse({ errno: 0, has_more: 0, list: [] });
      throw new Error(`Unexpected URL: ${param.url}`);
    };
    const cbOauth = new BaiduOAuthManager(() => cbSettings, async (s) => { cbSettings = s; }, emptyHttp);
    const cbEngine = new SyncEngine(
      cbVault,
      () => cbSettings,
      async (s) => { cbSettings = s; },
      new BaiduClient(cbOauth, emptyHttp, { delayFn: zeroDelay }),
      cbManifest,
      ".obsidian/plugins/baidu-netdisk-sync"
    );
    const blocked = await cbEngine.startSync(false);
    assert.strictEqual(blocked.massDeleteAborted, true);
    assert.strictEqual(cbEngine.wasLastRunMassDeleteAborted(), true);

    // Explicit user-confirmed bypass proceeds
    const bypassed = await cbEngine.startSync(false, { bypassMassDeleteGuard: true });
    assert.strictEqual(bypassed.success, true);
    assert.strictEqual(cbVault.trashed.length, 5);
    assert.strictEqual(cbEngine.wasLastRunMassDeleteAborted(), false);

    // resetLocalBaseline resets cleanly without deleting files
    await cbEngine.resetLocalBaseline();
    assert.deepStrictEqual(Object.keys(cbManifest.getAll()), []);
  }

  // 11. Same-second same-size remote overwrite detected via fsId change
  {
    const local = new Map<string, LocalFileInfo>([["same-sec.md", { path: "same-sec.md", mtime: 5000, size: 3 }]]);
    const remote = new Map<string, RemoteFileInfo>([
      ["same-sec.md", { path: "same-sec.md", remotePath: "/apps/obsidian_vault/same-sec.md", mtime: 5000, size: 3, fsId: "200" }]
    ]);
    const manifest = {
      "same-sec.md": {
        path: "same-sec.md",
        remotePath: "/apps/obsidian_vault/same-sec.md",
        mtime: 5000,
        remoteMtime: 5000,
        md5: "old",
        size: 3,
        remoteSize: 3,
        fsId: "100"
      }
    };
    const plans = SyncPlanner.plan(local, remote, manifest, "/apps/obsidian_vault");
    assert.strictEqual(plans.length, 1);
    assert.strictEqual(plans[0].action, "DOWNLOAD", "fsId change with same mtime and size must detect remote edit");
  }

  console.log("   All deep-audit P0/P1 protection tests passed!");
}

async function testStaleDeviceDeletionDefenseSuite() {
  console.log(
    "-> Testing 3-layer stale-device deletion defense (L1 per-device CRDT tombstones + E2EE/fail-closed/GC/retry, L2 plaintext localMd5 anti-mtime-drift, Case A/B/C/D DELETE_CONFLICT, circuit-breaker synergy, L3 stale/empty-baseline guard & trust-cloud/merge-upload)..."
  );

  // Full stateful in-memory Baidu Cloud simulator supporting multiple devices, E2EE, uploads, downloads, deletes, and shard tracking
  function createMockCloud() {
    let nextFsId = 100001;
    let clockSec = Math.floor(Date.now() / 1000);
    const files = new Map<
      string,
      { fsId: string; path: string; data: ArrayBuffer; mtimeSec: number; md5Hex: string }
    >();
    const pendingUploads = new Map<string, { path: string; slices: Map<number, ArrayBuffer> }>();
    const downloadedPaths: string[] = [];
    const uploadedPaths: string[] = [];
    const deletedPaths: string[] = [];
    let failTombstoneUploads = false;

    const putRaw = (remotePath: string, data: ArrayBuffer, mtimeSec?: number) => {
      const m = mtimeSec ?? ++clockSec;
      const copy = data.slice(0);
      files.set(remotePath, {
        fsId: String(nextFsId++),
        path: remotePath,
        data: copy,
        mtimeSec: m,
        md5Hex: md5(copy)
      });
    };

    const deleteRaw = (remotePath: string) => {
      files.delete(remotePath);
    };

    const http: HttpRequestFn = async (param) => {
      if (param.url.includes("method=listall")) {
        const u = new URL(param.url);
        const base = u.searchParams.get("path") || "";
        const prefix = `${base}/`;
        const list = [];
        for (const f of files.values()) {
          if (f.path.startsWith(prefix)) {
            list.push({
              fs_id: f.fsId,
              path: f.path,
              server_filename: f.path.slice(f.path.lastIndexOf("/") + 1),
              size: f.data.byteLength,
              isdir: 0,
              server_mtime: f.mtimeSec,
              server_ctime: f.mtimeSec,
              md5: f.md5Hex
            });
          }
        }
        return makeJsonResponse({ errno: 0, has_more: 0, list });
      }

      if (param.url.includes("method=filemetas")) {
        const u = new URL(param.url);
        const fsids = JSON.parse(u.searchParams.get("fsids") || "[]") as Array<string | number>;
        const idSet = new Set(fsids.map(String));
        const list = [];
        for (const f of files.values()) {
          if (idSet.has(f.fsId)) {
            list.push({
              fs_id: f.fsId,
              path: f.path,
              server_filename: f.path.slice(f.path.lastIndexOf("/") + 1),
              size: f.data.byteLength,
              isdir: 0,
              category: 6,
              md5: f.md5Hex,
              dlink: `https://d.pcs.baidu.com/mock-dl/${encodeURIComponent(f.fsId)}`
            });
          }
        }
        return makeJsonResponse({ errno: 0, list });
      }

      if (param.url.startsWith("https://d.pcs.baidu.com/mock-dl/")) {
        const afterPrefix = param.url.slice("https://d.pcs.baidu.com/mock-dl/".length);
        const fsId = decodeURIComponent(afterPrefix.split("?")[0]);
        for (const f of files.values()) {
          if (f.fsId === fsId) {
            downloadedPaths.push(f.path);
            return makeBinaryResponse(f.data.slice(0));
          }
        }
        return makeJsonResponse({ error_code: 31066, error_msg: "not found" }, 404);
      }

      if (param.url.includes("method=precreate")) {
        const params = new URLSearchParams(String(param.body || ""));
        const p = params.get("path") || "";
        if (failTombstoneUploads && p.includes("/tombstones/")) {
          return makeJsonResponse({ errno: 31034, errmsg: "simulated tombstone failure" }, 500);
        }
        const uploadid = `up-${nextFsId++}`;
        const blockList = JSON.parse(params.get("block_list") || "[]") as string[];
        pendingUploads.set(uploadid, { path: p, slices: new Map() });
        return makeJsonResponse({
          errno: 0,
          path: p,
          uploadid,
          return_type: 1,
          block_list: blockList.map((_, idx) => idx)
        });
      }

      if (param.url.includes("superfile2?method=upload")) {
        const u = new URL(param.url);
        const uploadid = u.searchParams.get("uploadid") || "";
        const partseq = Number(u.searchParams.get("partseq") || "0");
        const entry = pendingUploads.get(uploadid);
        assert.ok(entry, `Missing pending upload ${uploadid}`);
        // Extract raw payload from multipart form-data body
        const bodyBuf = param.body as ArrayBuffer;
        const bodyBytes = new Uint8Array(bodyBuf);
        const headerEndSeq = [13, 10, 13, 10]; // \r\n\r\n
        let dataStart = -1;
        for (let i = 0; i <= bodyBytes.length - 4; i++) {
          if (
            bodyBytes[i] === headerEndSeq[0] &&
            bodyBytes[i + 1] === headerEndSeq[1] &&
            bodyBytes[i + 2] === headerEndSeq[2] &&
            bodyBytes[i + 3] === headerEndSeq[3]
          ) {
            dataStart = i + 4;
            break;
          }
        }
        assert.ok(dataStart >= 0, "Multipart header delimiter not found");
        // Find trailing \r\n--boundary
        let dataEnd = bodyBytes.length;
        for (let i = bodyBytes.length - 4; i >= dataStart; i--) {
          if (bodyBytes[i] === 13 && bodyBytes[i + 1] === 10 && bodyBytes[i + 2] === 45 && bodyBytes[i + 3] === 45) {
            dataEnd = i;
            break;
          }
        }
        const rawSlice = bodyBytes.slice(dataStart, dataEnd).buffer;
        entry.slices.set(partseq, rawSlice);
        return makeJsonResponse({ md5: md5(rawSlice) });
      }

      if (param.url.includes("method=create")) {
        const params = new URLSearchParams(String(param.body || ""));
        const p = params.get("path") || "";
        const uploadid = params.get("uploadid") || "";
        const entry = pendingUploads.get(uploadid);
        assert.ok(entry, `Missing pending upload for create ${uploadid}`);
        const ordered = Array.from(entry.slices.entries()).sort((a, b) => a[0] - b[0]);
        const totalLen = ordered.reduce((acc, [, b]) => acc + b.byteLength, 0);
        const combined = new Uint8Array(totalLen);
        let offset = 0;
        for (const [, buf] of ordered) {
          combined.set(new Uint8Array(buf), offset);
          offset += buf.byteLength;
        }
        pendingUploads.delete(uploadid);
        const mtimeSec = ++clockSec;
        const fsId = String(nextFsId++);
        const finalBuf = combined.buffer;
        const md5Hex = md5(finalBuf);
        files.set(p, { fsId, path: p, data: finalBuf, mtimeSec, md5Hex });
        uploadedPaths.push(p);
        return makeJsonResponse({
          errno: 0,
          fs_id: fsId,
          md5: md5Hex,
          server_filename: p.slice(p.lastIndexOf("/") + 1),
          category: 6,
          path: p,
          size: finalBuf.byteLength,
          ctime: mtimeSec,
          mtime: mtimeSec,
          isdir: 0
        });
      }

      if (param.url.includes("opera=delete")) {
        const params = new URLSearchParams(String(param.body || ""));
        const list = JSON.parse(params.get("filelist") || "[]") as string[];
        for (const p of list) {
          files.delete(p);
          deletedPaths.push(p);
        }
        return makeJsonResponse({ errno: 0 });
      }

      throw new Error(`Unexpected mock cloud URL: ${param.url}`);
    };

    return {
      files,
      downloadedPaths,
      uploadedPaths,
      deletedPaths,
      setFailTombstoneUploads: (v: boolean) => {
        failTombstoneUploads = v;
      },
      putRaw,
      deleteRaw,
      http
    };
  }

  const makeDevice = (
    cloud: ReturnType<typeof createMockCloud>,
    deviceId: string,
    overrides: Partial<BaiduSyncSettings> = {},
    engineOpts: {
      tombstoneRetentionMs?: number;
      tombstoneRetiredShardGraceMs?: number;
      tombstoneMaxEntriesPerDevice?: number;
      e2eeMd5BackfillMaxFiles?: number;
      e2eeMd5BackfillMaxBytes?: number;
    } = {}
  ) => {
    const vault = createMemoryVault(".obsidian");
    const pluginDir = ".obsidian/plugins/baidu-netdisk-sync";
    const manifestMgr = new ManifestManager(vault, `${pluginDir}/sync_manifest.json`);
    const tombstoneMgr = new TombstoneManager(vault, `${pluginDir}/tombstone_cache.json`, {
      retentionMs: engineOpts.tombstoneRetentionMs,
      retiredShardGraceMs: engineOpts.tombstoneRetiredShardGraceMs,
      maxEntriesPerDevice: engineOpts.tombstoneMaxEntriesPerDevice
    });
    let settings: BaiduSyncSettings = {
      ...DEFAULT_SETTINGS,
      appKey: "k",
      appSecret: "s",
      accessToken: "VALID_TOK",
      refreshToken: "REF",
      tokenExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      syncObsidianConfig: false,
      deviceId,
      ...overrides
    };
    const oauth = new BaiduOAuthManager(() => settings, async (s) => { settings = s; }, cloud.http);
    const client = new BaiduClient(oauth, cloud.http, { delayFn: zeroDelay });
    const engine = new SyncEngine(
      vault,
      () => settings,
      async (s) => { settings = s; },
      client,
      manifestMgr,
      pluginDir,
      {
        tombstones: tombstoneMgr,
        e2eeMd5BackfillMaxFiles: engineOpts.e2eeMd5BackfillMaxFiles,
        e2eeMd5BackfillMaxBytes: engineOpts.e2eeMd5BackfillMaxBytes
      }
    );
    return {
      vault,
      manifestMgr,
      tombstoneMgr,
      engine,
      getSettings: () => settings,
      setSettings: (patch: Partial<BaiduSyncSettings>) => {
        settings = { ...settings, ...patch };
      }
    };
  };

  // 1. Legacy compatibility & deviceId validation
  {
    const id = generateDeviceId();
    assert.strictEqual(isValidDeviceId(id), true);
    assert.strictEqual(extractTombstoneDeviceId(`${REMOTE_TOMBSTONE_DIR_REL}/${id}.json`), id);
    assert.strictEqual(extractTombstoneDeviceId(`${REMOTE_TOMBSTONE_DIR_REL}/../evil.json`), null);

    // Filter must ignore cloud metadata folder, tombstone shard path, and local tombstone cache
    const filter = new SyncFilter(DEFAULT_SETTINGS, ".obsidian");
    assert.strictEqual(filter.shouldIgnore(`${REMOTE_TOMBSTONE_DIR_REL}/${id}.json`, false), true);
    assert.strictEqual(filter.shouldIgnore(".bdsync-meta", true), true);
    assert.strictEqual(filter.shouldIgnore("tombstone_cache.json", false), true);
    assert.strictEqual(filter.shouldIgnore("tombstone_cache.json.bak", false), true);
    // Legacy <= v1.1.4 filter rule: `normalized.includes("/plugins/baidu-netdisk-sync/")`
    assert.strictEqual(`${REMOTE_TOMBSTONE_DIR_REL}/${id}.json`.includes("/plugins/baidu-netdisk-sync/"), true);
  }

  // 2. Pairing configShare MUST exclude deviceId and preserve staleSyncThresholdDays
  {
    const srcSettings: BaiduSyncSettings = {
      ...DEFAULT_SETTINGS,
      appKey: "k",
      appSecret: "s",
      accessToken: "tok",
      refreshToken: "ref",
      tokenExpiresAt: Date.now() + 100000,
      deviceId: "dev-aaaaaaaaaaaaaaaaaaaaaaaa",
      staleSyncThresholdDays: 45
    };
    const code = await exportEncryptedConfig(srcSettings, "pin999");
    const imported = await importEncryptedConfig(code, "pin999");
    assert.strictEqual(imported.staleSyncThresholdDays, 45);
    assert.strictEqual("deviceId" in imported, false, "deviceId MUST NEVER be exported in pairing payload");
  }

  // 3. L1 + L2 full two-device lifecycle:
  //    - Device A deletes `old.md` -> records cloud tombstone shard
  //    - Device B loses manifest AND drifts `old.md` mtime into the future -> L1 hash match moves `old.md` to .trash (0 uploads!)
  //    - Device C still has manifest AND drifts `old.md` mtime by +10 days -> L2 plaintext localMd5 moves `old.md` to .trash!
  {
    const cloud = createMockCloud();
    const devA = makeDevice(cloud, "dev-aaaaaaaaaaaaaaaaaaaaaaaa");
    const devB = makeDevice(cloud, "dev-bbbbbbbbbbbbbbbbbbbbbbbb");
    const devC = makeDevice(cloud, "dev-cccccccccccccccccccccccc");

    const baseTime = Date.now() - 60_000;
    devA.vault.seedFile("old.md", "deprecated note content", baseTime);
    devA.vault.seedFile("keep.md", "living note content", baseTime);
    assert.strictEqual((await devA.engine.startSync(false)).success, true);

    // Device B & C pull initial vault cleanly
    assert.strictEqual((await devB.engine.startSync(false)).success, true);
    assert.strictEqual((await devC.engine.startSync(false)).success, true);
    assert.strictEqual(devB.vault.readText("old.md"), "deprecated note content");
    assert.ok(devC.manifestMgr.get("old.md")?.localMd5, "Manifest must capture plaintext localMd5 on download");

    // Device A deletes old.md and syncs -> uploads cloud tombstone shard dev-aaaa...json
    devA.vault.files.delete("old.md");
    const resDelA = await devA.engine.startSync(false);
    assert.strictEqual(resDelA.success, true);
    assert.strictEqual(resDelA.stats.deleted, 1);
    const shardAPath = buildRemoteTombstonePath("/apps/obsidian_vault", "dev-aaaaaaaaaaaaaaaaaaaaaaaa");
    assert.ok(cloud.files.has(shardAPath), "Device A must upload its cloud tombstone shard after DELETE_REMOTE");

    // Device B loses manifest completely AND its local old.md mtime drifts into the FUTURE (+1 hour)
    await devB.engine.resetLocalBaseline();
    devB.vault.seedFile("old.md", "deprecated note content", Date.now() + 3_600_000);
    const resB = await devB.engine.startSync(false);
    assert.strictEqual(resB.success, true, "Device B must not fail or trip stale guard when old.md matches tombstone");
    assert.strictEqual(resB.stats.uploaded, 0, "Device B MUST NOT resurrect deleted old.md");
    assert.strictEqual(resB.stats.deleted, 1);
    assert.strictEqual(devB.vault.files.has("old.md"), false);
    assert.ok(devB.vault.trashed.includes("old.md"));
    assert.strictEqual(cloud.files.has("/apps/obsidian_vault/old.md"), false);

    // Steady-state check: running Device B again must download 0 tombstone shards (served from local cache)
    const dlBefore = cloud.downloadedPaths.length;
    assert.strictEqual((await devB.engine.startSync(false)).success, true);
    assert.strictEqual(cloud.downloadedPaths.length, dlBefore, "Steady-state sync must perform 0 extra tombstone downloads");

    // Device C keeps manifest, but OS/FS drifts old.md mtime by +10 days (content unchanged)
    // Even if we remove the cloud tombstone shard to test pure L2 mtime-drift resistance:
    cloud.deleteRaw(shardAPath);
    devC.vault.seedFile("old.md", "deprecated note content", Date.now() + 10 * 86_400_000);
    const resC = await devC.engine.startSync(false);
    assert.strictEqual(resC.success, true);
    assert.strictEqual(resC.stats.uploaded, 0, "L2 localMd5 must prevent mtime-drifted unmodified file from resurrecting");
    assert.strictEqual(resC.stats.deleted, 1);
    assert.ok(devC.vault.trashed.includes("old.md"));
  }

  // 4. Case B (older v1 with missing manifest) & Case C (recreated after deletion + same-device restore)
  {
    const cloud = createMockCloud();
    const devA = makeDevice(cloud, "dev-aaaaaaaaaaaaaaaaaaaaaaaa");
    const devB = makeDevice(cloud, "dev-bbbbbbbbbbbbbbbbbbbbbbbb");

    const t0 = Date.now() - 120_000;
    devA.vault.seedFile("evolving.md", "version 1", t0);
    devA.vault.seedFile("keep.md", "keep", t0);
    assert.strictEqual((await devA.engine.startSync(false)).success, true);

    // Device A updates to v2, syncs, then deletes v2 -> tombstone records v2 hash & deletedAt (~now)
    devA.vault.seedFile("evolving.md", "version 2 edited", Date.now() - 30_000);
    assert.strictEqual((await devA.engine.startSync(false)).success, true);
    devA.vault.files.delete("evolving.md");
    assert.strictEqual((await devA.engine.startSync(false)).success, true);

    // Case B: Device B has NO manifest and holds older v1 (hash != v2 hash, but mtime t0 <= deletedAt)
    devB.vault.seedFile("evolving.md", "version 1", t0);
    devB.vault.seedFile("keep.md", "keep", t0);
    const resB = await devB.engine.startSync(false);
    assert.strictEqual(resB.success, true);
    assert.strictEqual(resB.stats.uploaded, 0, "Older pre-deletion v1 without manifest must NOT resurrect");
    assert.strictEqual(devB.vault.files.has("evolving.md"), false);
    assert.ok(devB.vault.trashed.includes("evolving.md"));

    // Case C1: User on Device B intentionally creates a brand new evolving.md AFTER deletion
    devB.vault.seedFile("evolving.md", "brand new note after deletion", Date.now() + 5_000);
    const resRecreateB = await devB.engine.startSync(false);
    assert.strictEqual(resRecreateB.success, true);
    assert.strictEqual(resRecreateB.stats.uploaded, 1, "Brand new note created after deletion MUST upload");
    assert.ok(cloud.files.has("/apps/obsidian_vault/evolving.md"));

    // Case C2: Same-device restore — Device A deletes `restore.md`, syncs, then pastes back IDENTICAL content later
    devA.vault.seedFile("restore.md", "exact same content", Date.now() - 10_000);
    assert.strictEqual((await devA.engine.startSync(false)).success, true);
    devA.vault.files.delete("restore.md");
    assert.strictEqual((await devA.engine.startSync(false)).success, true);
    assert.strictEqual(cloud.files.has("/apps/obsidian_vault/restore.md"), false);

    devA.vault.seedFile("restore.md", "exact same content", Date.now() + 5_000);
    const resRestoreA = await devA.engine.startSync(false);
    assert.strictEqual(resRestoreA.success, true);
    assert.strictEqual(resRestoreA.stats.uploaded, 1, "Same-device intentional restore after delete MUST upload");
    assert.ok(cloud.files.has("/apps/obsidian_vault/restore.md"));
    assert.strictEqual(
      devA.tombstoneMgr.getMergedTombstones("dev-aaaaaaaaaaaaaaaaaaaaaaaa").has("restore.md"),
      false,
      "Uploading restored file on same device must clear its own tombstone entry"
    );
  }

  // 5. Case D: Real offline edit vs remote delete (copy -> DELETE_CONFLICT; lww -> timestamp comparison)
  {
    const cloud = createMockCloud();
    const devA = makeDevice(cloud, "dev-aaaaaaaaaaaaaaaaaaaaaaaa", { conflictStrategy: "copy" });
    const devB = makeDevice(cloud, "dev-bbbbbbbbbbbbbbbbbbbbbbbb", { conflictStrategy: "copy" });
    const devLww = makeDevice(cloud, "dev-cccccccccccccccccccccccc", { conflictStrategy: "lww" });

    const t0 = Date.now() - 60_000;
    devA.vault.seedFile("idea.md", "initial draft", t0);
    devA.vault.seedFile("lww-old.md", "initial lww", t0);
    devA.vault.seedFile("lww-new.md", "initial lww new", t0);
    assert.strictEqual((await devA.engine.startSync(false)).success, true);
    assert.strictEqual((await devB.engine.startSync(false)).success, true);
    assert.strictEqual((await devLww.engine.startSync(false)).success, true);

    // Device A deletes all 3 files
    devA.vault.files.delete("idea.md");
    devA.vault.files.delete("lww-old.md");
    devA.vault.files.delete("lww-new.md");
    assert.strictEqual((await devA.engine.startSync(false)).success, true);

    // Device B genuinely edits idea.md offline under copy strategy -> DELETE_CONFLICT
    devB.vault.seedFile("idea.md", "offline edited content worth saving!", Date.now() + 2_000);
    const resB = await devB.engine.startSync(false);
    assert.strictEqual(resB.success, true);
    assert.strictEqual(resB.stats.conflicts, 1, "Copy mode delete-modify must create conflict copy");
    assert.strictEqual(devB.vault.files.has("idea.md"), false, "Original deleted path must be trashed");
    assert.strictEqual(cloud.files.has("/apps/obsidian_vault/idea.md"), false, "Original deleted path must stay deleted remotely");
    const conflictFile = Array.from(devB.vault.files.keys()).find((p) => p.startsWith("idea.conflict-"));
    assert.ok(conflictFile, "Conflict backup copy must exist locally");
    assert.strictEqual(devB.vault.readText(conflictFile!), "offline edited content worth saving!");
    assert.ok(cloud.files.has(`/apps/obsidian_vault/${conflictFile!}`), "Conflict backup copy must be uploaded to cloud");

    // Device C (LWW): lww-old edited BEFORE deletion -> trashed; lww-new edited AFTER deletion -> uploaded
    devLww.vault.seedFile("lww-old.md", "older offline edit", t0 + 10_000);
    devLww.vault.seedFile("lww-new.md", "newer offline edit", Date.now() + 10_000);
    const resLww = await devLww.engine.startSync(false);
    assert.strictEqual(resLww.success, true);
    assert.strictEqual(devLww.vault.files.has("lww-old.md"), false, "LWW must trash edit older than deletion");
    assert.strictEqual(cloud.files.has("/apps/obsidian_vault/lww-old.md"), false);
    assert.ok(cloud.files.has("/apps/obsidian_vault/lww-new.md"), "LWW must upload edit newer than deletion");
  }

  // 6. E2EE tombstone encryption, Fail-Closed wrong-password guard, and convertVaultToPlaintext
  {
    const cloud = createMockCloud();
    const pass = "E2EE-Tombstone-Secret-2026!";
    const devA = makeDevice(cloud, "dev-aaaaaaaaaaaaaaaaaaaaaaaa", { enableE2EE: true, e2eePassword: pass });
    const devB = makeDevice(cloud, "dev-bbbbbbbbbbbbbbbbbbbbbbbb", { enableE2EE: true, e2eePassword: pass });

    devA.vault.seedFile("SecretDiary.md", "my private diary", Date.now() - 30_000);
    devA.vault.seedFile("KeepSecret.md", "keep this secret", Date.now() - 30_000);
    assert.strictEqual((await devA.engine.startSync(false)).success, true);
    assert.strictEqual((await devB.engine.startSync(false)).success, true);

    // Device A deletes SecretDiary.md -> encrypted tombstone shard uploaded
    devA.vault.files.delete("SecretDiary.md");
    assert.strictEqual((await devA.engine.startSync(false)).success, true);

    const shardAPath = buildRemoteTombstonePath("/apps/obsidian_vault", "dev-aaaaaaaaaaaaaaaaaaaaaaaa");
    const rawShard = cloud.files.get(shardAPath);
    assert.ok(rawShard, "Encrypted tombstone shard must exist on cloud");
    assert.strictEqual(getEncryptionVersion(rawShard!.data), 2, "E2EE tombstone shard MUST use E2EE v2 format");
    assert.strictEqual(
      new TextDecoder().decode(rawShard!.data).includes("SecretDiary.md"),
      false,
      "E2EE tombstone shard MUST NOT leak deleted filenames in plaintext"
    );

    // Fail-closed test: Device B has WRONG password + wiped manifest -> MUST abort sync and NOT upload SecretDiary.md
    await devB.engine.resetLocalBaseline();
    devB.setSettings({ e2eePassword: "WRONG-PASSWORD" });
    const resWrong = await devB.engine.startSync(false);
    assert.strictEqual(resWrong.success, false, "Wrong E2EE password on tombstone shard MUST fail-closed");
    assert.strictEqual(cloud.files.has("/apps/obsidian_vault/SecretDiary.md"), false, "Must NOT resurrect file on tombstone decrypt failure");

    // Restore correct password -> Device B decrypts shard, verifies plaintext MD5, and trashes SecretDiary.md!
    devB.setSettings({ e2eePassword: pass });
    const resFixed = await devB.engine.startSync(false);
    assert.strictEqual(resFixed.success, true);
    assert.strictEqual(devB.vault.files.has("SecretDiary.md"), false);
    assert.ok(devB.vault.trashed.includes("SecretDiary.md"));

    // Plaintext migration on Device A must also convert its encrypted tombstone shard to plaintext JSON
    const migRes = await devA.engine.convertVaultToPlaintext();
    assert.strictEqual(migRes.success, true);
    const migratedShard = cloud.files.get(shardAPath);
    assert.ok(migratedShard);
    assert.strictEqual(isEncrypted(migratedShard!.data), false, "Plaintext migration must convert own tombstone shard to plaintext");
    assert.ok(new TextDecoder().decode(migratedShard!.data).includes("SecretDiary.md"));
  }

  // 7. Mass-Delete Circuit Breaker synergy: tombstone-verified deletes flow smoothly; unverified mass deletes stay blocked
  {
    const cloud = createMockCloud();
    const devA = makeDevice(cloud, "dev-aaaaaaaaaaaaaaaaaaaaaaaa");
    const devB = makeDevice(cloud, "dev-bbbbbbbbbbbbbbbbbbbbbbbb");

    const t0 = Date.now() - 60_000;
    for (let i = 1; i <= 15; i++) {
      devA.vault.seedFile(`note-${i}.md`, `content ${i}`, t0);
    }
    assert.strictEqual((await devA.engine.startSync(false)).success, true);
    assert.strictEqual((await devB.engine.startSync(false)).success, true);

    // Device A gradually deletes 12 of 15 files across 4 normal sessions while Device B sleeps
    // (3 files per session stays below single-run guard, accumulating 80% total deletions with cloud tombstones!)
    for (let batch = 0; batch < 4; batch++) {
      for (let j = 1; j <= 3; j++) {
        devA.vault.files.delete(`note-${batch * 3 + j}.md`);
      }
      assert.strictEqual((await devA.engine.startSync(false)).success, true);
    }

    // Device B wakes up -> all 12 are tombstone-verified -> flows smoothly into .trash without aborting!
    const resB = await devB.engine.startSync(false);
    assert.strictEqual(resB.success, true, "Tombstone-verified bulk deletions must flow smoothly without false circuit-breaker trip");
    assert.strictEqual(resB.stats.deleted, 12);
    assert.strictEqual(devB.vault.trashed.length, 12);

    // Contrast: delete 12 files directly on cloud WITHOUT tombstones -> MUST STILL trip circuit breaker!
    const cloud2 = createMockCloud();
    const devX = makeDevice(cloud2, "dev-xxxxxxxxxxxxxxxxxxxxxxxx");
    for (let i = 1; i <= 15; i++) {
      devX.vault.seedFile(`u-${i}.md`, `content ${i}`, t0);
    }
    assert.strictEqual((await devX.engine.startSync(false)).success, true);
    for (let i = 1; i <= 12; i++) {
      cloud2.deleteRaw(`/apps/obsidian_vault/u-${i}.md`);
    }
    const resUnverified = await devX.engine.startSync(false);
    assert.strictEqual(resUnverified.success, false);
    assert.strictEqual(resUnverified.massDeleteAborted, true, "Unverified mass remote deletion without tombstones MUST trip circuit breaker");
    assert.strictEqual(devX.vault.trashed.length, 0);
  }

  // 8. Layer 3 Stale-Device & Empty-Baseline Guard + trust-cloud & merge-upload modes
  {
    const cloud = createMockCloud();
    const t0 = Date.now() - 60_000;
    cloud.putRaw("/apps/obsidian_vault/cloud-active.md", new TextEncoder().encode("active on cloud").slice().buffer);

    // 8a. Empty baseline connecting to populated cloud with unexplained local-only file -> trips staleGuardAborted
    const devEmpty = makeDevice(cloud, "dev-eeeeeeeeeeeeeeeeeeeeeeee");
    devEmpty.vault.seedFile("legacy-deleted-before-upgrade.md", "old local leftover", t0);
    const resBlocked = await devEmpty.engine.startSync(false);
    assert.strictEqual(resBlocked.success, false);
    assert.strictEqual(resBlocked.staleGuardAborted, true, "Empty baseline + non-empty cloud + unexplained local file must trip L3 guard");
    assert.strictEqual(devEmpty.engine.wasLastRunStaleGuardAborted(), true);
    assert.strictEqual(devEmpty.engine.getLastStaleGuardInfo()?.reason, "empty-baseline");
    assert.strictEqual(cloud.files.has("/apps/obsidian_vault/legacy-deleted-before-upgrade.md"), false);

    // Resolve via trust-cloud -> moves leftover to .trash and pulls cloud-active.md!
    const resTrust = await devEmpty.engine.startSync(false, { staleResolution: "trust-cloud" });
    assert.strictEqual(resTrust.success, true);
    assert.strictEqual(devEmpty.vault.files.has("legacy-deleted-before-upgrade.md"), false);
    assert.ok(devEmpty.vault.trashed.includes("legacy-deleted-before-upgrade.md"));
    assert.strictEqual(devEmpty.vault.readText("cloud-active.md"), "active on cloud");
    assert.strictEqual(cloud.files.has("/apps/obsidian_vault/legacy-deleted-before-upgrade.md"), false);

    // 8b. Empty baseline resolved via merge-upload -> uploads local-only file
    const devMerge = makeDevice(cloud, "dev-111111111111111111111111");
    devMerge.vault.seedFile("intentional-new.md", "keep me!", t0);
    const resMergeBlocked = await devMerge.engine.startSync(false);
    assert.strictEqual(resMergeBlocked.staleGuardAborted, true);
    const resMerge = await devMerge.engine.startSync(false, { staleResolution: "merge-upload" });
    assert.strictEqual(resMerge.success, true);
    assert.ok(cloud.files.has("/apps/obsidian_vault/intentional-new.md"));

    // 8c. Stale device (>30 days since lastSyncTime) with unexplained upload + stale local delete -> trust-cloud restores remote & trashes local extra
    const devStale = makeDevice(cloud, "dev-222222222222222222222222", { staleSyncThresholdDays: 30 });
    assert.strictEqual((await devStale.engine.startSync(false)).success, true);
    // Simulate 45 days offline
    devStale.manifestMgr.updateLastSyncTime(Date.now() - 45 * 86_400_000);
    await devStale.manifestMgr.save();
    // Offline device has an unexplained local file AND missing cloud-active.md (would otherwise DELETE_REMOTE!)
    devStale.vault.seedFile("stale-extra.md", "stale leftover", Date.now());
    devStale.vault.files.delete("cloud-active.md");

    const resStaleAbort = await devStale.engine.startSync(false);
    assert.strictEqual(resStaleAbort.staleGuardAborted, true);
    assert.strictEqual(devStale.engine.getLastStaleGuardInfo()?.reason, "stale-days");
    assert.ok(cloud.files.has("/apps/obsidian_vault/cloud-active.md"), "Must not delete remote file when stale guard aborts");

    const resStaleTrust = await devStale.engine.startSync(false, { staleResolution: "trust-cloud" });
    assert.strictEqual(resStaleTrust.success, true);
    assert.strictEqual(devStale.vault.files.has("stale-extra.md"), false);
    assert.ok(devStale.vault.trashed.includes("stale-extra.md"));
    assert.strictEqual(devStale.vault.readText("cloud-active.md"), "active on cloud", "trust-cloud must restore cloud-active.md instead of deleting it remotely");
    assert.ok(cloud.files.has("/apps/obsidian_vault/cloud-active.md"));

    // 8d. Stale device (>30 days) with 0 unexplained uploads (only tombstoned deletes) -> succeeds seamlessly WITHOUT tripping L3!
    devStale.manifestMgr.updateLastSyncTime(Date.now() - 45 * 86_400_000);
    await devStale.manifestMgr.save();
    const resStaleClean = await devStale.engine.startSync(false);
    assert.strictEqual(resStaleClean.success, true, "Stale device with 0 unexplained uploads must sync cleanly without blocking");
    assert.strictEqual(resStaleClean.staleGuardAborted, undefined);

    // 8e. Setting staleSyncThresholdDays = 0 disables offline-day guard
    devStale.setSettings({ staleSyncThresholdDays: 0 });
    devStale.manifestMgr.updateLastSyncTime(Date.now() - 90 * 86_400_000);
    await devStale.manifestMgr.save();
    devStale.vault.seedFile("disabled-guard-new.md", "allowed", Date.now());
    const resDisabled = await devStale.engine.startSync(false);
    assert.strictEqual(resDisabled.success, true);
    assert.ok(cloud.files.has("/apps/obsidian_vault/disabled-guard-new.md"));
  }

  // 9. GC pruning (TTL + maxEntriesPerDevice) & pendingUpload transient failure self-healing retry
  {
    const cloud = createMockCloud();
    const devA = makeDevice(
      cloud,
      "dev-aaaaaaaaaaaaaaaaaaaaaaaa",
      {},
      { tombstoneRetentionMs: 1000, tombstoneMaxEntriesPerDevice: 3 }
    );
    const now = Date.now();
    devA.tombstoneMgr.recordDeletion("expired.md", { deletedAt: now - 5000 });
    devA.tombstoneMgr.recordDeletion("d1.md", { deletedAt: now - 500 });
    devA.tombstoneMgr.recordDeletion("d2.md", { deletedAt: now - 400 });
    devA.tombstoneMgr.recordDeletion("d3.md", { deletedAt: now - 300 });
    devA.tombstoneMgr.recordDeletion("d4.md", { deletedAt: now - 200 });
    devA.tombstoneMgr.pruneOwnEntries(now);
    assert.strictEqual(devA.tombstoneMgr.getOwnEntryCount(), 3, "GC must drop expired entry and cap to 3 newest entries");
    const merged = devA.tombstoneMgr.getMergedTombstones("dev-aaaaaaaaaaaaaaaaaaaaaaaa", now);
    assert.strictEqual(merged.has("expired.md"), false);
    assert.strictEqual(merged.has("d1.md"), false);
    assert.strictEqual(merged.has("d2.md"), true);
    assert.strictEqual(merged.has("d3.md"), true);
    assert.strictEqual(merged.has("d4.md"), true);

    // Transient failure self-healing: fail tombstone upload on run 1 -> auto-retry succeeds on run 2 (even with 0 vault changes)
    const cloud2 = createMockCloud();
    const devRetry = makeDevice(cloud2, "dev-rrrrrrrrrrrrrrrrrrrrrrrr");
    devRetry.vault.seedFile("ephemeral.md", "bye", Date.now() - 10_000);
    assert.strictEqual((await devRetry.engine.startSync(false)).success, true);

    devRetry.vault.files.delete("ephemeral.md");
    cloud2.setFailTombstoneUploads(true);
    const run1 = await devRetry.engine.startSync(false);
    assert.strictEqual(run1.success, false, "Transient tombstone upload failure must report error");
    assert.strictEqual(devRetry.tombstoneMgr.isOwnShardPendingUpload(), true, "Pending upload flag must persist for retry");

    cloud2.setFailTombstoneUploads(false);
    const run2 = await devRetry.engine.startSync(false);
    assert.strictEqual(run2.success, true, "Next sync must self-heal and upload pending tombstone shard");
    assert.strictEqual(devRetry.tombstoneMgr.isOwnShardPendingUpload(), false);
    assert.ok(cloud2.files.has(buildRemoteTombstonePath("/apps/obsidian_vault", "dev-rrrrrrrrrrrrrrrrrrrrrrrr")));
  }

  // 10. Budgeted lazy localMd5 backfill for legacy E2EE manifests (<= v1.1.4)
  {
    const cloud = createMockCloud();
    const pass = "Legacy-E2EE-Backfill-2026!";
    const devA = makeDevice(
      cloud,
      "dev-aaaaaaaaaaaaaaaaaaaaaaaa",
      { enableE2EE: true, e2eePassword: pass },
      { e2eeMd5BackfillMaxFiles: 2 }
    );
    const devB = makeDevice(cloud, "dev-bbbbbbbbbbbbbbbbbbbbbbbb", { enableE2EE: true, e2eePassword: pass });

    const t0 = Date.now() - 60_000;
    for (let i = 1; i <= 5; i++) {
      devA.vault.seedFile(`e2ee-${i}.md`, `legacy encrypted note #${i}`, t0);
    }
    assert.strictEqual((await devA.engine.startSync(false)).success, true);
    assert.strictEqual((await devB.engine.startSync(false)).success, true);

    // Simulate legacy <= v1.1.4 manifest on devA by stripping localMd5 from all 5 entries
    for (let i = 1; i <= 5; i++) {
      const m = devA.manifestMgr.get(`e2ee-${i}.md`)!;
      devA.manifestMgr.set({ ...m, localMd5: undefined });
    }
    await devA.manifestMgr.save();

    const countBackfilled = () =>
      [1, 2, 3, 4, 5].filter((i) => Boolean(devA.manifestMgr.get(`e2ee-${i}.md`)?.localMd5)).length;
    assert.strictEqual(countBackfilled(), 0);

    // Run 1: budget 2 files -> 2 backfilled, 0 uploads/downloads
    const upBefore = cloud.uploadedPaths.length;
    const r1 = await devA.engine.startSync(false);
    assert.strictEqual(r1.success, true);
    assert.strictEqual(cloud.uploadedPaths.length, upBefore, "Backfill must perform 0 remote uploads");
    assert.strictEqual(countBackfilled(), 2, "Run 1 must honor budget of 2 files");

    // Run 2 -> 4 backfilled; Run 3 -> all 5 backfilled
    assert.strictEqual((await devA.engine.startSync(false)).success, true);
    assert.strictEqual(countBackfilled(), 4);
    assert.strictEqual((await devA.engine.startSync(false)).success, true);
    assert.strictEqual(countBackfilled(), 5);
    assert.strictEqual(
      devA.manifestMgr.get("e2ee-1.md")?.localMd5,
      md5(new TextEncoder().encode("legacy encrypted note #1").slice().buffer)
    );

    // Deleting backfilled e2ee-1.md now writes plaintext deletedHash into encrypted tombstone shard
    devA.vault.files.delete("e2ee-1.md");
    assert.strictEqual((await devA.engine.startSync(false)).success, true);

    // Stale devB with wiped manifest & future-drifted mtime still matches deletedHash and trashes e2ee-1.md!
    await devB.engine.resetLocalBaseline();
    devB.vault.seedFile("e2ee-1.md", "legacy encrypted note #1", Date.now() + 3_600_000);
    const resB = await devB.engine.startSync(false);
    assert.strictEqual(resB.success, true);
    assert.strictEqual(resB.stats.uploaded, 0);
    assert.strictEqual(devB.vault.files.has("e2ee-1.md"), false);
    assert.ok(devB.vault.trashed.includes("e2ee-1.md"));
  }

  // 11. Conservative auto-GC of retired peer device tombstone shards
  {
    const cloud = createMockCloud();
    const now = Date.now();
    const retentionMs = 10_000;
    const graceMs = 5_000; // shard cutoff = 15s ago
    const devActive = makeDevice(
      cloud,
      "dev-active0000000000000001",
      {},
      { tombstoneRetentionMs: retentionMs, tombstoneRetiredShardGraceMs: graceMs }
    );
    devActive.vault.seedFile("alive.md", "still alive", now - 2_000);
    assert.strictEqual((await devActive.engine.startSync(false)).success, true);

    const putShard = (devId: string, entries: Record<string, { deletedAt: number }>, serverMtimeMs: number) => {
      const p = buildRemoteTombstonePath("/apps/obsidian_vault", devId);
      const buf = new TextEncoder()
        .encode(JSON.stringify({ version: 1, deviceId: devId, updatedAt: serverMtimeMs, entries }))
        .slice().buffer;
      cloud.putRaw(p, buf, Math.floor(serverMtimeMs / 1000));
      return p;
    };

    // Retired shard (mtime 30s ago > 15s cutoff, all entries expired > 10s ago) -> MUST be cleaned up
    const retiredPath = putShard(
      "dev-retired000000000000001",
      { "ancient.md": { deletedAt: now - 25_000 } },
      now - 30_000
    );
    // Old mtime shard that STILL has 1 active non-expired entry -> MUST be kept
    const activeEntryPath = putShard(
      "dev-stillvalid000000000002",
      { "recent.md": { deletedAt: now - 2_000 } },
      now - 30_000
    );
    // Empty shard whose mtime is still within grace window (12s ago < 15s cutoff) -> MUST be kept
    const withinGracePath = putShard("dev-grace00000000000000003", {}, now - 12_000);

    const res = await devActive.engine.startSync(false);
    assert.strictEqual(res.success, true);
    assert.strictEqual(cloud.files.has(retiredPath), false, "Fully expired retired peer shard past grace period must be deleted");
    assert.strictEqual(cloud.files.has(activeEntryPath), true, "Shard containing an active tombstone must NEVER be deleted");
    assert.strictEqual(cloud.files.has(withinGracePath), true, "Shard within grace period must NEVER be deleted");
  }

  console.log("   All 3-layer stale-device deletion defense tests passed!");
}

async function runAll() {
  testMD5();
  testI18n();
  testFilter();
  testPlanner();
  await testAsyncQueueConcurrency();
  await testE2EEv2AndLegacyV1();
  await testConfigShare();
  await testBaiduProtocolAndSafety();
  await testSyncEngineIntegration();
  await testBridgeDeadlockCheckpointsAndFastScan();
  await testDataLossProtectionSuite();
  await testDeepAuditProtectionsSuite();
  await testStaleDeviceDeletionDefenseSuite();
  console.log("🎉 All unit & integration tests passed successfully!");
}

runAll().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
