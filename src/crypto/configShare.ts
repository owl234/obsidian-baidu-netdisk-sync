import { encryptData, decryptData, isEncrypted } from "./e2ee";
import type { BaiduSyncSettings } from "../settings/settings";

export interface SharedSyncConfig {
  appKey: string;
  appSecret: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number;
  remoteBasePath: string;
  syncObsidianConfig: boolean;
  syncPlugins: boolean;
  syncThemes: boolean;
  ignoredPatterns: string;
  concurrency: number;
  enableE2EE: boolean;
  e2eePassword?: string;
}

const CONFIG_HEADER_PREFIX = "BDSYNC:v1:";

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  const chunkSize = 0x8000;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = Array.from(bytes.subarray(i, Math.min(i + chunkSize, len)));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const clean = base64.trim();
  try {
    const binary = atob(clean);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    throw new Error("配对码格式无效（Base64解析失败），请检查是否完整复制！");
  }
}

/**
 * Encrypt and export settings as a single portable pairing string.
 */
export async function exportEncryptedConfig(
  settings: BaiduSyncSettings,
  pin: string
): Promise<string> {
  if (!pin || pin.trim().length === 0) {
    throw new Error("配对保护密码不能为空，请设置一个临时配对密码！");
  }

  const exportPayload: SharedSyncConfig = {
    appKey: settings.appKey,
    appSecret: settings.appSecret,
    accessToken: settings.accessToken,
    refreshToken: settings.refreshToken,
    tokenExpiresAt: settings.tokenExpiresAt,
    remoteBasePath: settings.remoteBasePath,
    syncObsidianConfig: settings.syncObsidianConfig,
    syncPlugins: settings.syncPlugins,
    syncThemes: settings.syncThemes,
    ignoredPatterns: settings.ignoredPatterns,
    concurrency: settings.concurrency,
    enableE2EE: settings.enableE2EE,
    e2eePassword: settings.e2eePassword
  };

  const jsonStr = JSON.stringify(exportPayload);
  const enc = new TextEncoder();
  const rawData = enc.encode(jsonStr).buffer;

  const encryptedBuf = await encryptData(rawData, pin.trim());
  const b64 = uint8ArrayToBase64(new Uint8Array(encryptedBuf));
  return `${CONFIG_HEADER_PREFIX}${b64}`;
}

/**
 * Decrypt a pairing string and parse the sync configuration.
 */
export async function importEncryptedConfig(
  pairingCode: string,
  pin: string
): Promise<SharedSyncConfig> {
  const trimmed = pairingCode.trim();
  if (!trimmed.startsWith(CONFIG_HEADER_PREFIX)) {
    throw new Error("无效的配对码格式！配对码必须以 BDSYNC:v1: 开头。");
  }

  if (!pin || pin.trim().length === 0) {
    throw new Error("请输入配对保护密码！");
  }

  const base64Part = trimmed.slice(CONFIG_HEADER_PREFIX.length);
  const encryptedBytes = base64ToUint8Array(base64Part);

  // Enforce cryptographic magic header check to prevent plaintext downgrade / PIN bypass attacks
  if (!isEncrypted(encryptedBytes.buffer)) {
    throw new Error("非法配对码：数据未经过加密保护，已被系统拒绝！");
  }

  let decryptedBuf: ArrayBuffer;
  try {
    decryptedBuf = await decryptData(encryptedBytes.buffer, pin.trim());
  } catch {
    throw new Error("配对码解密失败！请确认配对保护密码是否与导出时一致。");
  }

  const dec = new TextDecoder();
  const jsonStr = dec.decode(decryptedBuf);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error("解析配置数据失败，解密内容不是有效的 JSON 结构。");
  }

  if (!parsed || typeof parsed !== "object" || !("remoteBasePath" in parsed)) {
    throw new Error("配置数据格式不完整或已损坏。");
  }

  return parsed as SharedSyncConfig;
}
