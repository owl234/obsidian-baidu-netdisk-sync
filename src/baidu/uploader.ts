import { BaiduClient } from "./client";
import { md5 } from "../crypto/md5";
import { encryptData } from "../crypto/e2ee";
import { BaiduCreateResponse } from "./types";
import { t } from "../i18n";

const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB slice size for Baidu PCS
const RAPID_SLICE_SIZE = 256 * 1024; // First 256KB used for Baidu slice-md5

export interface UploadOptions {
  enableE2EE?: boolean;
  e2eePassword?: string;
  onProgress?: (uploadedParts: number, totalParts: number) => void;
}

export class BaiduUploader {
  constructor(private client: BaiduClient) {}

  async uploadFile(
    remotePath: string,
    fileBuffer: ArrayBuffer,
    options: UploadOptions = {}
  ): Promise<BaiduCreateResponse> {
    let payload = fileBuffer;

    // Optional End-to-End Encryption (v2: cached master key + per-file HKDF)
    if (options.enableE2EE) {
      if (!options.e2eePassword) {
        throw new Error(t("e2ee.missingPasswordUpload"));
      }
      payload = await encryptData(payload, options.e2eePassword);
    }

    const totalSize = payload.byteLength;
    const totalParts = Math.max(1, Math.ceil(totalSize / CHUNK_SIZE));
    const blockList: string[] = [];

    // Calculate MD5 for each 4MB chunk (handles 0-byte files cleanly with empty MD5)
    for (let i = 0; i < totalParts; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, totalSize);
      const slice = new Uint8Array(payload, start, end - start);
      blockList.push(md5(slice));
    }

    // Compute rapid-upload hashes (content-md5 + first 256KB slice-md5) for non-empty files
    let rapidHashes: { contentMd5?: string; sliceMd5?: string } | undefined;
    if (totalSize > 0) {
      const contentMd5 = totalParts === 1 ? blockList[0] : md5(payload);
      const sliceLen = Math.min(RAPID_SLICE_SIZE, totalSize);
      const sliceMd5 =
        sliceLen === totalSize && totalParts === 1
          ? blockList[0]
          : md5(new Uint8Array(payload, 0, sliceLen));
      rapidHashes = { contentMd5, sliceMd5 };
    }

    // Step 1: Precreate (may complete instantly via rapid upload when return_type === 2)
    const precreateRes = await this.client.precreate(remotePath, totalSize, blockList, rapidHashes);

    if (precreateRes.return_type === 2 && precreateRes.info) {
      const info = precreateRes.info;
      const fallbackName = remotePath.slice(remotePath.lastIndexOf("/") + 1);
      return {
        errno: 0,
        fs_id: info.fs_id,
        md5: info.md5 || rapidHashes?.contentMd5 || blockList[0] || "",
        server_filename: info.server_filename || fallbackName,
        category: info.category ?? 6,
        path: info.path || remotePath,
        size: info.size ?? totalSize,
        ctime: info.ctime ?? Math.floor(Date.now() / 1000),
        mtime: info.mtime ?? info.server_mtime ?? Math.floor(Date.now() / 1000),
        isdir: info.isdir ?? 0
      };
    }

    // Step 2: Upload Slices (only parts requested by server)
    const uploadId = precreateRes.uploadid;
    if (!uploadId) {
      throw new Error(
        t("client.precreateApiError", {
          errno: String(precreateRes.errno ?? "unknown"),
          detail: "missing uploadid"
        })
      );
    }
    const neededParts =
      precreateRes.block_list && Array.isArray(precreateRes.block_list)
        ? precreateRes.block_list
        : [];

    for (let idx = 0; idx < neededParts.length; idx++) {
      const partseq = neededParts[idx];
      const start = partseq * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, totalSize);
      const slice = payload.slice(start, end);

      await this.client.uploadSlice(remotePath, uploadId, partseq, slice);
      options.onProgress?.(idx + 1, neededParts.length);
    }

    // Step 3: Commit / Create File
    const commitRes = await this.client.createFile(remotePath, totalSize, uploadId, blockList);
    return commitRes;
  }
}
