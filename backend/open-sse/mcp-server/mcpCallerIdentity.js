import { getMcpHttpAuthHeadersForInternalFetch } from "./httpAuthContext.ts";
import { extractApiKey } from "../../src/sse/services/auth.ts";
import { getApiKeyMetadata } from "../../src/lib/db/apiKeys.ts";
async function resolvePrincipalFromHeaders(headers, lookup = getApiKeyMetadata) {
  if (!headers.Authorization && !headers["x-api-key"]) return void 0;
  const rawKey = extractApiKey({ headers: new Headers(headers) }, { allowUrl: false });
  if (!rawKey) return void 0;
  try {
    const meta = await lookup(rawKey);
    return meta?.id != null && meta.id !== "" ? String(meta.id) : void 0;
  } catch {
    return void 0;
  }
}
function resolveMcpCallerApiKeyId() {
  return resolvePrincipalFromHeaders(getMcpHttpAuthHeadersForInternalFetch());
}
export {
  resolveMcpCallerApiKeyId,
  resolvePrincipalFromHeaders
};
