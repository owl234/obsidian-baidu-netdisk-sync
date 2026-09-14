import { BaiduClient } from "./client";
import { decryptData, isEncrypted } from "../crypto/e2ee";

export interface DownloadOptions {
  e2eePassword?: string;
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
}

export class BaiduDownloader {
  constructor(private client: BaiduClient) {}

  async downloadByFsId(
    fsId: string | number,
    options: DownloadOptions = {}
  ): Promise<ArrayBuffer> {
    const meta = await this.client.getFileMeta(fsId);
    if (!meta.dlink) {
      throw new Error(`文件元数据中缺少 dlink (fsId: ${fsId})`);
    }

    const rawBuffer = await this.client.downloadFile(meta.dlink);

    // Check if file is encrypted with E2EE
    if (isEncrypted(rawBuffer)) {
      if (!options.e2eePassword) {
        throw new Error("检测到该文件已使用 E2EE 端到端加密，请在设置中配置解密密码");
      }
      return await decryptData(rawBuffer, options.e2eePassword);
    }

    return rawBuffer;
  }
}
