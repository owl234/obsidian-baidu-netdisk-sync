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
import { SyncEngine, VaultSyncBridge } from "../src/sync/engine";
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
  console.log("🎉 All unit & integration tests passed successfully!");
}

runAll().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
