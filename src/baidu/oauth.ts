import { requestUrl } from "obsidian";
import { BaiduSyncSettings } from "../settings/settings";
import { BaiduTokenResponse, BaiduUserInfoResponse } from "./types";

export class BaiduOAuthManager {
  constructor(
    private getSettings: () => BaiduSyncSettings,
    private saveSettings: (settings: BaiduSyncSettings) => Promise<void>
  ) {}

  getOAuthUrl(): string {
    const settings = this.getSettings();
    if (!settings.appKey) {
      throw new Error("请先填写 AppKey");
    }
    const clientId = encodeURIComponent(settings.appKey.trim());
    return `https://openapi.baidu.com/oauth/2.0/authorize?response_type=code&client_id=${clientId}&redirect_uri=oob&scope=basic,netdisk`;
  }

  async exchangeCodeForToken(code: string): Promise<BaiduTokenResponse> {
    const settings = this.getSettings();
    if (!settings.appKey || !settings.appSecret) {
      throw new Error("请先填写 AppKey 与 AppSecret");
    }

    const trimmedCode = code.trim();
    const url = "https://openapi.baidu.com/oauth/2.0/token";
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: trimmedCode,
      client_id: settings.appKey.trim(),
      client_secret: settings.appSecret.trim(),
      redirect_uri: "oob"
    });

    const resp = await requestUrl({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

    if (resp.status !== 200) {
      throw new Error(`获取 Token 失败 (HTTP ${resp.status}): ${resp.text}`);
    }

    const tokenData: BaiduTokenResponse = resp.json;
    if (tokenData.error) {
      throw new Error(`授权错误 [${tokenData.error}]: ${tokenData.error_description || "未知错误"}`);
    }

    const now = Date.now();
    const expiresInMs = (tokenData.expires_in || 2592000) * 1000;

    settings.accessToken = tokenData.access_token;
    settings.refreshToken = tokenData.refresh_token;
    settings.tokenExpiresAt = now + expiresInMs;
    await this.saveSettings(settings);

    return tokenData;
  }

  async refreshTokenIfNeeded(force = false): Promise<string> {
    const settings = this.getSettings();
    if (!settings.refreshToken) {
      throw new Error("尚未授权百度网盘账号，请先在设置中完成授权");
    }

    const now = Date.now();
    // Refresh if less than 24 hours remaining or expired or forced
    const shouldRefresh = force || !settings.tokenExpiresAt || settings.tokenExpiresAt - now < 24 * 3600 * 1000;

    if (!shouldRefresh && settings.accessToken) {
      return settings.accessToken;
    }

    const url = "https://openapi.baidu.com/oauth/2.0/token";
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: settings.refreshToken,
      client_id: settings.appKey.trim(),
      client_secret: settings.appSecret.trim()
    });

    try {
      const resp = await requestUrl({
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
      });

      if (resp.status !== 200) {
        throw new Error(`刷新 Token 失败 (HTTP ${resp.status}): ${resp.text}`);
      }

      const tokenData: BaiduTokenResponse = resp.json;
      if (tokenData.error) {
        throw new Error(`刷新 Token 异常 [${tokenData.error}]: ${tokenData.error_description || "未知错误"}`);
      }

      settings.accessToken = tokenData.access_token;
      if (tokenData.refresh_token) {
        settings.refreshToken = tokenData.refresh_token;
      }
      settings.tokenExpiresAt = Date.now() + (tokenData.expires_in || 2592000) * 1000;
      await this.saveSettings(settings);

      return settings.accessToken;
    } catch (err: any) {
      console.error("[BaiduSync] 刷新 Token 失败:", err);
      throw err;
    }
  }

  async getUserInfo(): Promise<BaiduUserInfoResponse> {
    const token = await this.refreshTokenIfNeeded();
    const url = `https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo&access_token=${token}`;

    const resp = await requestUrl({
      url,
      method: "GET"
    });

    if (resp.status !== 200) {
      throw new Error(`获取用户信息失败: HTTP ${resp.status}`);
    }

    return resp.json as BaiduUserInfoResponse;
  }
}
