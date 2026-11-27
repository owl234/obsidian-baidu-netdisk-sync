import { encryptData, decryptData, isEncrypted } from "./e2ee";
import type { BaiduSyncSettings, ConflictStrategy } from "../settings/settings";
import { t } from "../i18n";

export interface SharedSyncConfig {
  appKey: string;
  appSecret: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number;
  remoteBasePath: string;
  conflictStrategy?: ConflictStrategy;
  syncObsidianConfig: boolean;
  syncPlugins: boolean;
  syncThemes: boolean;
  ignoredPatterns: string;
  concurrency: number;
  maxFileSizeMB?: number;
  staleSyncThresholdDays?: number;
  enableE2EE: boolean;
  e2eePassword?: string;
}

const CONFIG_HEADER_PREFIX = "BDSYNC:v1:";

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

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
    throw new Error(t("configShare.invalidBase64"));
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
    throw new Error(t("configShare.emptyPinExport"));
  }

  const exportPayload: SharedSyncConfig = {
    appKey: settings.appKey,
    appSecret: settings.appSecret,
    accessToken: settings.accessToken,
    refreshToken: settings.refreshToken,
    tokenExpiresAt: settings.tokenExpiresAt,
    remoteBasePath: settings.remoteBasePath,
    conflictStrategy: settings.conflictStrategy,
    syncObsidianConfig: settings.syncObsidianConfig,
    syncPlugins: settings.syncPlugins,
    syncThemes: settings.syncThemes,
    ignoredPatterns: settings.ignoredPatterns,
    concurrency: settings.concurrency,
    maxFileSizeMB: settings.maxFileSizeMB,
    staleSyncThresholdDays: settings.staleSyncThresholdDays,
    enableE2EE: settings.enableE2EE,
    e2eePassword: settings.e2eePassword
  };

  const jsonStr = JSON.stringify(exportPayload);
  const enc = new TextEncoder();
  const rawData = toExactArrayBuffer(enc.encode(jsonStr));

  const encryptedBuf = await encryptData(rawData, pin.trim(), { ephemeralMasterSalt: true });
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
    throw new Error(t("configShare.invalidPrefix"));
  }

  if (!pin || pin.trim().length === 0) {
    throw new Error(t("configShare.emptyPinImport"));
  }

  const base64Part = trimmed.slice(CONFIG_HEADER_PREFIX.length);
  const encryptedBytes = base64ToUint8Array(base64Part);
  const encryptedBuffer = toExactArrayBuffer(encryptedBytes);

  // Enforce cryptographic magic header check to prevent plaintext downgrade / PIN bypass attacks
  if (!isEncrypted(encryptedBuffer)) {
    throw new Error(t("configShare.unencryptedRejected"));
  }

  let decryptedBuf: ArrayBuffer;
  try {
    decryptedBuf = await decryptData(encryptedBuffer, pin.trim());
  } catch {
    throw new Error(t("configShare.decryptFailed"));
  }

  const dec = new TextDecoder();
  const jsonStr = dec.decode(decryptedBuf);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(t("configShare.invalidJson"));
  }

  if (!parsed || typeof parsed !== "object" || !("remoteBasePath" in parsed)) {
    throw new Error(t("configShare.incompletePayload"));
  }

  return parsed as SharedSyncConfig;
}
