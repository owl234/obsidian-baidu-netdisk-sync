import { BaiduOAuthManager } from "./oauth";
import { buildMultipartFormData } from "./multipart";
import {
  BaiduCreateResponse,
  BaiduFileItem,
  BaiduFileMeta,
  BaiduFileMetasResponse,
  BaiduListResponse,
  BaiduPcsUploadResponse,
  BaiduPrecreateResponse,
  BaiduFileManagerResponse,
  DelayFn,
  HttpRequestFn,
  HttpRequestParam,
  HttpResponse,
  defaultDelay,
  parseJsonPreserveIds,
  sanitizeErrorMessage
} from "./types";
import { t } from "../i18n";

const FILEMETAS_BATCH_SIZE = 100;
const DELETE_BATCH_SIZE = 100;
const LIST_PAGE_LIMIT = 1000;

interface RetryOptions {
  expectJson: boolean;
  maxRetries?: number;
  initialDelayMs?: number;
}

export interface BaiduClientOptions {
  delayFn?: DelayFn;
  onWarn?: (message: string) => void;
}

class RetryableRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableRequestError";
  }
}

function getHeaderCaseInsensitive(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return "";
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      return v;
    }
  }
  return "";
}

function decodeSmallBufferToUtf8(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder().decode(buffer);
  } catch {
    return "";
  }
}

export class BaiduClient {
  private delayFn: DelayFn;
  private onWarn?: (message: string) => void;

  constructor(
    private oauth: BaiduOAuthManager,
    private httpRequest: HttpRequestFn,
    options: BaiduClientOptions = {}
  ) {
    this.delayFn = options.delayFn ?? defaultDelay;
    this.onWarn = options.onWarn;
  }

