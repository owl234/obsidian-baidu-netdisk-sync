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
  FatalApiError,
  HttpRequestFn,
  HttpRequestParam,
  HttpResponse,
  defaultDelay,
  parseJsonPreserveIds,
  sanitizeErrorMessage
} from "./types";
import { HTTP_REQUEST_TIMEOUT_MS, withTimeout } from "../sync/timeout";
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
  requestTimeoutMs?: number;
}

class RetryableRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableRequestError";
  }
}

function getApiErrorCode(data: { errno?: number; error_code?: number }): number | null {
  if (typeof data.errno === "number") {
    return data.errno !== 0 ? data.errno : null;
  }
  if (typeof data.error_code === "number") {
    return data.error_code !== 0 ? data.error_code : null;
  }
  return null;
}

function startsWithJsonObject(buffer: ArrayBuffer): boolean {
  const view = new Uint8Array(buffer);
  for (let i = 0; i < view.length; i++) {
    const b = view[i];
    // Skip ASCII whitespace (space, tab, LF, CR)
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue;
    return b === 0x7b; // '{'
  }
  return false;
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
  private requestTimeoutMs: number;
  private listallUnsupportedPaths = new Set<string>();

  constructor(
    private oauth: BaiduOAuthManager,
    private httpRequest: HttpRequestFn,
    options: BaiduClientOptions = {}
  ) {
    this.delayFn = options.delayFn ?? defaultDelay;
    this.onWarn = options.onWarn;
    this.requestTimeoutMs = options.requestTimeoutMs ?? HTTP_REQUEST_TIMEOUT_MS;
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
        const resp = await withTimeout(
          this.httpRequest({
            ...param,
            throw: false
          }),
          this.requestTimeoutMs,
          `http.${param.method || "GET"}`,
          "http"
        );

        // HTTP 401 -> force token refresh (deduped against failedToken) and retry with new token
        if (resp.status === 401) {
          token = await this.oauth.refreshTokenIfNeeded(true, token);
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
              token = await this.oauth.refreshTokenIfNeeded(true, token);
              throw new RetryableRequestError(`Token expired (${errno ?? errorCode})`);
            }
          } else {
            // Binary download path: NEVER blindly invoke JSON.parse on arbitrary binary bodies.
            // Inspect any tiny `{...}` payload (even under application/octet-stream) for Baidu API
            // error envelopes so HTTP 200 error JSON (e.g. expired dlink 31360) never overwrites files.
            if (
              resp.arrayBuffer.byteLength > 0 &&
              resp.arrayBuffer.byteLength < 4096 &&
              startsWithJsonObject(resp.arrayBuffer)
            ) {
              const snippet = decodeSmallBufferToUtf8(resp.arrayBuffer);
              try {
                const maybeErr = JSON.parse(snippet) as {
                  errno?: number;
                  error_code?: number;
                  error_msg?: string;
                  errmsg?: string;
                  show_msg?: string;
                  request_id?: unknown;
                };
                const hasBaiduErrorSignature =
                  maybeErr !== null &&
                  typeof maybeErr === "object" &&
                  !Array.isArray(maybeErr) &&
                  ("request_id" in maybeErr ||
                    ("error_code" in maybeErr && "error_msg" in maybeErr) ||
                    ("errno" in maybeErr && ("errmsg" in maybeErr || "show_msg" in maybeErr)));

                if (hasBaiduErrorSignature) {
                  const code =
                    typeof maybeErr.error_code === "number"
                      ? maybeErr.error_code
                      : typeof maybeErr.errno === "number"
                        ? maybeErr.errno
                        : 0;
                  if (code === 31034 || code === 31326) {
                    throw new RetryableRequestError(`Baidu Download Rate Limit (${code})`);
                  }
                  if (code === -6 || code === 110 || code === 111) {
                    token = await this.oauth.refreshTokenIfNeeded(true, token);
                    throw new RetryableRequestError(`Download Token Expired (${code})`);
                  }
                  if (code !== 0) {
                    throw new FatalApiError(
                      t("client.downloadApiError", {
                        code,
                        detail: sanitizeErrorMessage(
                          maybeErr.error_msg || maybeErr.errmsg || maybeErr.show_msg || snippet
                        )
                      }),
                      code
                    );
                  }
                }
              } catch (e: unknown) {
                if (e instanceof RetryableRequestError || e instanceof FatalApiError) {
                  throw e;
                }
                // Legitimate JSON/text file downloaded by user; return as-is
              }
            }
          }
        }

        return resp;
      } catch (err: unknown) {
        lastError = err;
        const isRetryable =
          err instanceof RetryableRequestError ||
          (!(err instanceof FatalApiError) && !(err instanceof Error && err.name === "SyntaxError"));

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
    if (lastError instanceof FatalApiError) {
      throw new FatalApiError(sanitizeErrorMessage(rawMsg), lastError.code);
    }
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
    if (this.listallUnsupportedPaths.has(cleanPath)) {
      return null;
    }

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
      // NEVER treat errno 20020 ("path outside allowed scope"), gateway error_code, or any
      // non-zero/malformed listall response as an empty remote directory. Fall back to BFS.
      const apiErr = getApiErrorCode(data);
      if (apiErr !== null || (data.errno === undefined && !Array.isArray(data.list))) {
        const errCode = apiErr ?? "missing_errno";
        if (apiErr === 20020) {
          this.listallUnsupportedPaths.add(cleanPath);
        }
        this.onWarn?.(t("engine.listallFallback", { errno: errCode }));
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

      if (data.has_more === 1) {
        const nextCursor = data.cursor !== undefined ? Number(data.cursor) : Number.NaN;
        // Never silently truncate paginated results; fall back to BFS if cursor stops advancing.
        if (!Number.isFinite(nextCursor) || nextCursor <= currentCursor) {
          this.onWarn?.(t("engine.listallFallback", { errno: "invalid_cursor" }));
          return null;
        }
        cursor = nextCursor;
      } else {
        hasMore = false;
      }
    }

    return allFiles;
  }

  private async listAllByBfs(cleanPath: string): Promise<BaiduFileItem[]> {
    const allFiles: BaiduFileItem[] = [];
    const seenFsIds = new Set<string>();
    const visitedDirs = new Set<string>([cleanPath]);
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
        // Only treat -9 / 31066 ("directory not found") as an uninitialized empty vault on the
        // very first page of the root path. Never swallow 20020, gateway error_code, or
        // mid-traversal/mid-pagination errors, which would otherwise produce a truncated listing.
        if ((data.errno === -9 || data.errno === 31066) && currentDir === cleanPath && currentStart === 0) {
          return [];
        }

        const apiErr = getApiErrorCode(data);
        if (apiErr !== null || (data.errno === undefined && !Array.isArray(data.list))) {
          throw new Error(t("client.listApiError", { errno: apiErr ?? "missing_errno" }));
        }

        if (data.list && Array.isArray(data.list)) {
          for (const item of data.list) {
            if (item.isdir === 1) {
              if (!visitedDirs.has(item.path)) {
                visitedDirs.add(item.path);
                dirQueue.push(item.path);
              }
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
      const apiErr = getApiErrorCode(data);
      if (apiErr !== null || (data.errno === undefined && !Array.isArray(data.list))) {
        throw new Error(t("client.metaApiError", { errno: apiErr ?? "missing_errno" }));
      }
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
      throw new FatalApiError(t("client.downloadHttpError", { status: resp.status }), resp.status);
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
    const apiErr = getApiErrorCode(data);
    if (apiErr !== null || data.errno !== 0) {
      throw new Error(
        t("client.precreateApiError", {
          errno: apiErr ?? String(data.errno ?? "missing_errno"),
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
    const apiErr = getApiErrorCode(data);
    if (apiErr !== null || data.errno !== 0) {
      throw new Error(
        t("client.createApiError", {
          errno: apiErr ?? String(data.errno ?? "missing_errno"),
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
      const apiErr = getApiErrorCode(data);
      if (data.errno === 12 && Array.isArray(data.info)) {
        // errno 12 indicates partial batch failure; ignore already-missing paths (-9 / 31066)
        const fatalItems = data.info.filter(
          (item) => item.errno !== 0 && item.errno !== -9 && item.errno !== 31066
        );
        if (fatalItems.length > 0) {
          throw new Error(
            t("client.deleteApiError", {
              errno: data.errno,
              detail: sanitizeErrorMessage(JSON.stringify(fatalItems))
            })
          );
        }
      } else if (apiErr !== null || data.errno !== 0) {
        throw new Error(
          t("client.deleteApiError", {
            errno: apiErr ?? String(data.errno ?? "missing_errno"),
            detail: sanitizeErrorMessage(resp.text || "")
          })
        );
      } else if (Array.isArray(data.info)) {
        const fatalItems = data.info.filter(
          (item) => item.errno !== 0 && item.errno !== -9 && item.errno !== 31066
        );
        if (fatalItems.length > 0) {
          throw new Error(
            t("client.deleteApiError", {
              errno: fatalItems[0].errno,
              detail: sanitizeErrorMessage(JSON.stringify(fatalItems))
            })
          );
        }
      }
    }
  }
}
