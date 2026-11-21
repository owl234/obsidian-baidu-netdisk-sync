import { BaiduClient } from "./client";
import { BaiduFileMeta } from "./types";
import { decryptData, isEncrypted } from "../crypto/e2ee";
import { t } from "../i18n";

export interface DownloadOptions {
  e2eePassword?: string;
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
}

export class BaiduDownloader {
  constructor(private client: BaiduClient) {}

  async downloadWithMeta(
    meta: BaiduFileMeta,
    options: DownloadOptions = {}
  ): Promise<ArrayBuffer> {
    if (!meta.dlink) {
      throw new Error(t("client.downloadMissingDlink", { fsId: String(meta.fs_id) }));
    }

    const rawBuffer = await this.client.downloadFile(meta.dlink);

    // Check if file is encrypted with E2EE (supports v1 and v2)
    if (isEncrypted(rawBuffer)) {
      if (!options.e2eePassword) {
        throw new Error(t("e2ee.missingPassword"));
      }
      return decryptData(rawBuffer, options.e2eePassword);
    }

    return rawBuffer;
  }

  async downloadByFsId(
    fsId: string | number,
    options: DownloadOptions = {}
  ): Promise<ArrayBuffer> {
    const meta = await this.client.getFileMeta(fsId);
    return this.downloadWithMeta(meta, options);
  }
}
