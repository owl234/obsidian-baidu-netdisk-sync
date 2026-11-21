/**
 * Cross-platform End-to-End Encryption (E2EE) using Web Crypto API.
 *
 * Format v2 (current):
 *   [MAGIC_V2: 12B "BDSYNC_E2EE\x02"] + [MASTER_SALT: 16B] + [FILE_SALT: 16B] + [IV: 12B] + [CIPHERTEXT + 16B GCM TAG]
 *   - Master key: PBKDF2-SHA256(password, MASTER_SALT, 600,000) -> 256-bit HKDF key material (in-memory LRU cached)
 *   - Per-file key: HKDF-SHA256(masterKey, salt=FILE_SALT, info="BDSYNC_E2EE_V2_FILE_KEY") -> AES-256-GCM key
 *   - AAD: Entire 56-byte header authenticated by AES-GCM
 *
 * Format v1 (legacy read compatibility):
 *   [MAGIC_V1: 12B "BDSYNC_E2EE\x01"] + [SALT: 16B] + [IV: 12B] + [CIPHERTEXT + 16B GCM TAG]
 *   - Key: PBKDF2-SHA256(password, SALT, 600,000) with fallback to 100,000 (pre-v1.0.7)
 */

import { t } from "../i18n";

const MAGIC_HEADER_V1 = new Uint8Array([
  0x42, 0x44, 0x53, 0x59, 0x4e, 0x43, 0x5f, 0x45, 0x32, 0x45, 0x45, 0x01
]); // "BDSYNC_E2EE\x01"

const MAGIC_HEADER_V2 = new Uint8Array([
  0x42, 0x44, 0x53, 0x59, 0x4e, 0x43, 0x5f, 0x45, 0x32, 0x45, 0x45, 0x02
]); // "BDSYNC_E2EE\x02"

const HKDF_INFO_V2 = new TextEncoder().encode("BDSYNC_E2EE_V2_FILE_KEY");
const SALT_LEN = 16;
const IV_LEN = 12;
const GCM_TAG_LEN = 16;
const V1_HEADER_LEN = MAGIC_HEADER_V1.length + SALT_LEN + IV_LEN; // 40
const V2_HEADER_LEN = MAGIC_HEADER_V2.length + SALT_LEN + SALT_LEN + IV_LEN; // 56

export const PBKDF2_ITERATIONS = 600000;
export const LEGACY_PBKDF2_ITERATIONS = 100000;

export interface EncryptOptions {
  /**
   * When true, generates a fresh random masterSalt rather than reusing the session masterSalt.
   * Useful for standalone payloads like pairing codes.
   */
  ephemeralMasterSalt?: boolean;
}

const MAX_KEY_CACHE_ENTRIES = 16;
const masterKeyCache = new Map<string, Promise<CryptoKey>>();
let sessionMasterSalt: Uint8Array | null = null;

function getCrypto(): Crypto {
  if (typeof activeWindow !== "undefined" && activeWindow.crypto) {
    return activeWindow.crypto;
  }
  if (typeof window !== "undefined" && window.crypto) {
    return window.crypto;
  }
  return crypto;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function matchesHeader(view: Uint8Array, expected: Uint8Array): boolean {
  if (view.length < expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (view[i] !== expected[i]) return false;
  }
  return true;
}

export function getEncryptionVersion(buffer: ArrayBuffer): 0 | 1 | 2 {
  if (buffer.byteLength >= V2_HEADER_LEN + GCM_TAG_LEN) {
    const view = new Uint8Array(buffer, 0, MAGIC_HEADER_V2.length);
    if (matchesHeader(view, MAGIC_HEADER_V2)) {
      return 2;
    }
  }
  if (buffer.byteLength >= V1_HEADER_LEN + GCM_TAG_LEN) {
    const view = new Uint8Array(buffer, 0, MAGIC_HEADER_V1.length);
    if (matchesHeader(view, MAGIC_HEADER_V1)) {
      return 1;
    }
  }
  return 0;
}

export function isEncrypted(buffer: ArrayBuffer): boolean {
  return getEncryptionVersion(buffer) !== 0;
}

/**
 * Clears in-memory cached PBKDF2 master keys and rotates the session master salt.
 * Call on plugin unload or when the user changes their E2EE password.
 */
export function clearKeyCache(): void {
  masterKeyCache.clear();
  sessionMasterSalt = null;
}

function getOrCreateSessionMasterSalt(): Uint8Array {
  if (!sessionMasterSalt) {
    sessionMasterSalt = getCrypto().getRandomValues(new Uint8Array(SALT_LEN));
  }
  return sessionMasterSalt;
}

/**
 * Legacy v1 PBKDF2 -> AES-256-GCM key derivation (exported for backward-compatibility tests).
 */
export async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const webCrypto = getCrypto();
  const keyMaterial = await webCrypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return webCrypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: iterations,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function deriveMasterHkdfKey(password: string, masterSalt: Uint8Array): Promise<CryptoKey> {
  const cacheKey = `${password.length}:${password}:${bytesToHex(masterSalt)}`;
  const cached = masterKeyCache.get(cacheKey);
  if (cached) {
    // Refresh LRU order
    masterKeyCache.delete(cacheKey);
    masterKeyCache.set(cacheKey, cached);
    return cached;
  }

  const derivationPromise = (async () => {
    const enc = new TextEncoder();
    const webCrypto = getCrypto();
    const keyMaterial = await webCrypto.subtle.importKey(
      "raw",
      enc.encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveBits"]
    );

    const masterBits = await webCrypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: masterSalt,
        iterations: PBKDF2_ITERATIONS,
        hash: "SHA-256"
      },
      keyMaterial,
      256
    );

    return webCrypto.subtle.importKey("raw", masterBits, { name: "HKDF" }, false, ["deriveKey"]);
  })();

  masterKeyCache.set(cacheKey, derivationPromise);

  // Evict oldest if cache exceeds limit
  if (masterKeyCache.size > MAX_KEY_CACHE_ENTRIES) {
    const firstKey = masterKeyCache.keys().next();
    if (!firstKey.done) {
      masterKeyCache.delete(firstKey.value);
    }
  }

  try {
    return await derivationPromise;
  } catch (err) {
    masterKeyCache.delete(cacheKey);
    throw err;
  }
}

