import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { BaiduOAuthManager } from "./oauth";
import { buildMultipartFormData } from "./multipart";
import {
  BaiduCreateResponse,
  BaiduFileItem,
  BaiduFileMeta,
  BaiduFileMetasResponse,
  BaiduListResponse,
  BaiduPrecreateResponse,
  BaiduFileManagerResponse
} from "./types";

export class BaiduClient {
  constructor(private oauth: BaiduOAuthManager) {}

  private async requestWithRetry(
    param: RequestUrlParam,
    maxRetries = 3,
    initialDelayMs = 1000
  ): Promise<RequestUrlResponse> {
    let lastError: any = null;
    let delay = initialDelayMs;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const resp = await requestUrl(param);
        // Baidu sometimes returns HTTP 200 with errno: 31034 (QPS limit exceeded) or errno: -6 (invalid token)
        if (resp.status === 200) {
          try {
            const data = resp.json;
            if (data && typeof data === "object") {
              if (data.errno === 31034) {
                // Rate limit hit
                throw new Error("Baidu Rate Limit Hit (errno: 31034)");
              }
              if (data.errno === -6) {
                // Token expired, force refresh and retry
                console.warn("[BaiduSync] Token 失效，尝试刷新并重试...");
                await this.oauth.refreshTokenIfNeeded(true);
                throw new Error("Token expired (errno: -6)");
              }
            }
          } catch (e: any) {
            // If it's our re-thrown error, rethrow it
            if (e.message && (e.message.includes("Rate Limit") || e.message.includes("Token expired"))) {
              throw e;
            }
            // Otherwise, resp is non-JSON file content (markdown, image, binary)
          }
          return resp;
        }

        if (resp.status === 429 || resp.status >= 500) {
          throw new Error(`Server Error HTTP ${resp.status}`);
        }

        return resp;
      } catch (err: any) {
        lastError = err;
        if (attempt < maxRetries) {
          // Exponential backoff with jitter
          const jitter = Math.random() * 300;
          await new Promise((r) => setTimeout(r, delay + jitter));
          delay *= 2;
        }
      }
    }

    throw lastError;
  }

  async listAll(rootPath: string): Promise<BaiduFileItem[]> {
    const token = await this.oauth.refreshTokenIfNeeded();
    const cleanPath = rootPath.endsWith("/") ? rootPath.slice(0, -1) : rootPath;
    const allFiles: BaiduFileItem[] = [];
    const dirQueue: string[] = [cleanPath];

    while (dirQueue.length > 0) {
      const currentDir = dirQueue.shift()!;
      let start = 0;
      const limit = 1000;
      let hasMore = true;

      while (hasMore) {
        const url = `https://pan.baidu.com/rest/2.0/xpan/file?method=list&dir=${encodeURIComponent(
          currentDir
        )}&order=name&desc=0&start=${start}&limit=${limit}&web=web&folder=0&access_token=${token}`;

        const resp = await this.requestWithRetry({
          url,
          method: "GET"
        });

        if (resp.status !== 200) {
          throw new Error(`获取网盘文件列表失败: HTTP ${resp.status}`);
        }

        const data: BaiduListResponse = resp.json;
        // errno -9: path does not exist; errno 31066: directory not found; errno 20020: empty/uninitialized path
        if (data.errno === -9 || data.errno === 31066 || data.errno === 20020) {
          hasMore = false;
          break;
        }

        if (data.errno !== 0 && data.errno !== undefined) {
          throw new Error(`获取网盘列表返回异常 (errno: ${data.errno})`);
        }

        if (data.list && Array.isArray(data.list)) {
          for (const item of data.list) {
            if (item.isdir === 1) {
              dirQueue.push(item.path);
            } else {
              allFiles.push(item);
            }
          }
          if (data.list.length < limit) {
            hasMore = false;
          } else {
            start += limit;
          }
        } else {
          hasMore = false;
        }
      }
    }

    return allFiles;
  }

  async getFileMeta(fsId: string | number): Promise<BaiduFileMeta> {
    const token = await this.oauth.refreshTokenIfNeeded();
    const url = `https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&fsids=[${fsId}]&dlink=1&access_token=${token}`;

    const resp = await this.requestWithRetry({
      url,
      method: "GET"
    });

    if (resp.status !== 200) {
      throw new Error(`获取文件元数据失败: HTTP ${resp.status}`);
    }

    const data: BaiduFileMetasResponse = resp.json;
    if (!data.list || data.list.length === 0) {
      throw new Error(`未找到文件元数据 fsId=${fsId}`);
    }

    return data.list[0];
  }

  async downloadFile(dlink: string): Promise<ArrayBuffer> {
    const token = await this.oauth.refreshTokenIfNeeded();
    const connector = dlink.includes("?") ? "&" : "?";
    const finalUrl = `${dlink}${connector}access_token=${token}`;

    const resp = await this.requestWithRetry({
      url: finalUrl,
      method: "GET",
      headers: {
        "User-Agent": "pan.baidu.com"
      }
    });

    if (resp.status !== 200) {
      throw new Error(`下载文件失败: HTTP ${resp.status}`);
    }

    return resp.arrayBuffer;
  }

  async precreate(remotePath: string, size: number, blockList: string[]): Promise<BaiduPrecreateResponse> {
    const token = await this.oauth.refreshTokenIfNeeded();
    const url = `https://pan.baidu.com/rest/2.0/xpan/file?method=precreate&access_token=${token}`;

    const body = new URLSearchParams({
      path: remotePath,
      size: size.toString(),
      isdir: "0",
      autoinit: "1",
      rtype: "3", // overwrite existing
      block_list: JSON.stringify(blockList)
    });

    const resp = await this.requestWithRetry({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

    if (resp.status !== 200) {
      throw new Error(`Precreate 失败 (HTTP ${resp.status}): ${resp.text}`);
    }

    const data: BaiduPrecreateResponse = resp.json;
    if (data.errno !== 0) {
      throw new Error(`Precreate 错误 [errno: ${data.errno}]: ${resp.text}`);
    }

    return data;
  }

  async uploadSlice(
    remotePath: string,
    uploadid: string,
    partseq: number,
    sliceBuffer: ArrayBuffer
  ): Promise<void> {
    const token = await this.oauth.refreshTokenIfNeeded();
    const url = `https://d.pcs.baidu.com/rest/2.0/pcs/superfile2?method=upload&type=tmpfile&uploadid=${encodeURIComponent(
      uploadid
    )}&partseq=${partseq}&path=${encodeURIComponent(remotePath)}&access_token=${token}`;

    const { body, contentType } = buildMultipartFormData(sliceBuffer, "file", "blob");

    const resp = await this.requestWithRetry({
      url,
      method: "POST",
      headers: {
        "Content-Type": contentType
      },
      body: body
    });

    if (resp.status !== 200) {
      throw new Error(`分片上传失败 partseq=${partseq} (HTTP ${resp.status}): ${resp.text}`);
    }
  }

  async createFile(
    remotePath: string,
    size: number,
    uploadid: string,
    blockList: string[]
  ): Promise<BaiduCreateResponse> {
    const token = await this.oauth.refreshTokenIfNeeded();
    const url = `https://pan.baidu.com/rest/2.0/xpan/file?method=create&access_token=${token}`;

    const body = new URLSearchParams({
      path: remotePath,
      size: size.toString(),
      isdir: "0",
      rtype: "3",
      uploadid: uploadid,
      block_list: JSON.stringify(blockList)
    });

    const resp = await this.requestWithRetry({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

    if (resp.status !== 200) {
      throw new Error(`合并创建文件失败 (HTTP ${resp.status}): ${resp.text}`);
    }

    const data: BaiduCreateResponse = resp.json;
    if (data.errno !== 0) {
      throw new Error(`落盘创建文件错误 [errno: ${data.errno}]: ${resp.text}`);
    }

    return data;
  }

  async createDirectory(remotePath: string): Promise<void> {
    const token = await this.oauth.refreshTokenIfNeeded();
    const url = `https://pan.baidu.com/rest/2.0/xpan/file?method=create&access_token=${token}`;

    const body = new URLSearchParams({
      path: remotePath,
      size: "0",
      isdir: "1",
      rtype: "0"
    });

    const resp = await this.requestWithRetry({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

    const data: BaiduCreateResponse = resp.json;
    // errno 0 = success, -8 = dir already exists (ignore)
    if (data.errno !== 0 && data.errno !== -8) {
      console.warn(`创建目录警告 path=${remotePath} errno=${data.errno}`);
    }
  }

  async deleteFiles(remotePaths: string[]): Promise<void> {
    if (remotePaths.length === 0) return;

    const token = await this.oauth.refreshTokenIfNeeded();
    const url = `https://pan.baidu.com/rest/2.0/xpan/file?method=filemanager&opera=delete&access_token=${token}`;

    const body = new URLSearchParams({
      filelist: JSON.stringify(remotePaths)
    });

    const resp = await this.requestWithRetry({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

    if (resp.status !== 200) {
      throw new Error(`删除网盘文件失败 (HTTP ${resp.status}): ${resp.text}`);
    }

    const data: BaiduFileManagerResponse = resp.json;
    if (data.errno !== 0) {
      throw new Error(`删除网盘文件错误 [errno: ${data.errno}]: ${resp.text}`);
    }
  }
}