  private async requestWithRetry(
    buildParam: (token: string) => HttpRequestParam,
    options: RetryOptions
  ): Promise<HttpResponse> {
    const maxRetries = options.maxRetries ?? 3;
    let delay = options.initialDelayMs ?? 1000;
    let lastError: unknown = null;
    let token = await this.oauth.refreshTokenIfNeeded(false);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const param = buildParam(token);
        const resp = await this.httpRequest({
          ...param,
          throw: false
        });

        // HTTP 401 -> force token refresh and retry with new token
        if (resp.status === 401) {
          token = await this.oauth.refreshTokenIfNeeded(true);
          throw new RetryableRequestError("HTTP 401 Unauthorized (token refreshed)");
        }

        // Transient server / rate limit HTTP status
        if (resp.status === 429 || resp.status >= 500) {
          throw new RetryableRequestError(`Server Error HTTP ${resp.status}`);
        }

        if (resp.status === 200) {
          if (options.expectJson) {
            const parsed = parseJsonPreserveIds<{ errno?: number; error_code?: number }>(resp.text);
            const errno = parsed.errno;
            const errorCode = parsed.error_code;

            // Baidu xpan rate limit (31034) or PCS QPS/throttle (31034 / 31326)
            if (errno === 31034 || errorCode === 31034 || errorCode === 31326) {
              throw new RetryableRequestError(`Baidu Rate Limit Hit (${errno ?? errorCode})`);
            }

            // Baidu xpan invalid token (-6) or PCS invalid/expired token (110 / 111)
            if (errno === -6 || errorCode === 110 || errorCode === 111) {
              token = await this.oauth.refreshTokenIfNeeded(true);
              throw new RetryableRequestError(`Token expired (${errno ?? errorCode})`);
            }
          } else {
            // Binary download path: NEVER blindly invoke JSON.parse on file bodies.
            // Only inspect tiny JSON error payloads with Baidu API signature.
            const contentType = getHeaderCaseInsensitive(resp.headers, "content-type").toLowerCase();
            if (contentType.includes("application/json") && resp.arrayBuffer.byteLength > 0 && resp.arrayBuffer.byteLength < 4096) {
              const snippet = decodeSmallBufferToUtf8(resp.arrayBuffer);
              try {
                const maybeErr = JSON.parse(snippet) as {
                  errno?: number;
                  error_code?: number;
                  error_msg?: string;
                  request_id?: unknown;
                };
                const hasBaiduErrorSignature =
                  maybeErr !== null &&
                  typeof maybeErr === "object" &&
                  ("request_id" in maybeErr || ("error_code" in maybeErr && "error_msg" in maybeErr));

                if (hasBaiduErrorSignature) {
                  if (maybeErr.errno === 31034 || maybeErr.error_code === 31034 || maybeErr.error_code === 31326) {
                    throw new RetryableRequestError(`Baidu Download Rate Limit (${maybeErr.errno ?? maybeErr.error_code})`);
                  }
                  if (maybeErr.errno === -6 || maybeErr.error_code === 110 || maybeErr.error_code === 111) {
                    token = await this.oauth.refreshTokenIfNeeded(true);
                    throw new RetryableRequestError(`Download Token Expired (${maybeErr.errno ?? maybeErr.error_code})`);
                  }
                }
              } catch (e: unknown) {
                if (e instanceof RetryableRequestError) {
                  throw e;
                }
                // Legitimate JSON file downloaded by user; return as-is
              }
            }
          }
        }

        return resp;
      } catch (err: unknown) {
        lastError = err;
        const isRetryable =
          err instanceof RetryableRequestError ||
          !(err instanceof Error && err.name === "SyntaxError");

        if (attempt < maxRetries && isRetryable) {
          const jitter = Math.random() * 300;
          await this.delayFn(delay + jitter);
          delay *= 2;
        } else {
          break;
        }
      }
    }

    const rawMsg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(sanitizeErrorMessage(rawMsg));
  }

  /**
   * Lists all files under rootPath.
   * Uses Baidu's recursive `xpan/multimedia?method=listall` endpoint first (1-2 requests total),
   * and automatically falls back to directory-by-directory `xpan/file?method=list` BFS if unavailable.
   */
  async listAll(rootPath: string): Promise<BaiduFileItem[]> {
    const cleanPath = rootPath.length > 1 && rootPath.endsWith("/")
      ? rootPath.slice(0, -1)
      : rootPath || "/";

    const recursiveResult = await this.tryListAllRecursive(cleanPath);
    if (recursiveResult !== null) {
      return recursiveResult;
    }

    return this.listAllByBfs(cleanPath);
  }

  private async tryListAllRecursive(cleanPath: string): Promise<BaiduFileItem[] | null> {
    const allFiles: BaiduFileItem[] = [];
    const seenFsIds = new Set<string>();
    let cursor = 0;
    let hasMore = true;

    while (hasMore) {
      const currentCursor = cursor;
      const resp = await this.requestWithRetry(
        (token) => ({
          url: `https://pan.baidu.com/rest/2.0/xpan/multimedia?method=listall&path=${encodeURIComponent(
            cleanPath
          )}&recursion=1&start=${currentCursor}&limit=${LIST_PAGE_LIMIT}&access_token=${encodeURIComponent(token)}`,
          method: "GET"
        }),
        { expectJson: true }
      );

      if (resp.status !== 200) {
        this.onWarn?.(t("engine.listallFallback", { errno: `HTTP ${resp.status}` }));
        return null;
      }

      const data = parseJsonPreserveIds<BaiduListResponse>(resp.text);
      // Path does not exist / uninitialized
      if (data.errno === -9 || data.errno === 31066 || data.errno === 20020) {
        return [];
      }

      if (data.errno !== 0 && data.errno !== undefined) {
        this.onWarn?.(t("engine.listallFallback", { errno: data.errno }));
        return null;
      }

      if (data.list && Array.isArray(data.list)) {
        for (const item of data.list) {
          if (item.isdir === 1) continue;
          const idKey = String(item.fs_id);
          if (!seenFsIds.has(idKey)) {
            seenFsIds.add(idKey);
            allFiles.push(item);
          }
        }
      }

      if (data.has_more === 1 && data.cursor !== undefined) {
        const nextCursor = Number(data.cursor);
        if (!Number.isFinite(nextCursor) || nextCursor <= currentCursor) {
          hasMore = false;
        } else {
          cursor = nextCursor;
        }
      } else {
        hasMore = false;
      }
    }

    return allFiles;
  }

  private async listAllByBfs(cleanPath: string): Promise<BaiduFileItem[]> {
    const allFiles: BaiduFileItem[] = [];
    const seenFsIds = new Set<string>();
    const dirQueue: string[] = [cleanPath];

    while (dirQueue.length > 0) {
      const currentDir = dirQueue.shift()!;
      let start = 0;
      let hasMore = true;

      while (hasMore) {
        const currentStart = start;
        const resp = await this.requestWithRetry(
          (token) => ({
            url: `https://pan.baidu.com/rest/2.0/xpan/file?method=list&dir=${encodeURIComponent(
              currentDir
            )}&order=name&desc=0&start=${currentStart}&limit=${LIST_PAGE_LIMIT}&web=web&folder=0&access_token=${encodeURIComponent(token)}`,
            method: "GET"
          }),
          { expectJson: true }
        );

        if (resp.status !== 200) {
          throw new Error(t("client.listHttpError", { status: resp.status }));
        }

        const data = parseJsonPreserveIds<BaiduListResponse>(resp.text);
        if (data.errno === -9 || data.errno === 31066 || data.errno === 20020) {
          hasMore = false;
          break;
        }

        if (data.errno !== 0 && data.errno !== undefined) {
          throw new Error(t("client.listApiError", { errno: data.errno }));
        }

        if (data.list && Array.isArray(data.list)) {
          for (const item of data.list) {
            if (item.isdir === 1) {
              dirQueue.push(item.path);
            } else {
              const idKey = String(item.fs_id);
              if (!seenFsIds.has(idKey)) {
                seenFsIds.add(idKey);
                allFiles.push(item);
              }
            }
          }
          if (data.list.length < LIST_PAGE_LIMIT) {
            hasMore = false;
          } else {
            start += LIST_PAGE_LIMIT;
          }
        } else {
          hasMore = false;
        }
      }
    }

    return allFiles;
  }

  /**
   * Batch fetches file metadata (including dlink) in chunks of up to 100 fs_ids.
   */
  async getFileMetas(fsIds: Array<string | number>): Promise<Map<string, BaiduFileMeta>> {
    const result = new Map<string, BaiduFileMeta>();
    if (fsIds.length === 0) return result;

    const uniqueIds = Array.from(new Set(fsIds.map((id) => String(id))));

    for (let i = 0; i < uniqueIds.length; i += FILEMETAS_BATCH_SIZE) {
      const chunk = uniqueIds.slice(i, i + FILEMETAS_BATCH_SIZE);
      const fsidsParam = `[${chunk.join(",")}]`;

      const resp = await this.requestWithRetry(
        (token) => ({
          url: `https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&fsids=${encodeURIComponent(
            fsidsParam
          )}&dlink=1&access_token=${encodeURIComponent(token)}`,
          method: "GET"
        }),
        { expectJson: true }
      );

      if (resp.status !== 200) {
        throw new Error(t("client.metaHttpError", { status: resp.status }));
      }

      const data = parseJsonPreserveIds<BaiduFileMetasResponse>(resp.text);
      if (data.list && Array.isArray(data.list)) {
        for (const meta of data.list) {
          result.set(String(meta.fs_id), meta);
        }
      }
    }

    return result;
  }

  async getFileMeta(fsId: string | number): Promise<BaiduFileMeta> {
    const metas = await this.getFileMetas([fsId]);
    const meta = metas.get(String(fsId));
    if (!meta) {
      throw new Error(t("client.metaNotFound", { fsId: String(fsId) }));
    }
    return meta;
  }

  async downloadFile(dlink: string): Promise<ArrayBuffer> {
    const connector = dlink.includes("?") ? "&" : "?";

    const resp = await this.requestWithRetry(
      (token) => ({
        url: `${dlink}${connector}access_token=${encodeURIComponent(token)}`,
        method: "GET",
        headers: {
          "User-Agent": "pan.baidu.com"
        }
      }),
      { expectJson: false }
    );

    if (resp.status !== 200) {
      throw new Error(t("client.downloadHttpError", { status: resp.status }));
    }

    return resp.arrayBuffer;
  }

  async precreate(
    remotePath: string,
    size: number,
    blockList: string[],
    rapidHashes?: { contentMd5?: string; sliceMd5?: string }
  ): Promise<BaiduPrecreateResponse> {
    const fields: Record<string, string> = {
      path: remotePath,
      size: size.toString(),
      isdir: "0",
      autoinit: "1",
      rtype: "3", // overwrite existing
      block_list: JSON.stringify(blockList)
    };

    if (rapidHashes?.contentMd5) {
      fields["content-md5"] = rapidHashes.contentMd5;
    }
    if (rapidHashes?.sliceMd5) {
      fields["slice-md5"] = rapidHashes.sliceMd5;
    }

    const bodyStr = new URLSearchParams(fields).toString();

    const resp = await this.requestWithRetry(
      (token) => ({
        url: `https://pan.baidu.com/rest/2.0/xpan/file?method=precreate&access_token=${encodeURIComponent(token)}`,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: bodyStr
      }),
      { expectJson: true }
    );

    if (resp.status !== 200) {
      throw new Error(
        t("client.precreateHttpError", {
          status: resp.status,
          detail: sanitizeErrorMessage(resp.text || "")
        })
      );
    }

    const data = parseJsonPreserveIds<BaiduPrecreateResponse>(resp.text);
    if (data.errno !== 0) {
      throw new Error(
        t("client.precreateApiError", {
          errno: data.errno,
          detail: sanitizeErrorMessage(resp.text || "")
        })
      );
    }

    return data;
  }

  async uploadSlice(
    remotePath: string,
    uploadid: string,
    partseq: number,
    sliceBuffer: ArrayBuffer
  ): Promise<string> {
    const { body, contentType } = buildMultipartFormData(sliceBuffer, "file", "blob");

    const resp = await this.requestWithRetry(
      (token) => ({
        url: `https://d.pcs.baidu.com/rest/2.0/pcs/superfile2?method=upload&type=tmpfile&uploadid=${encodeURIComponent(
          uploadid
        )}&partseq=${partseq}&path=${encodeURIComponent(remotePath)}&access_token=${encodeURIComponent(token)}`,
        method: "POST",
        headers: {
          "Content-Type": contentType
        },
        body: body
      }),
      { expectJson: true }
    );

    if (resp.status !== 200) {
      throw new Error(
        t("client.uploadSliceHttpError", {
          partseq,
          status: resp.status,
          detail: sanitizeErrorMessage(resp.text || "")
        })
      );
    }

    const data = parseJsonPreserveIds<BaiduPcsUploadResponse>(resp.text);
    if (data.error_code && data.error_code !== 0) {
      throw new Error(
        t("client.uploadSliceApiError", {
          partseq,
          code: data.error_code,
          detail: sanitizeErrorMessage(data.error_msg || resp.text || "")
        })
      );
    }

    return data.md5 || "";
  }

  async createFile(
    remotePath: string,
    size: number,
    uploadid: string,
    blockList: string[]
  ): Promise<BaiduCreateResponse> {
    const bodyStr = new URLSearchParams({
      path: remotePath,
      size: size.toString(),
      isdir: "0",
      rtype: "3",
      uploadid: uploadid,
      block_list: JSON.stringify(blockList)
    }).toString();

    const resp = await this.requestWithRetry(
      (token) => ({
        url: `https://pan.baidu.com/rest/2.0/xpan/file?method=create&access_token=${encodeURIComponent(token)}`,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: bodyStr
      }),
      { expectJson: true }
    );

    if (resp.status !== 200) {
      throw new Error(
        t("client.createHttpError", {
          status: resp.status,
          detail: sanitizeErrorMessage(resp.text || "")
        })
      );
    }

    const data = parseJsonPreserveIds<BaiduCreateResponse>(resp.text);
    if (data.errno !== 0) {
      throw new Error(
        t("client.createApiError", {
          errno: data.errno,
          detail: sanitizeErrorMessage(resp.text || "")
        })
      );
    }

    return data;
  }

  async createDirectory(remotePath: string): Promise<void> {
    const bodyStr = new URLSearchParams({
      path: remotePath,
      size: "0",
      isdir: "1",
      rtype: "0"
    }).toString();

    const resp = await this.requestWithRetry(
      (token) => ({
        url: `https://pan.baidu.com/rest/2.0/xpan/file?method=create&access_token=${encodeURIComponent(token)}`,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: bodyStr
      }),
      { expectJson: true }
    );

    const data = parseJsonPreserveIds<BaiduCreateResponse>(resp.text);
    // errno 0 = success, -8 = dir already exists (ignore)
    if (data.errno !== 0 && data.errno !== -8) {
      console.warn(`[BaiduSync] createDirectory warning path=${remotePath} errno=${data.errno}`);
    }
  }

  async deleteFiles(remotePaths: string[]): Promise<void> {
    if (remotePaths.length === 0) return;

    for (let i = 0; i < remotePaths.length; i += DELETE_BATCH_SIZE) {
      const batch = remotePaths.slice(i, i + DELETE_BATCH_SIZE);
      const bodyStr = new URLSearchParams({
        filelist: JSON.stringify(batch)
      }).toString();

      const resp = await this.requestWithRetry(
        (token) => ({
          url: `https://pan.baidu.com/rest/2.0/xpan/file?method=filemanager&opera=delete&access_token=${encodeURIComponent(token)}`,
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: bodyStr
        }),
        { expectJson: true }
      );

      if (resp.status !== 200) {
        throw new Error(
          t("client.deleteHttpError", {
            status: resp.status,
            detail: sanitizeErrorMessage(resp.text || "")
          })
        );
      }

      const data = parseJsonPreserveIds<BaiduFileManagerResponse>(resp.text);
      if (data.errno !== 0) {
        throw new Error(
          t("client.deleteApiError", {
            errno: data.errno,
            detail: sanitizeErrorMessage(resp.text || "")
          })
        );
      }
    }
  }
}
