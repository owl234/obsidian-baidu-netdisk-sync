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

export interface BaiduListResponse {
  errno: number;
  guid_info?: string;
  list?: BaiduFileItem[];
  has_more?: number;
  cursor?: string | number;
}

export interface BaiduPrecreateResponse {
  errno: number;
  path: string;
  uploadid: string;
  return_type: number; // 1 = instant/rapid upload, 2 = normal upload
  block_list: number[]; // block partseq array that needs uploading
}

export interface BaiduCreateResponse {
  errno: number;
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
  errno: number;
  list: BaiduFileMeta[];
}

export interface BaiduFileManagerResponse {
  errno: number;
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
