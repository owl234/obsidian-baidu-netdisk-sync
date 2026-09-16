import assert from "assert";
import { md5 } from "../src/crypto/md5";
import { SyncPlanner, LocalFileInfo, RemoteFileInfo } from "../src/sync/planner";
import { SyncFilter } from "../src/sync/filter";
import { DEFAULT_SETTINGS } from "../src/settings/settings";
import { exportEncryptedConfig, importEncryptedConfig } from "../src/crypto/configShare";

function testMD5() {
  console.log("-> Testing MD5...");
  const enc = new TextEncoder();

  // Test vector 1: empty string
  const emptyHash = md5(enc.encode(""));
  assert.strictEqual(emptyHash, "d41d8cd98f00b204e9800998ecf8427e", "Empty string MD5 mismatch");

  // Test vector 2: "hello world"
  const helloHash = md5(enc.encode("hello world"));
  assert.strictEqual(helloHash, "5eb63bbbe01eeed093cb22bb8f5acdc3", "'hello world' MD5 mismatch");

  // Test vector 3: 4MB slice of repeated bytes
  const largeBuf = new Uint8Array(4 * 1024 * 1024);
  largeBuf.fill(0x42);
  const largeHash = md5(largeBuf);
  assert.ok(largeHash && largeHash.length === 32, "4MB slice hash valid format");
  console.log("   MD5 tests passed! 4MB hash:", largeHash);
}

function testFilter() {
  console.log("-> Testing SyncFilter...");
  const filter = new SyncFilter(DEFAULT_SETTINGS);

  // Manifest should be ignored
  assert.strictEqual(filter.shouldIgnore(".obsidian/plugins/obsidian-baidu-netdisk-sync/main.js"), true);
  assert.strictEqual(filter.shouldIgnore("sync_manifest.json"), true);

  // Trash & git
  assert.strictEqual(filter.shouldIgnore(".trash/some-note.md"), true);
  assert.strictEqual(filter.shouldIgnore(".git/config"), true);

  // Workspace should be ignored
  assert.strictEqual(filter.shouldIgnore(".obsidian/workspace.json"), true);
  assert.strictEqual(filter.shouldIgnore(".obsidian/workspace-mobile.json"), true);

  // Regular notes and attachments should NOT be ignored
  assert.strictEqual(filter.shouldIgnore("Notes/Daily.md"), false);
  assert.strictEqual(filter.shouldIgnore("Assets/image.png"), false);

  // Custom pattern test
  const customSettings = {
    ...DEFAULT_SETTINGS,
    ignoredPatterns: "**/*.secret\ntemp/**"
  };
  const filter2 = new SyncFilter(customSettings);
  assert.strictEqual(filter2.shouldIgnore("sub/test.secret"), true);
  assert.strictEqual(filter2.shouldIgnore("temp/file.txt"), true);
  assert.strictEqual(filter2.shouldIgnore("temp2/file.txt"), false);

  console.log("   SyncFilter tests passed!");
}

