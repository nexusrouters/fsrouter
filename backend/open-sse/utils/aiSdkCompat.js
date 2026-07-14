function normalizeResolveStreamFlagOptions(optionsOrUserAgent) {
  if (optionsOrUserAgent && typeof optionsOrUserAgent === "object" && !Array.isArray(optionsOrUserAgent)) {
    return optionsOrUserAgent;
  }
  return { userAgent: optionsOrUserAgent };
}
function normalizeStreamDefaultMode(value) {
  return value === "json" ? "json" : "legacy";
}
function clientWantsJsonResponse(acceptHeader) {
  if (typeof acceptHeader !== "string") return false;
  const normalized = acceptHeader.toLowerCase();
  return normalized.includes("application/json") && !normalized.includes("text/event-stream");
}
function acceptHeaderForcesStream(acceptHeader, bodyStream) {
  if (bodyStream !== void 0) return false;
  if (typeof acceptHeader !== "string") return false;
  const normalized = acceptHeader.toLowerCase();
  return normalized.includes("text/event-stream") && !normalized.includes("application/json");
}
function resolveStreamFlag(bodyStream, acceptHeader, sourceFormat, optionsOrUserAgent) {
  const options = normalizeResolveStreamFlagOptions(optionsOrUserAgent);
  if (options.providerRequiresStreaming) return true;
  if (bodyStream === true) return true;
  if (bodyStream === false) return false;
  const streamDefaultMode = normalizeStreamDefaultMode(options.streamDefaultMode);
  const acceptsEventStream = typeof acceptHeader === "string" && /text\/event-stream/i.test(acceptHeader);
  if (sourceFormat === "claude" || sourceFormat === "openai-responses") {
    if (acceptsEventStream) return true;
    return false;
  }
  if (isKnownJsonOnlyClient(options.userAgent) && !acceptsEventStream) {
    return false;
  }
  if (streamDefaultMode === "json" && !acceptsEventStream) {
    return false;
  }
  if (typeof acceptHeader === "string" && /application\/json/i.test(acceptHeader)) {
    return false;
  }
  return !clientWantsJsonResponse(acceptHeader);
}
function isKnownJsonOnlyClient(userAgent) {
  if (typeof userAgent !== "string") return false;
  return /nextcloud\s+openai\/localai\s+integration/i.test(userAgent);
}
function resolveExplicitStreamAlias(body) {
  if (!body || typeof body !== "object") return void 0;
  const b = body;
  if (b.streaming === true) return true;
  if (b.streaming === false) return false;
  if (b.non_stream === true) return false;
  if (b.disable_stream === true) return false;
  if (b.disable_streaming === true) return false;
  return void 0;
}
function hasExplicitNoStreamParam(body) {
  return resolveExplicitStreamAlias(body) === false;
}
function stripMarkdownCodeFence(text) {
  if (typeof text !== "string") return text;
  const codeBlockRegex = /^```(?:json|javascript|typescript|js|ts)?\s*\n?([\s\S]*?)\n?```\s*$/i;
  const match = text.trim().match(codeBlockRegex);
  return match ? match[1].trim() : text;
}
export {
  acceptHeaderForcesStream,
  clientWantsJsonResponse,
  hasExplicitNoStreamParam,
  isKnownJsonOnlyClient,
  normalizeStreamDefaultMode,
  resolveExplicitStreamAlias,
  resolveStreamFlag,
  stripMarkdownCodeFence
};
