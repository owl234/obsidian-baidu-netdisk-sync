export interface HttpRequestParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  throw?: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  text: string;
}

export type HttpRequestFn = (param: HttpRequestParam) => Promise<HttpResponse>;
export type DelayFn = (ms: number) => Promise<void>;

export interface BaiduTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // in seconds, typically 2592000 (30 days)
  scope: string;
  session_key?: string;
  session_secret?: string;
  error?: string;
  error_description?: string;
}

export interface BaiduFileItem {
  fs_id: string | number;
  path: string;
  server_filename: string;
  size: number;
  isdir: number; // 0 = file, 1 = directory
  server_mtime: number; // in seconds
  server_ctime: number; // in seconds
  local_mtime?: number;
  local_ctime?: number;
  md5?: string;
}

export class FatalApiError extends Error {
  constructor(
    message: string,
    public readonly code?: number
  ) {
    super(message);
    this.name = "FatalApiError";
  }
}

export interface BaiduListResponse {
  errno?: number;
  error_code?: number;
  error_msg?: string;
  errmsg?: string;
  show_msg?: string;
  guid_info?: string;
  list?: BaiduFileItem[];
  has_more?: number;
  cursor?: string | number;
}

export interface BaiduPrecreateInfo {
  fs_id: string | number;
  md5?: string;
  path: string;
  size: number;
  ctime?: number;
  mtime?: number;
  server_mtime?: number;
  isdir?: number;
  category?: number;
  server_filename?: string;
}

export interface BaiduPrecreateResponse {
  errno?: number;
  error_code?: number;
  error_msg?: string;
  path: string;
  uploadid: string;
  /**
   * Baidu xpan precreate return_type:
   * 1 = normal upload required (upload slices in block_list, then call create)
   * 2 = rapid upload (秒传) succeeded immediately (info contains created file metadata)
   */
  return_type: number;
  block_list: number[]; // block partseq array that needs uploading
  info?: BaiduPrecreateInfo;
}

export interface BaiduCreateResponse {
  errno?: number;
  error_code?: number;
  error_msg?: string;
  fs_id: string | number;
  md5: string;
  server_filename: string;
  category: number;
  path: string;
  size: number;
  ctime: number;
  mtime: number;
  isdir: number;
}

export interface BaiduFileMeta {
  fs_id: string | number;
  path: string;
  server_filename: string;
  size: number;
  isdir: number;
  category: number;
  md5: string;
  dlink: string; // direct download url
}

export interface BaiduFileMetasResponse {
  errno?: number;
  error_code?: number;
  error_msg?: string;
  list: BaiduFileMeta[];
}

export interface BaiduFileManagerResponse {
  errno?: number;
  error_code?: number;
  error_msg?: string;
  info?: Array<{ errno: number; path: string }>;
  taskid?: number;
}

export interface BaiduUserInfoResponse {
  errno: number;
  baidu_name: string;
  netdisk_name: string;
  avatar_url: string;
  vip_type: number;
  uk: number;
}

export interface BaiduPcsUploadResponse {
  md5?: string;
  request_id?: string | number;
  error_code?: number;
  error_msg?: string;
}

/**
 * Redacts sensitive OAuth tokens and secrets from URLs, logs, and error messages.
 */
export function sanitizeErrorMessage(input: string): string {
  return input
    .replace(/([?&]access_token=)[^&\s"'`]+/gi, "$1[REDACTED]")
    .replace(/([?&]refresh_token=)[^&\s"'`]+/gi, "$1[REDACTED]")
    .replace(/([?&]client_secret=)[^&\s"'`]+/gi, "$1[REDACTED]")
    .replace(/("(?:access_token|refresh_token|client_secret|appSecret|e2eePassword)"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2");
}

/**
 * Parses JSON text while quoting large numeric `fs_id` values (>= 15 digits)
 * so 64-bit Baidu fs_ids never lose precision above Number.MAX_SAFE_INTEGER.
 */
export function parseJsonPreserveIds<T>(text: string): T {
  const safeText = text.replace(/("fs_id"\s*:\s*)(\d{15,})/g, '$1"$2"');
  return JSON.parse(safeText) as T;
}

export function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
