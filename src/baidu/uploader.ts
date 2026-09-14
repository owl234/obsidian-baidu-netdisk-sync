import { BaiduClient } from "./client";
import { md5 } from "../crypto/md5";
import { encryptData } from "../crypto/e2ee";
import { BaiduCreateResponse } from "./types";

const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB slice size for Baidu PCS

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

    // Optional End-to-End Encryption
    if (options.enableE2EE && options.e2eePassword) {
      payload = await encryptData(payload, options.e2eePassword);
    }

    const totalSize = payload.byteLength;
    const totalParts = Math.max(1, Math.ceil(totalSize / CHUNK_SIZE));
    const blockList: string[] = [];

    // Calculate MD5 for each 4MB chunk
    for (let i = 0; i < totalParts; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, totalSize);
      const slice = payload.slice(start, end);
      const partMd5 = md5(slice);
      blockList.push(partMd5);
    }

    // Step 1: Precreate
    const precreateRes = await this.client.precreate(remotePath, totalSize, blockList);

    // Step 2: Upload Slices (if needed)
    const uploadId = precreateRes.uploadid;
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