function testPlannerLWW() {
  console.log("-> Testing SyncPlanner (3-Way Diff with LWW)...");

  const remoteBasePath = "/apps/obsidian_vault";

  // Scenario 1: Brand new local file -> UPLOAD
  {
    const local = new Map<string, LocalFileInfo>([
      ["new.md", { path: "new.md", mtime: 1000, size: 50 }]
    ]);
    const remote = new Map<string, RemoteFileInfo>();
    const manifest = {};
    const plans = SyncPlanner.plan(local, remote, manifest, remoteBasePath);
    assert.strictEqual(plans.length, 1);
    assert.strictEqual(plans[0].action, "UPLOAD");
  }

  // Scenario 2: Brand new remote file -> DOWNLOAD
  {
    const local = new Map<string, LocalFileInfo>();
    const remote = new Map<string, RemoteFileInfo>([
      ["remote.md", { path: "remote.md", remotePath: "/apps/obsidian_vault/remote.md", mtime: 2000, size: 100, fsId: 123 }]
    ]);
    const manifest = {};
    const plans = SyncPlanner.plan(local, remote, manifest, remoteBasePath);
    assert.strictEqual(plans.length, 1);
    assert.strictEqual(plans[0].action, "DOWNLOAD");
  }

  // Scenario 3: Concurrent edit conflict -> LWW: Local newer -> UPLOAD
  {
    const local = new Map<string, LocalFileInfo>([
      ["conflict.md", { path: "conflict.md", mtime: 5000, size: 80 }]
    ]);
    const remote = new Map<string, RemoteFileInfo>([
      ["conflict.md", { path: "conflict.md", remotePath: "/apps/obsidian_vault/conflict.md", mtime: 4000, size: 70, fsId: 456 }]
    ]);
    const manifest = {
      "conflict.md": {
        path: "conflict.md",
        remotePath: "/apps/obsidian_vault/conflict.md",
        mtime: 1000,
        remoteMtime: 1000,
        md5: "abc",
        size: 60
      }
    };
    const plans = SyncPlanner.plan(local, remote, manifest, remoteBasePath);
    assert.strictEqual(plans.length, 1);
    assert.strictEqual(plans[0].action, "UPLOAD");
    assert.ok(plans[0].reason.includes("LWW 覆盖远端"));
  }

  // Scenario 4: Concurrent edit conflict -> LWW: Remote newer -> DOWNLOAD
  {
    const local = new Map<string, LocalFileInfo>([
      ["conflict.md", { path: "conflict.md", mtime: 3000, size: 80 }]
    ]);
    const remote = new Map<string, RemoteFileInfo>([
      ["conflict.md", { path: "conflict.md", remotePath: "/apps/obsidian_vault/conflict.md", mtime: 6000, size: 70, fsId: 456 }]
    ]);
    const manifest = {
      "conflict.md": {
        path: "conflict.md",
        remotePath: "/apps/obsidian_vault/conflict.md",
        mtime: 1000,
        remoteMtime: 1000,
        md5: "abc",
        size: 60
      }
    };
    const plans = SyncPlanner.plan(local, remote, manifest, remoteBasePath);
    assert.strictEqual(plans.length, 1);
    assert.strictEqual(plans[0].action, "DOWNLOAD");
    assert.ok(plans[0].reason.includes("LWW 覆盖本地"));
  }

  // Scenario 5: Remote deleted, local unchanged -> DELETE_LOCAL
  {
    const local = new Map<string, LocalFileInfo>([
      ["del.md", { path: "del.md", mtime: 1000, size: 50 }]
    ]);
    const remote = new Map<string, RemoteFileInfo>();
    const manifest = {
      "del.md": {
        path: "del.md",
        remotePath: "/apps/obsidian_vault/del.md",
        mtime: 1000,
        remoteMtime: 1000,
        md5: "abc",
        size: 50
      }
    };
    const plans = SyncPlanner.plan(local, remote, manifest, remoteBasePath);
    assert.strictEqual(plans.length, 1);
    assert.strictEqual(plans[0].action, "DELETE_LOCAL");
  }

  // Scenario 6: Local deleted, remote unchanged -> DELETE_REMOTE
  {
    const local = new Map<string, LocalFileInfo>();
    const remote = new Map<string, RemoteFileInfo>([
      ["del2.md", { path: "del2.md", remotePath: "/apps/obsidian_vault/del2.md", mtime: 1000, size: 50, fsId: 789 }]
    ]);
    const manifest = {
      "del2.md": {
        path: "del2.md",
        remotePath: "/apps/obsidian_vault/del2.md",
        mtime: 1000,
        remoteMtime: 1000,
        md5: "abc",
        size: 50
      }
    };
    const plans = SyncPlanner.plan(local, remote, manifest, remoteBasePath);
    assert.strictEqual(plans.length, 1);
    assert.strictEqual(plans[0].action, "DELETE_REMOTE");
  }

  console.log("   SyncPlanner tests passed!");
}

