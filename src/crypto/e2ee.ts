/**
 * Cross-platform End-to-End Encryption (E2EE) using Web Crypto API.
 * Uses PBKDF2 (100,000 iterations of SHA-256) + AES-256-GCM.
 * File format: [MAGIC: 12 bytes] + [SALT: 16 bytes] + [IV: 12 bytes] + [CIPHERTEXT + TAG]
 */

const MAGIC_HEADER = new Uint8Array([0x42, 0x44, 0x53, 0x59, 0x4e, 0x43, 0x5f, 0x45, 0x32, 0x45, 0x45, 0x01]); // "BDSYNC_E2EE\x01"
export const PBKDF2_ITERATIONS = 600000;
export const LEGACY_PBKDF2_ITERATIONS = 100000;

export function isEncrypted(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < MAGIC_HEADER.length + 16 + 12 + 16) {
    return false;
  }
  const view = new Uint8Array(buffer, 0, MAGIC_HEADER.length);
  for (let i = 0; i < MAGIC_HEADER.length; i++) {
    if (view[i] !== MAGIC_HEADER[i]) {
      return false;
    }
  }
  return true;
}

function getCrypto(): Crypto {
  if (typeof activeWindow !== "undefined" && activeWindow.crypto) {
    return activeWindow.crypto;
  }
  if (typeof window !== "undefined" && window.crypto) {
    return window.crypto;
  }
  return crypto;
}

export async function deriveKey(password: string, salt: Uint8Array, iterations: number = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const crypto = getCrypto();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
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

export async function encryptData(data: ArrayBuffer, password: string): Promise<ArrayBuffer> {
  const crypto = getCrypto();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv
    },
    key,
    data
  );

  const totalLength = MAGIC_HEADER.length + salt.length + iv.length + ciphertext.byteLength;
  const result = new Uint8Array(totalLength);

  let offset = 0;
  result.set(MAGIC_HEADER, offset);
  offset += MAGIC_HEADER.length;

  result.set(salt, offset);
  offset += salt.length;

  result.set(iv, offset);
  offset += iv.length;

  result.set(new Uint8Array(ciphertext), offset);

  return result.buffer;
}

export async function decryptData(encryptedBuffer: ArrayBuffer, password: string): Promise<ArrayBuffer> {
  if (!isEncrypted(encryptedBuffer)) {
    // If not encrypted, return raw data
    return encryptedBuffer;
  }

  let offset = MAGIC_HEADER.length;
  const salt = new Uint8Array(encryptedBuffer, offset, 16);
  offset += 16;

  const iv = new Uint8Array(encryptedBuffer, offset, 12);
  offset += 12;

  const ciphertext = encryptedBuffer.slice(offset);
  const crypto = getCrypto();

  // Try current standard iterations (600,000) first
  try {
    const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
    return await crypto.subtle.decrypt(
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
      return await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: iv
        },
        legacyKey,
        ciphertext
      );
    } catch {
      throw new Error("E2EE 解密失败：密码错误或文件损坏");
    }
  }
}
