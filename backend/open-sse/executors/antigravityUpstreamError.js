import { buildErrorBody } from "../utils/error.js";
function buildAntigravityUpstreamError(status, statusText, rawBody) {
  let upstreamDetails;
  try {
    upstreamDetails = JSON.parse(rawBody);
  } catch {
  }
  const suffix = statusText ? `: ${statusText}` : "";
  return buildErrorBody(status, `Antigravity upstream error (${status})${suffix}`, upstreamDetails);
}
export {
  buildAntigravityUpstreamError
};
