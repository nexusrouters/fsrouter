import {
  findWorkingProxy,
  clearProxyFallbackCache
} from "@omniroute/open-sse/utils/proxyFallback.ts";
import { isFeatureFlagEnabled } from '../../dist/shared/utils/featureFlags.js';
async function selectProxyForValidation(targetUrl) {
  if (!isFeatureFlagEnabled("PROXY_AUTO_SELECT_ENABLED")) return null;
  if (!targetUrl) return null;
  let hostname;
  try {
    hostname = new URL(targetUrl).hostname;
    if (!hostname) return null;
  } catch {
    return null;
  }
  return findWorkingProxy(hostname, targetUrl);
}
function clearProxySelectionCache() {
  clearProxyFallbackCache();
}
export {
  clearProxySelectionCache,
  selectProxyForValidation
};
