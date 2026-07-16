import { NOAUTH_PROVIDERS } from '../../dist/shared/constants/providers.js';
import { APIKEY_PROVIDERS } from '../../dist/shared/constants/providers.js';
import { WEB_COOKIE_PROVIDERS } from '../../dist/shared/constants/providers.js';
import { WEB_SESSION_CREDENTIAL_REQUIREMENTS } from '../../dist/shared/providers/webSessionCredentials.js';
const DEFAULT_THRESHOLD_MS = 2e3;
const SLOW_THRESHOLD_MS = 15e3;
const SLOW_PROVIDER_IDS = /* @__PURE__ */ new Set();
function addSlowProvider(id, alias) {
  SLOW_PROVIDER_IDS.add(id);
  if (typeof alias === "string" && alias) SLOW_PROVIDER_IDS.add(alias);
}
for (const [id, def] of Object.entries(NOAUTH_PROVIDERS)) {
  if (def.noAuth === true) {
    addSlowProvider(id, def.alias);
  }
}
for (const [id, def] of Object.entries(APIKEY_PROVIDERS)) {
  if (def.anonymousFallback === true) {
    addSlowProvider(id, def.alias);
  }
}
for (const [id, def] of Object.entries(WEB_COOKIE_PROVIDERS)) {
  addSlowProvider(id, def.alias);
}
for (const id of Object.keys(WEB_SESSION_CREDENTIAL_REQUIREMENTS)) {
  SLOW_PROVIDER_IDS.add(id);
}
const SLOW_KEEPALIVE_PROVIDERS = SLOW_PROVIDER_IDS;
function resolveKeepaliveThreshold(model) {
  if (!model || typeof model !== "string") return DEFAULT_THRESHOLD_MS;
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0) return DEFAULT_THRESHOLD_MS;
  const prefix = model.slice(0, slashIndex);
  if (SLOW_PROVIDER_IDS.has(prefix)) return SLOW_THRESHOLD_MS;
  return DEFAULT_THRESHOLD_MS;
}
export {
  SLOW_KEEPALIVE_PROVIDERS,
  resolveKeepaliveThreshold
};
