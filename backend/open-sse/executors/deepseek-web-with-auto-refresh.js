import {
  DeepSeekWebExecutor,
  acquireAccessToken,
  extractUserToken,
  tokenCache
} from "./deepseek-web.ts";
class DeepSeekWebWithAutoRefreshExecutor extends DeepSeekWebExecutor {
  refreshConfig;
  lastRefreshTime = 0;
  refreshTimer = null;
  sessionValid = false;
  retryCount = 0;
  maxRetries = 2;
  currentUserToken = "";
  constructor(config = {}) {
    super();
    this.refreshConfig = {
      sessionRefreshInterval: 50 * 60 * 1e3,
      maxRefreshRetries: 3,
      autoRefresh: true,
      ...config
    };
  }
  async execute(input) {
    this.retryCount = 0;
    const creds = input.credentials;
    this.setCurrentUserToken(extractUserToken(creds));
    return this.executeWithRetry(input);
  }
  isSessionValid() {
    return this.sessionValid;
  }
  getTimeSinceRefresh() {
    return Date.now() - this.lastRefreshTime;
  }
  async refreshSession() {
    await this.doRefreshSession();
  }
  destroy() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
  startAutoRefresh() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(async () => {
      if (!this.currentUserToken) {
        this.sessionValid = false;
        return;
      }
      try {
        await this.doRefreshSession();
      } catch (error) {
        console.error("[DeepSeek-WEB-AUTO-REFRESH] Auto-refresh failed:", error);
      }
    }, this.refreshConfig.sessionRefreshInterval);
    if (typeof this.refreshTimer === "object" && "unref" in this.refreshTimer) {
      this.refreshTimer.unref?.();
    }
  }
  setCurrentUserToken(userToken) {
    if (!userToken) {
      return;
    }
    if (this.currentUserToken === userToken) {
      return;
    }
    this.currentUserToken = userToken;
    this.sessionValid = false;
    if (this.refreshConfig.autoRefresh) {
      this.startAutoRefresh();
    }
  }
  async doRefreshSession() {
    if (!this.currentUserToken) {
      this.sessionValid = false;
      throw new Error("No userToken available for session refresh");
    }
    const { maxRefreshRetries } = this.refreshConfig;
    for (let attempt = 0; attempt < maxRefreshRetries; attempt++) {
      try {
        tokenCache.delete(this.currentUserToken);
        const accessToken = await acquireAccessToken(this.currentUserToken);
        if (accessToken) {
          this.lastRefreshTime = Date.now();
          this.sessionValid = true;
          return;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("invalid") || msg.includes("expired")) {
          this.sessionValid = false;
          throw new Error("Token expired \u2014 get a new userToken from DeepSeek localStorage");
        }
        if (attempt >= maxRefreshRetries - 1) throw error;
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1e3));
      }
    }
    throw new Error("Failed to refresh session after max retries");
  }
  executeBase(input) {
    return super.execute(input);
  }
  /**
   * Refresh the session once and re-run the base executor. Returns the retried
   * result, or `null` when the refresh itself fails (dead userToken) so the
   * caller surfaces the original failure instead of looping.
   */
  async refreshAndRetry(input) {
    this.retryCount++;
    try {
      await this.doRefreshSession();
      return await this.executeBase(input);
    } catch (refreshError) {
      console.error(
        `[DeepSeek-WEB] Session refresh failed (attempt ${this.retryCount}/${this.maxRetries}):`,
        refreshError
      );
      return null;
    }
  }
  async executeWithRetry(input) {
    try {
      const result = await this.executeBase(input);
      const status = result?.response?.status;
      if ((status === 401 || status === 403) && this.retryCount < this.maxRetries) {
        const retried = await this.refreshAndRetry(input);
        return retried ?? result;
      }
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const isUnauthorized = msg.includes("401") || msg.includes("Unauthorized") || msg.includes("expired");
      if (isUnauthorized && this.retryCount < this.maxRetries) {
        const retried = await this.refreshAndRetry(input);
        if (retried) return retried;
      }
      if (msg.includes("429") || msg.includes("Rate limit")) {
        console.warn("[DeepSeek-WEB] Rate limited:", msg);
      }
      throw error;
    }
  }
}
const deepseekWebWithAutoRefreshExecutor = new DeepSeekWebWithAutoRefreshExecutor();
export {
  DeepSeekWebWithAutoRefreshExecutor,
  deepseekWebWithAutoRefreshExecutor
};
