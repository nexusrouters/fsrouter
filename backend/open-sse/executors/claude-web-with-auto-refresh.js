import { ClaudeWebExecutor } from "./claude-web.ts";
import { getCfClearanceToken, getCacheStatus } from "../services/claudeTurnstileSolver.ts";
class ClaudeWebWithAutoRefresh extends ClaudeWebExecutor {
  retryCount = 0;
  maxRetries = 2;
  async execute(input) {
    const { credentials, log } = input;
    this.retryCount = 0;
    return this.executeWithRetry(input);
  }
  async executeWithRetry(input) {
    const { credentials, log } = input;
    let result = await super.execute(input);
    if (result.response.status === 200) {
      return result;
    }
    if ((result.response.status === 403 || result.response.status === 401) && this.retryCount < this.maxRetries) {
      this.retryCount++;
      log?.warn?.(
        "CLAUDE-WEB",
        `HTTP ${result.response.status} detected - attempt ${this.retryCount}/${this.maxRetries}`
      );
      try {
        const cacheStatus = getCacheStatus();
        const shouldForce = this.retryCount > 1;
        log?.info?.(
          "CLAUDE-WEB",
          `Solving Turnstile (cache: ${cacheStatus.hasCached ? `${Math.round((cacheStatus.expiresIn || 0) / 1e3)}s left` : "empty"})...`
        );
        const freshCfClearance = await getCfClearanceToken({ force: shouldForce });
        const rawCookie = String(credentials?.cookie || "");
        const hasCfClearance = rawCookie.includes("cf_clearance=");
        let newCookie;
        if (hasCfClearance) {
          newCookie = rawCookie.replace(/cf_clearance=[^;]+/, `cf_clearance=${freshCfClearance}`);
        } else {
          newCookie = `${rawCookie}; cf_clearance=${freshCfClearance}`;
        }
        log?.info?.("CLAUDE-WEB", "cf_clearance injected, retrying...");
        const updatedInput = {
          ...input,
          credentials: {
            ...credentials,
            cookie: newCookie
          }
        };
        result = await this.executeWithRetry(updatedInput);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log?.error?.("CLAUDE-WEB", `Auto-refresh failed: ${msg}`);
      }
    }
    return result;
  }
  async testConnection(credentials, signal) {
    try {
      const basicTest = await super.testConnection(credentials, signal);
      if (basicTest) return true;
      const rawCookie = String(credentials?.cookie || "");
      if (!rawCookie.trim()) return false;
      const freshCfClearance = await getCfClearanceToken();
      const newCookie = rawCookie.includes("cf_clearance=") ? rawCookie.replace(/cf_clearance=[^;]+/, `cf_clearance=${freshCfClearance}`) : `${rawCookie}; cf_clearance=${freshCfClearance}`;
      return await super.testConnection({ ...credentials, cookie: newCookie }, signal);
    } catch {
      return false;
    }
  }
}
const createClaudeWebExecutor = () => new ClaudeWebWithAutoRefresh();
export {
  ClaudeWebWithAutoRefresh,
  createClaudeWebExecutor
};
