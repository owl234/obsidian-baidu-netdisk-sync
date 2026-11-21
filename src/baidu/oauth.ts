import { BaiduSyncSettings } from "../settings/settings";
import {
  BaiduTokenResponse,
  BaiduUserInfoResponse,
  HttpRequestFn,
  parseJsonPreserveIds,
  sanitizeErrorMessage
} from "./types";
import { t } from "../i18n";

export class BaiduOAuthManager {
  private refreshInFlight: Promise<string> | null = null;

  constructor(
    private getSettings: () => BaiduSyncSettings,
    private saveSettings: (settings: BaiduSyncSettings) => Promise<void>,
    private httpRequest: HttpRequestFn
  ) {}

  getOAuthUrl(): string {
    const settings = this.getSettings();
    if (!settings.appKey) {
      throw new Error(t("oauth.missingAppKey"));
    }
    const clientId = encodeURIComponent(settings.appKey.trim());
    return `https://openapi.baidu.com/oauth/2.0/authorize?response_type=code&client_id=${clientId}&redirect_uri=oob&scope=basic,netdisk`;
  }

  async exchangeCodeForToken(code: string): Promise<BaiduTokenResponse> {
    const settings = this.getSettings();
    if (!settings.appKey || !settings.appSecret) {
      throw new Error(t("oauth.missingCredentials"));
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

    const resp = await this.httpRequest({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString(),
      throw: false
    });

    if (resp.status !== 200) {
      throw new Error(
        t("oauth.tokenExchangeHttpError", {
          status: resp.status,
          detail: sanitizeErrorMessage(resp.text || "")
        })
      );
    }

    const tokenData = parseJsonPreserveIds<BaiduTokenResponse>(resp.text);
    if (tokenData.error) {
      throw new Error(
        t("oauth.tokenExchangeApiError", {
          error: tokenData.error,
          detail: tokenData.error_description || t("oauth.unknownError")
        })
      );
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
      throw new Error(t("oauth.missingRefreshToken"));
    }

    // Refresh 1 day before expiration
    const oneDayMs = 24 * 60 * 60 * 1000;
    const isExpired = Date.now() + oneDayMs > settings.tokenExpiresAt;

    if (!force && !isExpired && settings.accessToken) {
      return settings.accessToken;
    }

    // Deduplicate concurrent refresh requests across parallel workers
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    const refreshTask = this.performTokenRefresh();
    this.refreshInFlight = refreshTask;

    try {
      return await refreshTask;
    } finally {
      if (this.refreshInFlight === refreshTask) {
        this.refreshInFlight = null;
      }
    }
  }

  private async performTokenRefresh(): Promise<string> {
    const settings = this.getSettings();
    try {
      const url = "https://openapi.baidu.com/oauth/2.0/token";
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: settings.refreshToken.trim(),
        client_id: settings.appKey.trim(),
        client_secret: settings.appSecret.trim()
      });

      const resp = await this.httpRequest({
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString(),
        throw: false
      });

      if (resp.status !== 200) {
        throw new Error(
          t("oauth.tokenRefreshHttpError", {
            status: resp.status,
            detail: sanitizeErrorMessage(resp.text || "")
          })
        );
      }

      const tokenData = parseJsonPreserveIds<BaiduTokenResponse>(resp.text);
      if (tokenData.error) {
        throw new Error(
          t("oauth.tokenRefreshApiError", {
            error: tokenData.error,
            detail: tokenData.error_description || t("oauth.unknownError")
          })
        );
      }

      const latestSettings = this.getSettings();
      latestSettings.accessToken = tokenData.access_token;
      if (tokenData.refresh_token) {
        latestSettings.refreshToken = tokenData.refresh_token;
      }
      latestSettings.tokenExpiresAt = Date.now() + (tokenData.expires_in || 2592000) * 1000;
      await this.saveSettings(latestSettings);

      return latestSettings.accessToken;
    } catch (err: unknown) {
      const msg = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
      console.error("[BaiduSync] Token refresh failed:", msg);
      throw new Error(msg);
    }
  }

  async getUserInfo(): Promise<BaiduUserInfoResponse> {
    const token = await this.refreshTokenIfNeeded();
    const url = `https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo&access_token=${encodeURIComponent(token)}`;

    const resp = await this.httpRequest({
      url,
      method: "GET",
      throw: false
    });

    if (resp.status !== 200) {
      throw new Error(t("oauth.userInfoHttpError", { status: resp.status }));
    }

    return parseJsonPreserveIds<BaiduUserInfoResponse>(resp.text);
  }
}