async function deriveFileKeyV2(masterHkdfKey: CryptoKey, fileSalt: Uint8Array): Promise<CryptoKey> {
  const webCrypto = getCrypto();
  return webCrypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: fileSalt,
      info: HKDF_INFO_V2
    },
    masterHkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptData(
  data: ArrayBuffer,
  password: string,
  options: EncryptOptions = {}
): Promise<ArrayBuffer> {
  const webCrypto = getCrypto();
  const masterSalt = options.ephemeralMasterSalt
    ? webCrypto.getRandomValues(new Uint8Array(SALT_LEN))
    : getOrCreateSessionMasterSalt();
  const fileSalt = webCrypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = webCrypto.getRandomValues(new Uint8Array(IV_LEN));

  const header = new Uint8Array(V2_HEADER_LEN);
  let offset = 0;
  header.set(MAGIC_HEADER_V2, offset);
  offset += MAGIC_HEADER_V2.length;
  header.set(masterSalt, offset);
  offset += SALT_LEN;
  header.set(fileSalt, offset);
  offset += SALT_LEN;
  header.set(iv, offset);

  const masterHkdfKey = await deriveMasterHkdfKey(password, masterSalt);
  const fileKey = await deriveFileKeyV2(masterHkdfKey, fileSalt);

  const ciphertext = await webCrypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv,
      additionalData: header
    },
    fileKey,
    data
  );

  const result = new Uint8Array(V2_HEADER_LEN + ciphertext.byteLength);
  result.set(header, 0);
  result.set(new Uint8Array(ciphertext), V2_HEADER_LEN);

  return result.buffer;
}

export async function decryptData(
  encryptedBuffer: ArrayBuffer,
  password: string
): Promise<ArrayBuffer> {
  const version = getEncryptionVersion(encryptedBuffer);
  if (version === 0) {
    return encryptedBuffer;
  }

  const webCrypto = getCrypto();

  if (version === 2) {
    const header = new Uint8Array(encryptedBuffer, 0, V2_HEADER_LEN);
    let offset = MAGIC_HEADER_V2.length;
    const masterSalt = new Uint8Array(encryptedBuffer, offset, SALT_LEN);
    offset += SALT_LEN;
    const fileSalt = new Uint8Array(encryptedBuffer, offset, SALT_LEN);
    offset += SALT_LEN;
    const iv = new Uint8Array(encryptedBuffer, offset, IV_LEN);
    const ciphertext = encryptedBuffer.slice(V2_HEADER_LEN);

    try {
      const masterHkdfKey = await deriveMasterHkdfKey(password, masterSalt);
      const fileKey = await deriveFileKeyV2(masterHkdfKey, fileSalt);
      return await webCrypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: iv,
          additionalData: header
        },
        fileKey,
        ciphertext
      );
    } catch {
      throw new Error(t("e2ee.decryptFailed"));
    }
  }

  // Legacy v1 path
  let offset = MAGIC_HEADER_V1.length;
  const salt = new Uint8Array(encryptedBuffer, offset, SALT_LEN);
  offset += SALT_LEN;

  const iv = new Uint8Array(encryptedBuffer, offset, IV_LEN);
  offset += IV_LEN;

  const ciphertext = encryptedBuffer.slice(offset);

  // Try current standard iterations (600,000) first
  try {
    const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
    return await webCrypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv
      },
      key,
      ciphertext
    );
  } catch {
    // Graceful backward compatibility fallback:
    // Try legacy iterations (100,000) used prior to v1.0.7
    try {
      const legacyKey = await deriveKey(password, salt, LEGACY_PBKDF2_ITERATIONS);
      return await webCrypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: iv
        },
        legacyKey,
        ciphertext
      );
    } catch {
      throw new Error(t("e2ee.decryptFailed"));
    }
  }
}