async function testConfigShare() {
  console.log("-> Testing ConfigShare (Multi-device encrypted config export/import)...");
  const dummySettings: any = {
    ...DEFAULT_SETTINGS,
    appKey: "testAppKey123",
    appSecret: "testAppSecret456",
    accessToken: "fakeToken123456",
    refreshToken: "fakeRefresh789",
    tokenExpiresAt: 1735689600000,
    remoteBasePath: "/apps/test_sync",
    syncObsidianConfig: true,
    syncPlugins: true,
    syncThemes: false,
    ignoredPatterns: "**/.git/**\n**/workspace*.json",
    concurrency: 4,
    enableE2EE: true,
    e2eePassword: "MyMasterVaultPassword!"
  };

  const pin = "SafePin9876";

  // 1. Export encrypted pairing code
  const pairingCode = await exportEncryptedConfig(dummySettings, pin);
  assert.ok(pairingCode.startsWith("BDSYNC:v1:"), "Pairing code must start with BDSYNC:v1:");

  // 2. Import with correct pin
  const imported = await importEncryptedConfig(pairingCode, pin);
  assert.strictEqual(imported.appKey, dummySettings.appKey, "appKey mismatch");
  assert.strictEqual(imported.appSecret, dummySettings.appSecret, "appSecret mismatch");
  assert.strictEqual(imported.accessToken, dummySettings.accessToken, "accessToken mismatch");
  assert.strictEqual(imported.refreshToken, dummySettings.refreshToken, "refreshToken mismatch");
  assert.strictEqual(imported.remoteBasePath, dummySettings.remoteBasePath, "remoteBasePath mismatch");
  assert.strictEqual(imported.enableE2EE, true, "enableE2EE mismatch");
  assert.strictEqual(imported.e2eePassword, "MyMasterVaultPassword!", "e2eePassword mismatch");
  assert.strictEqual(imported.concurrency, 4, "concurrency mismatch");

  // 3. Import with incorrect pin -> should fail
  let failed = false;
  try {
    await importEncryptedConfig(pairingCode, "WrongPin123");
  } catch (err: any) {
    failed = true;
    assert.ok(err.message.includes("解密失败"), "Error message should mention decryption failure");
  }
  assert.ok(failed, "Import with wrong PIN must throw error");

  // 4. Corrupted code -> should fail
  let corruptedFailed = false;
  try {
    await importEncryptedConfig("BDSYNC:v1:corruptedPayload!!!", pin);
  } catch (err) {
    corruptedFailed = true;
  }
  assert.ok(corruptedFailed, "Import with corrupted code must throw error");

  // 5. Empty / Whitespace PIN boundary tests
  let emptyPinExport = false;
  try {
    await exportEncryptedConfig(dummySettings, "   ");
  } catch (err: any) {
    emptyPinExport = true;
    assert.ok(err.message.includes("不能为空"), "Must reject empty pin on export");
  }
  assert.ok(emptyPinExport, "Export with empty PIN must throw");

  let emptyPinImport = false;
  try {
    await importEncryptedConfig(pairingCode, "  ");
  } catch (err: any) {
    emptyPinImport = true;
    assert.ok(err.message.includes("请输入配对保护密码"), "Must reject empty pin on import");
  }
  assert.ok(emptyPinImport, "Import with empty PIN must throw");

  // 6. Security Defense: Reject Plaintext Downgrade / PIN Bypass Attack
  const fakePlaintextJson = JSON.stringify({
    remoteBasePath: "/hacked",
    appKey: "evilKey",
    appSecret: "evilSecret"
  });
  const unencryptedBase64 = Buffer.from(fakePlaintextJson).toString("base64");
  const bypassPayload = `BDSYNC:v1:${unencryptedBase64}`;

  let downgradeBlocked = false;
  try {
    await importEncryptedConfig(bypassPayload, "AnyPin");
  } catch (err: any) {
    downgradeBlocked = true;
    assert.ok(err.message.includes("未经过加密保护"), "Must block unencrypted downgrade payload");
  }
  assert.ok(downgradeBlocked, "Plaintext downgrade bypass attack must be blocked");

  console.log("   ConfigShare tests passed!");
}

async function runAll() {
  testMD5();
  testFilter();
  testPlannerLWW();
  await testConfigShare();
  console.log("🎉 All unit tests passed successfully!");
}

runAll().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
