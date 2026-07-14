import { BaseExecutor } from "./base.ts";
import { describeChatGptWebHttpError } from "./chatgptWebErrors.ts";
import { prepareToolMessages } from "../translator/webTools.ts";
import { buildToolModeResponse } from "./chatgptWebTools.ts";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { sha3_512Hex } from "../utils/sha3-512.ts";
import {
  tlsFetchChatGpt,
  TlsClientUnavailableError
} from "../services/chatgptTlsClient.ts";
import {
  storeChatGptImage,
  getChatGptImageConversationContext,
  __resetChatGptImageCacheForTesting
} from "../services/chatgptImageCache.ts";
import { isThinkingCapableModel, resolveChatGptModel } from "./chatgpt-web/models.ts";
const CHATGPT_BASE = "https://chatgpt.com";
const SESSION_URL = `${CHATGPT_BASE}/api/auth/session`;
const SENTINEL_PREPARE_URL = `${CHATGPT_BASE}/backend-api/sentinel/chat-requirements/prepare`;
const SENTINEL_CR_URL = `${CHATGPT_BASE}/backend-api/sentinel/chat-requirements`;
const CONV_URL = `${CHATGPT_BASE}/backend-api/f/conversation`;
const USER_LAST_USED_MODEL_CONFIG_URL = `${CHATGPT_BASE}/backend-api/settings/user_last_used_model_config`;
const DEFAULT_PRO_POLL_TIMEOUT_MS = 20 * 6e4;
const DEFAULT_PRO_POLL_INTERVAL_MS = 4e3;
const CHATGPT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0";
const OAI_CLIENT_VERSION = "prod-81e0c5cdf6140e8c5db714d613337f4aeab94029";
const OAI_CLIENT_BUILD_NUMBER = "6128297";
const deviceIdCache = /* @__PURE__ */ new Map();
function deviceIdFor(cookie) {
  const key = cookieKey(cookie);
  let id = deviceIdCache.get(key);
  if (!id) {
    const h = createHash("sha256").update(cookie).digest("hex");
    id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(parseInt(h.slice(16, 17), 16) & 3 | 8).toString(16)}${h.slice(17, 20)}-` + h.slice(20, 32);
    if (deviceIdCache.size >= 200) {
      const first = deviceIdCache.keys().next().value;
      if (first) deviceIdCache.delete(first);
    }
    deviceIdCache.set(key, id);
  }
  return id;
}
function browserHeaders() {
  return {
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Origin: CHATGPT_BASE,
    Pragma: "no-cache",
    Referer: `${CHATGPT_BASE}/`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": CHATGPT_USER_AGENT
  };
}
function oaiHeaders(sessionId, deviceId) {
  return {
    "OAI-Language": "en-US",
    "OAI-Device-Id": deviceId,
    "OAI-Client-Version": OAI_CLIENT_VERSION,
    "OAI-Client-Build-Number": OAI_CLIENT_BUILD_NUMBER,
    "OAI-Session-Id": sessionId
  };
}
const TOKEN_TTL_MS = 5 * 60 * 1e3;
const tokenCache = /* @__PURE__ */ new Map();
function cookieKey(cookie) {
  return createHash("sha256").update(cookie).digest("hex").slice(0, 16);
}
function tokenLookup(cookie) {
  const entry = tokenCache.get(cookieKey(cookie));
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    tokenCache.delete(cookieKey(cookie));
    return null;
  }
  return entry;
}
const TOKEN_CACHE_MAX = 200;
function tokenStore(cookie, entry) {
  if (tokenCache.size >= TOKEN_CACHE_MAX && !tokenCache.has(cookieKey(cookie))) {
    const firstKey = tokenCache.keys().next().value;
    if (firstKey) tokenCache.delete(firstKey);
  }
  tokenCache.set(cookieKey(cookie), entry);
}
const SESSION_TOKEN_FAMILY_RE = /^__Secure-next-auth\.session-token(?:\.\d+)?$/;
function mergeRefreshedCookie(originalCookie, setCookieHeader) {
  if (!setCookieHeader) return null;
  const matches = Array.from(
    setCookieHeader.matchAll(/(__Secure-next-auth\.session-token(?:\.\d+)?)=([^;,\s]+)/g)
  );
  if (matches.length === 0) return null;
  const refreshed = /* @__PURE__ */ new Map();
  for (const m of matches) refreshed.set(m[1], m[2]);
  let blob = originalCookie.trim();
  if (/^cookie\s*:\s*/i.test(blob)) blob = blob.replace(/^cookie\s*:\s*/i, "");
  if (!/=/.test(blob)) {
    return Array.from(refreshed, ([k, v]) => `${k}=${v}`).join("; ");
  }
  const pairs = blob.split(/;\s*/).filter(Boolean);
  const result = [];
  let mutated = false;
  let droppedStale = false;
  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx < 0) {
      result.push(pair);
      continue;
    }
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1);
    if (SESSION_TOKEN_FAMILY_RE.test(name)) {
      if (!refreshed.has(name) || refreshed.get(name) !== value) mutated = true;
      droppedStale = true;
      continue;
    }
    result.push(`${name}=${value}`);
  }
  for (const [name, value] of refreshed) {
    result.push(`${name}=${value}`);
  }
  if (!droppedStale) mutated = true;
  return mutated ? result.join("; ") : null;
}
function buildSessionCookieHeader(rawInput) {
  let s = rawInput.trim();
  if (/^cookie\s*:\s*/i.test(s)) s = s.replace(/^cookie\s*:\s*/i, "");
  if (/__Secure-next-auth\.session-token(?:\.\d+)?\s*=/.test(s)) {
    return s;
  }
  return `__Secure-next-auth.session-token=${s}`;
}
async function exchangeSession(cookie, signal) {
  const cached = tokenLookup(cookie);
  if (cached) return cached;
  const headers = {
    ...browserHeaders(),
    Accept: "application/json",
    Cookie: buildSessionCookieHeader(cookie)
  };
  const response = await tlsFetchChatGpt(SESSION_URL, {
    method: "GET",
    headers,
    timeoutMs: 3e4,
    signal
  });
  if (response.status === 401 || response.status === 403) {
    throw new SessionAuthError("Invalid session cookie");
  }
  if (response.status >= 400) {
    throw new Error(`Session exchange failed (HTTP ${response.status})`);
  }
  const refreshed = mergeRefreshedCookie(cookie, response.headers.get("set-cookie"));
  let data = {};
  try {
    data = JSON.parse(response.text || "{}");
  } catch {
    console.warn("[chatgpt-web] session response JSON parse failed");
  }
  if (!data.accessToken) {
    throw new SessionAuthError("Session response missing accessToken \u2014 cookie likely expired");
  }
  const expiresAt = data.expires ? new Date(data.expires).getTime() : Date.now() + TOKEN_TTL_MS;
  const entry = {
    accessToken: data.accessToken,
    accountId: data.user?.id ?? null,
    expiresAt: Math.min(expiresAt, Date.now() + TOKEN_TTL_MS),
    refreshedCookie: refreshed ?? void 0
  };
  tokenStore(cookie, entry);
  return entry;
}
class SessionAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionAuthError";
  }
}
const warmupCache = /* @__PURE__ */ new Map();
const WARMUP_TTL_MS = 6e4;
const WARMUP_CACHE_MAX = 200;
async function runSessionWarmup(accessToken, accountId, sessionId, deviceId, cookie, signal, log) {
  const key = cookieKey(cookie) + ":" + accessToken.slice(-8);
  const now = Date.now();
  const last = warmupCache.get(key);
  if (last && now - last < WARMUP_TTL_MS) return;
  if (warmupCache.size >= WARMUP_CACHE_MAX && !warmupCache.has(key)) {
    const first = warmupCache.keys().next().value;
    if (first) warmupCache.delete(first);
  }
  warmupCache.set(key, now);
  const headers = {
    ...browserHeaders(),
    ...oaiHeaders(sessionId, deviceId),
    Accept: "*/*",
    Authorization: `Bearer ${accessToken}`,
    Cookie: buildSessionCookieHeader(cookie),
    Priority: "u=1, i"
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;
  const urls = [
    `${CHATGPT_BASE}/backend-api/me`,
    `${CHATGPT_BASE}/backend-api/conversations?offset=0&limit=28&order=updated`,
    `${CHATGPT_BASE}/backend-api/models?history_and_training_disabled=false`
  ];
  for (const url of urls) {
    try {
      const r = await tlsFetchChatGpt(url, {
        method: "GET",
        headers,
        timeoutMs: 15e3,
        signal
      });
      log?.debug?.("CGPT-WEB", `warmup ${url.split("/backend-api/")[1]} \u2192 ${r.status}`);
    } catch (err) {
      log?.debug?.(
        "CGPT-WEB",
        `warmup ${url} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
const thinkingEffortCache = /* @__PURE__ */ new Map();
const THINKING_EFFORT_TTL_MS = 5 * 60 * 1e3;
const THINKING_EFFORT_CACHE_MAX = 400;
function configuredProPollTimeoutMs() {
  const raw = Number(process.env.OMNIROUTE_CGPT_WEB_PRO_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PRO_POLL_TIMEOUT_MS;
  return Math.floor(raw);
}
function configuredProPollIntervalMs() {
  const raw = Number(process.env.OMNIROUTE_CGPT_WEB_PRO_POLL_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PRO_POLL_INTERVAL_MS;
  return Math.floor(raw);
}
async function setUserThinkingEffort(modelSlug, effort, accessToken, accountId, sessionId, deviceId, cookie, signal, log) {
  const cacheKey = `${cookieKey(cookie)}:${modelSlug}:${effort}`;
  const now = Date.now();
  const last = thinkingEffortCache.get(cacheKey);
  if (last && now - last < THINKING_EFFORT_TTL_MS) {
    log?.debug?.("CGPT-WEB", `thinking_effort cached (${modelSlug}=${effort}) \u2014 skip PATCH`);
    return;
  }
  if (thinkingEffortCache.size >= THINKING_EFFORT_CACHE_MAX && !thinkingEffortCache.has(cacheKey)) {
    const first = thinkingEffortCache.keys().next().value;
    if (first) thinkingEffortCache.delete(first);
  }
  const url = `${USER_LAST_USED_MODEL_CONFIG_URL}?model_slug=${encodeURIComponent(modelSlug)}&thinking_effort=${encodeURIComponent(effort)}`;
  const headers = {
    ...browserHeaders(),
    ...oaiHeaders(sessionId, deviceId),
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    Cookie: buildSessionCookieHeader(cookie),
    Priority: "u=4"
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;
  try {
    const r = await tlsFetchChatGpt(url, {
      method: "PATCH",
      headers,
      timeoutMs: 15e3,
      signal
    });
    if (r.status >= 400) {
      log?.warn?.(
        "CGPT-WEB",
        `thinking_effort PATCH ${r.status} for ${modelSlug}=${effort} (continuing)`
      );
      return;
    }
    thinkingEffortCache.set(cacheKey, now);
    log?.debug?.("CGPT-WEB", `thinking_effort PATCH OK (${modelSlug}=${effort})`);
  } catch (err) {
    log?.warn?.(
      "CGPT-WEB",
      `thinking_effort PATCH failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
async function prepareChatRequirements(accessToken, accountId, sessionId, deviceId, cookie, dplInfo, signal, log) {
  const config = buildPrekeyConfig(CHATGPT_USER_AGENT, dplInfo.dpl, dplInfo.scriptSrc);
  const prekey = await buildPrepareToken(config, log);
  const headers = {
    ...browserHeaders(),
    ...oaiHeaders(sessionId, deviceId),
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    Cookie: buildSessionCookieHeader(cookie),
    Priority: "u=1, i"
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;
  const prepResp = await tlsFetchChatGpt(SENTINEL_PREPARE_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ p: prekey }),
    timeoutMs: 3e4,
    signal
  });
  if (prepResp.status === 401 || prepResp.status === 403) {
    throw new SentinelBlockedError(`Sentinel /prepare blocked (HTTP ${prepResp.status})`);
  }
  if (prepResp.status >= 400) {
    throw new Error(`Sentinel /prepare failed (HTTP ${prepResp.status})`);
  }
  let prepData = {};
  try {
    prepData = JSON.parse(prepResp.text || "{}");
  } catch {
    console.warn("[chatgpt-web] chat requirements prep JSON parse failed");
  }
  if (!prepData.prepare_token) {
    return prepData;
  }
  const crBody = { p: prekey, prepare_token: prepData.prepare_token };
  const crResp = await tlsFetchChatGpt(SENTINEL_CR_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(crBody),
    timeoutMs: 3e4,
    signal
  });
  if (crResp.status === 401 || crResp.status === 403) {
    throw new SentinelBlockedError(`Sentinel /chat-requirements blocked (HTTP ${crResp.status})`);
  }
  if (crResp.status >= 400) {
    return prepData;
  }
  try {
    const crData = JSON.parse(crResp.text || "{}");
    return { ...crData, prepare_token: prepData.prepare_token };
  } catch {
    console.warn("[chatgpt-web] chat requirements response JSON parse failed");
    return prepData;
  }
}
class SentinelBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "SentinelBlockedError";
  }
}
let dplCache = null;
const DPL_TTL_MS = 60 * 60 * 1e3;
async function fetchDpl(cookie, signal) {
  if (dplCache && Date.now() < dplCache.expiresAt) {
    return { dpl: dplCache.dpl, scriptSrc: dplCache.scriptSrc };
  }
  const headers = {
    ...browserHeaders(),
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    Cookie: buildSessionCookieHeader(cookie)
  };
  const response = await tlsFetchChatGpt(`${CHATGPT_BASE}/`, {
    method: "GET",
    headers,
    timeoutMs: 2e4,
    signal
  });
  const html = response.text || "";
  const dplMatch = html.match(/data-build="([^"]+)"/);
  const dpl = dplMatch ? `dpl=${dplMatch[1]}` : `dpl=${OAI_CLIENT_VERSION.replace(/^prod-/, "")}`;
  const scriptMatch = html.match(/<script[^>]+src="(https?:\/\/[^"]*\.js[^"]*)"/);
  const scriptSrc = scriptMatch?.[1] ?? `${CHATGPT_BASE}/_next/static/chunks/webpack-${randomHex(16)}.js`;
  dplCache = { dpl, scriptSrc, expiresAt: Date.now() + DPL_TTL_MS };
  return { dpl, scriptSrc };
}
function randomHex(n) {
  return randomBytes(Math.ceil(n / 2)).toString("hex").slice(0, n);
}
const NAVIGATOR_KEYS = [
  "webdriver\u2212false",
  "geolocation",
  "languages",
  "language",
  "platform",
  "userAgent",
  "vendor",
  "hardwareConcurrency",
  "deviceMemory",
  "permissions",
  "plugins",
  "mediaDevices"
];
const DOCUMENT_KEYS = [
  "_reactListeningkfj3eavmks",
  "_reactListeningo743lnnpvdg",
  "location",
  "scrollingElement",
  "documentElement"
];
const WINDOW_KEYS = [
  "webpackChunk_N_E",
  "__NEXT_DATA__",
  "chrome",
  "history",
  "screen",
  "navigation",
  "scrollX",
  "scrollY"
];
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function buildPrekeyConfig(userAgent, dpl, scriptSrc) {
  const screenSizes = [3e3, 4e3, 3120, 4160];
  const cores = [8, 16, 24, 32];
  const dateStr = (/* @__PURE__ */ new Date()).toString();
  const perfNow = performance.now();
  const epochOffset = Date.now() - perfNow;
  return [
    pick(screenSizes),
    dateStr,
    4294705152,
    0,
    // mutated by solver
    userAgent,
    scriptSrc,
    dpl,
    "en-US",
    "en-US,en",
    0,
    // mutated by solver
    pick(NAVIGATOR_KEYS),
    pick(DOCUMENT_KEYS),
    pick(WINDOW_KEYS),
    perfNow,
    randomUUID(),
    "",
    pick(cores),
    epochOffset
  ];
}
const POW_YIELD_EVERY = 1e3;
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}
async function solvePow(opts) {
  const cfg = [...opts.config];
  for (let i = 0; i < opts.maxIter; i++) {
    if (i > 0 && i % POW_YIELD_EVERY === 0) await yieldToEventLoop();
    cfg[3] = i;
    const json = JSON.stringify(cfg);
    const b642 = Buffer.from(json).toString("base64");
    const hash = sha3_512Hex(opts.seed + b642);
    if (opts.target && hash.slice(0, opts.target.length) <= opts.target) {
      return `${opts.prefix}${b642}`;
    }
  }
  opts.log?.warn?.(
    "CGPT-WEB",
    `PoW (${opts.label}) exhausted ${opts.maxIter} iterations against target=${opts.target || "<empty>"}; submitting unsolved token (Sentinel may reject)`
  );
  const b64 = Buffer.from(JSON.stringify(cfg)).toString("base64");
  return `${opts.prefix}${b64}`;
}
async function buildPrepareToken(config, log) {
  return solvePow({
    config,
    seed: "",
    target: "0fffff",
    prefix: "gAAAAAC",
    maxIter: 1e5,
    label: "prepare",
    log
  });
}
async function solveProofOfWork(seed, difficulty, config, log) {
  return solvePow({
    config,
    seed,
    target: (difficulty || "").toLowerCase(),
    prefix: "gAAAAAB",
    maxIter: 5e5,
    label: "conversation",
    log
  });
}
const DATA_URI_IMAGE_RE = /!\[([^\]]*)\]\(data:image\/[^)]+\)/g;
const CACHED_IMAGE_URL_RE = /\/v1\/chatgpt-web\/image\/([a-f0-9]{16,64})(?=[)\s"'<>]|$)/gi;
function stripInlinedImages(content) {
  return content.replace(
    DATA_URI_IMAGE_RE,
    (_, alt) => alt ? `[${alt}: generated image]` : "[generated image]"
  );
}
function findCachedImageContext(content) {
  let latest = null;
  for (const match of content.matchAll(CACHED_IMAGE_URL_RE)) {
    const id = match[1];
    const context = getChatGptImageConversationContext(id);
    if (context) latest = context;
  }
  return latest;
}
function parseOpenAIMessages(messages) {
  let systemMsg = "";
  const history = [];
  let latestImageContext = null;
  for (const msg of messages) {
    let role = String(msg.role || "user");
    if (role === "developer") role = "system";
    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content.filter((c) => c.type === "text").map((c) => String(c.text || "")).join(" ");
    }
    content = stripInlinedImages(content);
    const imageContext = findCachedImageContext(content);
    if (imageContext) latestImageContext = imageContext;
    if (!content.trim()) continue;
    if (role === "system") {
      systemMsg += (systemMsg ? "\n" : "") + content;
    } else if (role === "user" || role === "assistant") {
      history.push({ role, content });
    }
  }
  let currentMsg = "";
  if (history.length > 0 && history[history.length - 1].role === "user") {
    currentMsg = history.pop().content;
  }
  return { systemMsg, history, currentMsg, latestImageContext };
}
const IMAGE_GEN_REGEXES = [
  // verb + (anything within 40 chars) + image-noun
  /\b(?:generate|create|make|draw|paint|render|produce|design|sketch|illustrate|show me)\b[\s\S]{0,40}\b(?:image|picture|photo|photograph|drawing|illustration|sketch|painting|portrait|logo|icon|art|artwork|wallpaper|render|graphic)\b/i,
  // image-noun + "of" — "image of a kitten", "picture of mountains"
  /\b(?:image|picture|photo|photograph|illustration|drawing|painting|render)\s+of\b/i,
  // direct verb + a/an article — "draw a kitten", "paint an apple"
  /\b(?:draw|paint|sketch|render|illustrate)\s+(?:me\s+)?(?:a|an|some|the)\s+\w+/i,
  // explicit slash command users sometimes type — "/imagine ..."
  /^\s*\/(?:image|imagine|img|draw|paint)\b/im
];
const OPENWEBUI_TOOL_PROMPT_MARKERS = [
  /<chat_history>/i,
  /^### Task:/im,
  /\bJSON format:\s*\{/i,
  /\bfollow_?ups\b.*\barray of strings\b/i
];
const OPENWEBUI_IMAGE_CONTEXT_MARKERS = [
  /<context>\s*The requested image has been (?:created|edited and created) by the system successfully/i,
  /<context>\s*The requested image has been edited and created and is now being shown to the user/i,
  /<context>\s*Image generation was attempted but failed/i
];
function hasOpenWebUIImageContext(parsed) {
  return OPENWEBUI_IMAGE_CONTEXT_MARKERS.some((re) => re.test(parsed.systemMsg));
}
function looksLikeImageGenRequest(parsed) {
  const text = parsed.currentMsg.trim();
  if (!text) return false;
  if (OPENWEBUI_TOOL_PROMPT_MARKERS.some((re) => re.test(text))) return false;
  if (hasOpenWebUIImageContext(parsed)) return false;
  return IMAGE_GEN_REGEXES.some((re) => re.test(text));
}
const IMAGE_EDIT_REGEXES = [
  /\b(?:edit|adjust|modify|change|update|alter|revise|retouch|fix)\b[\s\S]{0,120}\b(?:it|image|picture|photo|lighting|background|style|color|colour|composition|scene|time of day)\b/i,
  /\b(?:make|turn|set|switch)\s+(?:it|the\s+(?:image|picture|photo|scene))\b[\s\S]{0,120}\b/i,
  /\b(?:add|remove|replace)\b[\s\S]{0,120}\b(?:it|image|picture|photo|background|sky|person|object|text|logo)\b/i,
  /\b(?:brighter|darker|night|daytime|time of day|sunset|sunrise|morning|evening|lighting|relight|background|style)\b/i,
  /^\s*(?:now|then|also)\b[\s\S]{0,120}\b(?:make|turn|change|adjust|add|remove|replace|edit)\b/i
];
function looksLikeImageEditRequest(parsed) {
  if (!parsed.latestImageContext) return false;
  const text = parsed.currentMsg.trim();
  if (!text) return false;
  if (OPENWEBUI_TOOL_PROMPT_MARKERS.some((re) => re.test(text))) return false;
  if (hasOpenWebUIImageContext(parsed)) return false;
  return IMAGE_EDIT_REGEXES.some((re) => re.test(text));
}
function buildConversationBody(parsed, modelSlug, parentMessageId, options) {
  const systemParts = [];
  if (parsed.systemMsg.trim()) {
    systemParts.push(parsed.systemMsg.trim());
  }
  const continuation = options.continuation ?? null;
  if (!continuation && parsed.history.length > 0) {
    const formatted = parsed.history.map((h) => `${h.role === "assistant" ? "Assistant" : "User"}: ${h.content}`).join("\n\n");
    systemParts.push(
      `Prior conversation (for context \u2014 answer only the new user message below):

${formatted}`
    );
  }
  const messages = [];
  if (systemParts.length > 0) {
    messages.push({
      id: randomUUID(),
      author: { role: "system" },
      content: { content_type: "text", parts: [systemParts.join("\n\n")] }
    });
  }
  const currentUserContent = hasOpenWebUIImageContext(parsed) ? "Briefly acknowledge the image result described in the system context. Do not generate, edit, or request another image." : parsed.currentMsg || "";
  messages.push({
    id: randomUUID(),
    author: { role: "user" },
    content: { content_type: "text", parts: [currentUserContent] }
  });
  return {
    action: "next",
    messages,
    model: modelSlug,
    // Text-only API-style requests start fresh because clients replay full
    // history. Generated-image edits are the exception: ChatGPT needs the
    // original conversation node to adjust the actual image, not just a
    // markdown URL echoed back in a synthetic history block.
    conversation_id: continuation?.conversationId ?? null,
    parent_message_id: continuation?.parentMessageId ?? parentMessageId,
    timezone_offset_min: -(/* @__PURE__ */ new Date()).getTimezoneOffset(),
    // Temporary Chat is the default. Disable it only for image generation /
    // image edits, where ChatGPT needs durable conversation state for tools.
    history_and_training_disabled: !options.persistConversation,
    suggestions: [],
    websocket_request_id: randomUUID(),
    conversation_mode: { kind: "primary_assistant" },
    supports_buffering: true,
    force_parallel_switch: "auto",
    paragen_cot_summary_display_override: "allow",
    ...options.thinkingEffort ? { thinking_effort: options.thinkingEffort } : {}
  };
}
async function* readChatGptSseEvents(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines = [];
  let eventName = null;
  function flush() {
    if (dataLines.length === 0) {
      eventName = null;
      return null;
    }
    const payload = dataLines.join("\n");
    dataLines = [];
    const sseEventName = eventName;
    eventName = null;
    const trimmed = payload.trim();
    if (!trimmed || trimmed === "[DONE]") return "done";
    try {
      const parsed = JSON.parse(trimmed);
      if (sseEventName && !parsed.type) parsed.type = sseEventName;
      return parsed;
    } catch {
      console.warn("[chatgpt-web] stream event JSON parse failed");
      return null;
    }
  }
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line === "") {
          const parsed = flush();
          if (parsed === "done") return;
          if (parsed) yield parsed;
          continue;
        }
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().startsWith("data:")) {
      dataLines.push(buffer.trim().slice(5).trimStart());
    }
    const tail = flush();
    if (tail && tail !== "done") yield tail;
  } finally {
    reader.releaseLock();
  }
}
function extractImagePointers(parts) {
  const out = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const obj = p;
    if (obj.content_type === "image_asset_pointer" && typeof obj.asset_pointer === "string") {
      out.push(obj.asset_pointer);
    }
  }
  return out;
}
async function* extractContent(eventStream, signal) {
  let conversationId = null;
  let currentId = null;
  let currentParts = "";
  let emittedLen = 0;
  let isLive = false;
  const imagePointers = /* @__PURE__ */ new Map();
  let imageGenAsync = false;
  let handoff = false;
  for await (const event of readChatGptSseEvents(eventStream, signal)) {
    if (event.error) {
      const msg = typeof event.error === "string" ? event.error : event.error.message || "ChatGPT stream error";
      yield { error: msg, done: true };
      return;
    }
    if (event.conversation_id) conversationId = event.conversation_id;
    if (event.type === "stream_handoff") {
      handoff = true;
      yield {
        conversationId: conversationId ?? void 0,
        handoff: true
      };
      continue;
    }
    if (event.type === "server_ste_metadata") {
      const meta = event.metadata;
      if (meta && meta.turn_use_case === "image gen") {
        imageGenAsync = true;
      }
    }
    const m = event.message;
    if (!m) continue;
    if (m.metadata && typeof m.metadata.image_gen_task_id === "string") {
      imageGenAsync = true;
    }
    if (m.author?.role !== "assistant") continue;
    const id = m.id ?? null;
    const status = m.status ?? "";
    if (id && id !== currentId) {
      currentId = id;
      currentParts = "";
      emittedLen = 0;
      isLive = false;
    }
    if (status === "in_progress") {
      isLive = true;
    }
    const parts = m.content?.parts ?? [];
    if (parts.length === 0) continue;
    if (status === "finished_successfully" || status === "" || isLive) {
      for (const ptr of extractImagePointers(parts)) {
        const existing = imagePointers.get(ptr);
        imagePointers.set(
          ptr,
          existing?.messageId ? existing : { pointer: ptr, ...id ? { messageId: id } : {} }
        );
      }
    }
    const cumulative = parts.map((p) => typeof p === "string" ? p : "").join("");
    if (cumulative.length > currentParts.length) {
      currentParts = cumulative;
    }
    if (isLive && currentParts.length > emittedLen) {
      const delta = currentParts.slice(emittedLen);
      emittedLen = currentParts.length;
      yield {
        delta,
        answer: currentParts,
        conversationId: conversationId ?? void 0,
        messageId: currentId ?? void 0
      };
    }
  }
  if (!isLive && currentParts.length > emittedLen) {
    yield {
      delta: currentParts.slice(emittedLen),
      answer: currentParts,
      conversationId: conversationId ?? void 0,
      messageId: currentId ?? void 0
    };
  }
  yield {
    delta: "",
    answer: currentParts,
    conversationId: conversationId ?? void 0,
    messageId: currentId ?? void 0,
    imagePointers: imagePointers.size > 0 ? Array.from(imagePointers.values()) : void 0,
    imageGenAsync,
    handoff,
    done: true
  };
}
function textFromContentPart(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const obj = part;
  for (const key of ["text", "content", "summary"]) {
    const value = obj[key];
    if (typeof value === "string") return value;
  }
  return "";
}
function detailMessageText(message) {
  const content = message.content;
  if (!content) return "";
  if (typeof content.text === "string") return content.text;
  const parts = content.parts ?? [];
  return parts.map(textFromContentPart).join("");
}
function extractFinalAssistantAnswer(detail) {
  const nodes = Object.values(detail.mapping ?? {});
  let best = null;
  for (const node of nodes) {
    const message = node.message;
    if (!message || message.author?.role !== "assistant") continue;
    if (message.metadata?.is_visually_hidden === true) continue;
    const contentType = message.content?.content_type ?? "";
    if (contentType.includes("thought") || contentType.includes("reasoning")) continue;
    const text = detailMessageText(message).trim();
    if (!text) continue;
    const finished = message.status === "finished_successfully" && message.end_turn !== false;
    const sort = message.update_time ?? message.create_time ?? 0;
    if (!best || finished && (!best.finished || sort >= best.sort) || !finished && !best.finished && sort >= best.sort) {
      best = { text, messageId: message.id, finished, sort };
    }
  }
  if (!best) return null;
  return { text: best.text, messageId: best.messageId, finished: best.finished };
}
function delayWithAbort(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function decodeUtf8DataUrl(text) {
  const marker = ";base64,";
  if (!text.startsWith("data:") || !text.includes(marker)) return text;
  const base64 = text.slice(text.indexOf(marker) + marker.length);
  return new TextDecoder().decode(Buffer.from(base64, "base64"));
}
async function fetchConversationDetail(conversationId, ctx) {
  const url = `${CHATGPT_BASE}/backend-api/conversation/${encodeURIComponent(conversationId)}`;
  const headers = {
    ...browserHeaders(),
    ...oaiHeaders(ctx.sessionId, ctx.deviceId),
    Accept: "application/json",
    Authorization: `Bearer ${ctx.accessToken}`,
    Cookie: buildSessionCookieHeader(ctx.cookie)
  };
  if (ctx.accountId) headers["chatgpt-account-id"] = ctx.accountId;
  try {
    const response = await tlsFetchChatGpt(url, {
      method: "GET",
      headers,
      timeoutMs: 3e4,
      signal: ctx.signal,
      // The native tls-client text path can surface UTF-8 JSON as mojibake
      // (e.g. 👉 becomes ðŸ‘‰). Ask for raw bytes and decode as UTF-8 here so
      // the final answer appended after Pro stream_handoff preserves Unicode.
      byteResponse: true
    });
    if (response.status >= 400) {
      ctx.log?.warn?.(
        "CGPT-WEB",
        `conversation poll ${response.status}: ${(response.text || "").slice(0, 300)}`
      );
      return { detail: null, terminal: [401, 403, 404].includes(response.status) };
    }
    if (!response.text) return { detail: null, terminal: false };
    return {
      detail: JSON.parse(decodeUtf8DataUrl(response.text)),
      terminal: false
    };
  } catch (err) {
    ctx.log?.warn?.(
      "CGPT-WEB",
      `conversation poll failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return { detail: null, terminal: false };
  }
}
async function pollForFinalAssistantAnswer(conversationId, ctx) {
  const started = Date.now();
  const timeoutMs = configuredProPollTimeoutMs();
  const intervalMs = configuredProPollIntervalMs();
  let last = null;
  let terminalPollFailure = false;
  while (!ctx.signal?.aborted && Date.now() - started < timeoutMs) {
    const { detail, terminal } = await fetchConversationDetail(conversationId, ctx);
    if (detail) {
      const answer = extractFinalAssistantAnswer(detail);
      if (answer) {
        last = answer;
        if (answer.finished) return answer;
      }
    }
    if (terminal) {
      terminalPollFailure = true;
      break;
    }
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) break;
    await delayWithAbort(Math.min(intervalMs, remaining), ctx.signal);
  }
  if (last) {
    ctx.log?.warn?.(
      "CGPT-WEB",
      terminalPollFailure ? `conversation poll stopped before finished_successfully; returning latest assistant text for ${conversationId}` : `conversation poll timed out before finished_successfully; returning latest assistant text for ${conversationId}`
    );
  } else {
    ctx.log?.warn?.(
      "CGPT-WEB",
      terminalPollFailure ? `conversation poll stopped without assistant text for ${conversationId}` : `conversation poll timed out without assistant text for ${conversationId}`
    );
  }
  return last;
}
function sseChunk(data) {
  return `data: ${JSON.stringify(data)}

`;
}
function detectImageResolutionFailure(pointerCount, resolvedCount) {
  return pointerCount > 0 && resolvedCount === 0;
}
function imageMarkdown(urls) {
  if (urls.length === 0) return "";
  return "\n\n" + urls.map((u) => `![image](${u})`).join("\n\n");
}
async function resolveImagePointers(pointers, conversationId, resolver, log, fallbackParentMessageId) {
  if (!pointers || pointers.length === 0 || !resolver) return [];
  const urls = [];
  for (const ref of pointers) {
    try {
      const url = await resolver(
        ref.pointer,
        conversationId,
        ref.messageId ?? fallbackParentMessageId
      );
      if (url) urls.push(url);
    } catch (err) {
      log?.warn?.(
        "CGPT-WEB",
        `Image resolve failed (${ref.pointer}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return urls;
}
function buildStreamingResponse(eventStream, model, cid, created, resolver, pollAsyncImage, pollFinalAnswer, log, signal) {
  const encoder = new TextEncoder();
  return new ReadableStream(
    {
      async start(controller) {
        try {
          controller.enqueue(
            encoder.encode(
              sseChunk({
                id: cid,
                object: "chat.completion.chunk",
                created,
                model,
                system_fingerprint: null,
                choices: [
                  { index: 0, delta: { role: "assistant" }, finish_reason: null, logprobs: null }
                ]
              })
            )
          );
          let conversationId = null;
          let imagePointers;
          let imageGenAsync = false;
          let handoff = false;
          let emittedText = "";
          let polledFinalAnswer = "";
          let parentCandidateMessageId = null;
          const emitTextDelta = (content) => {
            const cleaned = cleanChatGptText(content);
            if (!cleaned) return;
            emittedText += cleaned;
            controller.enqueue(
              encoder.encode(
                sseChunk({
                  id: cid,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  system_fingerprint: null,
                  choices: [
                    {
                      index: 0,
                      delta: { content: cleaned },
                      finish_reason: null,
                      logprobs: null
                    }
                  ]
                })
              )
            );
          };
          const appendFinalAnswer = (text) => {
            const cleaned = cleanChatGptText(text);
            const finalTrimmed = cleaned.trim();
            if (!finalTrimmed) return;
            const emittedTrimmed = emittedText.trim();
            if (emittedTrimmed === finalTrimmed || emittedTrimmed.endsWith(finalTrimmed)) return;
            const prefix = emittedTrimmed && !emittedText.endsWith("\n") ? "\n\n" : "";
            emitTextDelta(`${prefix}${cleaned}`);
          };
          const startHeartbeat = (intervalMs = 5e3) => {
            const heartbeatChunk = sseChunk({
              id: cid,
              object: "chat.completion.chunk",
              created,
              model,
              system_fingerprint: null,
              choices: [{ index: 0, delta: { content: "\u200B" }, finish_reason: null, logprobs: null }]
            });
            const timer = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(heartbeatChunk));
              } catch {
                console.warn("[chatgpt-web] heartbeat enqueue failed - controller closed");
                clearInterval(timer);
              }
            }, intervalMs);
            return () => clearInterval(timer);
          };
          for await (const chunk of extractContent(eventStream, signal)) {
            if (chunk.conversationId) conversationId = chunk.conversationId;
            if (chunk.messageId) parentCandidateMessageId = chunk.messageId;
            if (chunk.handoff) handoff = true;
            if (chunk.error) {
              controller.enqueue(
                encoder.encode(
                  sseChunk({
                    id: cid,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    system_fingerprint: null,
                    choices: [
                      {
                        index: 0,
                        delta: { content: `[Error: ${chunk.error}]` },
                        finish_reason: null,
                        logprobs: null
                      }
                    ]
                  })
                )
              );
              break;
            }
            if (chunk.done) {
              imagePointers = chunk.imagePointers;
              imageGenAsync = chunk.imageGenAsync ?? false;
              handoff = handoff || (chunk.handoff ?? false);
              if (chunk.messageId) parentCandidateMessageId = chunk.messageId;
              break;
            }
            if (chunk.delta) {
              emitTextDelta(chunk.delta);
            }
          }
          if (pollFinalAnswer && conversationId && handoff) {
            const stopHb = startHeartbeat();
            try {
              const polled = await pollFinalAnswer(conversationId);
              if (polled?.text) {
                polledFinalAnswer = polled.text;
                if (polled.messageId) parentCandidateMessageId = polled.messageId;
              }
            } finally {
              stopHb();
            }
          }
          if (polledFinalAnswer) {
            appendFinalAnswer(polledFinalAnswer);
          }
          if (imageGenAsync && conversationId && (!imagePointers || imagePointers.length === 0) && pollAsyncImage) {
            controller.enqueue(
              encoder.encode(
                sseChunk({
                  id: cid,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  system_fingerprint: null,
                  choices: [
                    {
                      index: 0,
                      delta: { content: "_Generating image\u2026_\n\n" },
                      finish_reason: null,
                      logprobs: null
                    }
                  ]
                })
              )
            );
            const stopHb = startHeartbeat();
            try {
              const polled = await pollAsyncImage(conversationId);
              if (polled.length > 0) imagePointers = polled;
            } catch (err) {
              log?.warn?.(
                "CGPT-WEB",
                `Async image poll failed: ${err instanceof Error ? err.message : String(err)}`
              );
            } finally {
              stopHb();
            }
          }
          const stopHb2 = startHeartbeat();
          let urls = [];
          try {
            urls = await resolveImagePointers(
              imagePointers,
              conversationId,
              resolver,
              log,
              parentCandidateMessageId
            );
          } finally {
            stopHb2();
          }
          if (signal?.aborted) return;
          const mdBlock = imageMarkdown(urls);
          const safeEnqueue = (bytes) => {
            try {
              controller.enqueue(bytes);
              return true;
            } catch {
              console.warn("[chatgpt-web] controller enqueue failed");
              return false;
            }
          };
          if (mdBlock) {
            if (!safeEnqueue(
              encoder.encode(
                sseChunk({
                  id: cid,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  system_fingerprint: null,
                  choices: [
                    {
                      index: 0,
                      delta: { content: mdBlock },
                      finish_reason: null,
                      logprobs: null
                    }
                  ]
                })
              )
            ))
              return;
          }
          if (!safeEnqueue(
            encoder.encode(
              sseChunk({
                id: cid,
                object: "chat.completion.chunk",
                created,
                model,
                system_fingerprint: null,
                choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }]
              })
            )
          ))
            return;
          safeEnqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (err) {
          controller.enqueue(
            encoder.encode(
              sseChunk({
                id: cid,
                object: "chat.completion.chunk",
                created,
                model,
                system_fingerprint: null,
                choices: [
                  {
                    index: 0,
                    delta: {
                      content: `[Stream error: ${err instanceof Error ? err.message : String(err)}]`
                    },
                    finish_reason: "stop",
                    logprobs: null
                  }
                ]
              })
            )
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } finally {
          try {
            controller.close();
          } catch {
          }
        }
      }
    },
    { highWaterMark: 16384 }
  );
}
async function buildNonStreamingResponse(eventStream, model, cid, created, currentMsg, resolver, pollAsyncImage, pollFinalAnswer, log, signal) {
  let fullAnswer = "";
  let conversationId = null;
  let imagePointers;
  let imageGenAsync = false;
  let handoff = false;
  let parentCandidateMessageId = null;
  for await (const chunk of extractContent(eventStream, signal)) {
    if (chunk.conversationId) conversationId = chunk.conversationId;
    if (chunk.messageId) parentCandidateMessageId = chunk.messageId;
    if (chunk.handoff) handoff = true;
    if (chunk.error) {
      return new Response(
        JSON.stringify({
          error: { message: chunk.error, type: "upstream_error", code: "CHATGPT_ERROR" }
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }
    if (chunk.done) {
      fullAnswer = chunk.answer || fullAnswer;
      imagePointers = chunk.imagePointers;
      imageGenAsync = chunk.imageGenAsync ?? false;
      handoff = handoff || (chunk.handoff ?? false);
      if (chunk.messageId) parentCandidateMessageId = chunk.messageId;
      break;
    }
    if (chunk.answer) fullAnswer = chunk.answer;
  }
  if (pollFinalAnswer && conversationId && (handoff || !fullAnswer.trim())) {
    const polled = await pollFinalAnswer(conversationId);
    if (polled?.text) {
      fullAnswer = polled.text;
      if (polled.messageId) parentCandidateMessageId = polled.messageId;
    }
  }
  fullAnswer = cleanChatGptText(fullAnswer);
  if (imageGenAsync && conversationId && (!imagePointers || imagePointers.length === 0) && pollAsyncImage) {
    try {
      const polled = await pollAsyncImage(conversationId);
      if (polled.length > 0) imagePointers = polled;
    } catch (err) {
      log?.warn?.(
        "CGPT-WEB",
        `Async image poll failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  const urls = await resolveImagePointers(
    imagePointers,
    conversationId,
    resolver,
    log,
    parentCandidateMessageId
  );
  const imageResolutionFailed = detectImageResolutionFailure(
    imagePointers?.length ?? 0,
    urls.length
  );
  if (imageResolutionFailed && log?.warn) {
    const schemes = (imagePointers ?? []).map((p) => p.pointer.split("://")[0] || p.pointer.slice(0, 24)).join(", ");
    log.warn(
      "CGPT-WEB",
      `Image generated upstream but no asset pointer resolved (schemes: ${schemes}) \u2014 surfacing as unretrievable`
    );
  }
  fullAnswer += imageMarkdown(urls);
  const promptTokens = Math.ceil(currentMsg.length / 4);
  const completionTokens = Math.ceil(fullAnswer.length / 4);
  return new Response(
    JSON.stringify({
      id: cid,
      object: "chat.completion",
      created,
      model,
      system_fingerprint: null,
      ...imageResolutionFailed ? { x_image_resolution_failed: true } : {},
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: fullAnswer },
          finish_reason: "stop",
          logprobs: null
        }
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      }
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
function errorResponse(status, message, code) {
  return new Response(
    JSON.stringify({ error: { message, type: "upstream_error", ...code ? { code } : {} } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}
function normalizePublicBaseUrl(value) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "").replace(/\/v1$/i, "");
}
function firstForwardedValue(value) {
  const first = value?.split(",")[0]?.trim();
  return first || null;
}
function isLocalBaseUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
  } catch {
    console.warn("[chatgpt-web] URL parse failed, falling back to regex");
    return /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/i.test(baseUrl);
  }
}
function deriveHeaderBaseUrl(clientHeaders) {
  const headers = clientHeaders ?? {};
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const forwardedHost = firstForwardedValue(lower["x-forwarded-host"]);
  const forwardedProto = firstForwardedValue(lower["x-forwarded-proto"]);
  const host = forwardedHost || firstForwardedValue(lower["host"]);
  if (!host) return null;
  const isPlain = host.includes("localhost") || /^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(host) || host.endsWith(".local") || host.includes(":");
  const proto = forwardedProto || (isPlain ? "http" : "https");
  return `${proto}://${host}`;
}
function derivePublicBaseUrl(clientHeaders, log) {
  const explicitPublicBase = normalizePublicBaseUrl(process.env.OMNIROUTE_PUBLIC_BASE_URL);
  if (explicitPublicBase) {
    log?.debug?.("CGPT-WEB", `derivePublicBaseUrl: using OMNIROUTE_PUBLIC_BASE_URL`);
    return explicitPublicBase;
  }
  const headerBase = deriveHeaderBaseUrl(clientHeaders);
  const configuredBase = normalizePublicBaseUrl(process.env.OMNIROUTE_BASE_URL) || normalizePublicBaseUrl(process.env.NEXT_PUBLIC_BASE_URL);
  log?.debug?.(
    "CGPT-WEB",
    `derivePublicBaseUrl: configured=${configuredBase ?? "-"} header=${headerBase ?? "-"}`
  );
  if (configuredBase && (!headerBase || !isLocalBaseUrl(configuredBase))) return configuredBase;
  if (headerBase) return headerBase;
  if (configuredBase) return configuredBase;
  return `http://localhost:${process.env.PORT || 20128}`;
}
const FILE_SERVICE_PREFIX = "file-service://";
const SEDIMENT_PREFIX = "sediment://";
async function fetchDownloadUrl(endpoint, ctx) {
  const headers = {
    ...browserHeaders(),
    ...oaiHeaders(ctx.sessionId, ctx.deviceId),
    Accept: "application/json",
    Authorization: `Bearer ${ctx.accessToken}`,
    Cookie: buildSessionCookieHeader(ctx.cookie)
  };
  if (ctx.accountId) headers["chatgpt-account-id"] = ctx.accountId;
  const response = await tlsFetchChatGpt(endpoint, {
    method: "GET",
    headers,
    timeoutMs: 3e4,
    signal: ctx.signal
  });
  if (response.status !== 200) {
    ctx.log?.warn?.(
      "CGPT-WEB",
      `Image download URL fetch failed (${response.status}) for ${endpoint}`
    );
    return null;
  }
  let parsed = {};
  try {
    parsed = JSON.parse(response.text || "{}");
  } catch {
    console.warn("[chatgpt-web] image download URL parse failed");
    return null;
  }
  return parsed.download_url ?? null;
}
const IMAGE_DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024;
async function imageUrlToCachedImageUrl(signedUrl, ctx, imageContext) {
  const headers = {
    ...browserHeaders(),
    Accept: "image/*,*/*;q=0.8",
    Authorization: `Bearer ${ctx.accessToken}`,
    Cookie: buildSessionCookieHeader(ctx.cookie)
  };
  if (ctx.accountId) headers["chatgpt-account-id"] = ctx.accountId;
  let response;
  try {
    response = await tlsFetchChatGpt(signedUrl, {
      method: "GET",
      headers,
      timeoutMs: 6e4,
      signal: ctx.signal,
      // Required for binary payloads — the underlying tls-client returns
      // bytes as a `data:<mime>;base64,...` string when this is true.
      // Without it, raw image bytes get mangled by UTF-8 decoding.
      byteResponse: true
    });
  } catch (err) {
    ctx.log?.warn?.(
      "CGPT-WEB",
      `Image fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
  if (response.status !== 200) {
    ctx.log?.warn?.(
      "CGPT-WEB",
      `Image fetch returned HTTP ${response.status} (${(response.text || "").slice(0, 120)})`
    );
    return null;
  }
  if (response.text == null || response.text.length === 0) return null;
  let bytes;
  let mime;
  if (/^data:[^;]{1,256};base64,/.test(response.text)) {
    const commaIdx = response.text.indexOf(",");
    const header = response.text.slice(5, commaIdx);
    mime = header.split(";")[0] || "image/png";
    bytes = Buffer.from(response.text.slice(commaIdx + 1), "base64");
  } else {
    bytes = Buffer.from(response.text, "binary");
    mime = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  }
  if (bytes.length === 0 || bytes.length > IMAGE_DOWNLOAD_MAX_BYTES) {
    if (bytes.length > IMAGE_DOWNLOAD_MAX_BYTES) {
      ctx.log?.warn?.(
        "CGPT-WEB",
        `Image too large to cache (${bytes.length} bytes > ${IMAGE_DOWNLOAD_MAX_BYTES}); skipping`
      );
    }
    return null;
  }
  const id = storeChatGptImage(bytes, mime, void 0, imageContext);
  return `${ctx.publicBaseUrl}/v1/chatgpt-web/image/${id}`;
}
async function registerWebSocket(ctx) {
  const candidates = [
    { url: `${CHATGPT_BASE}/backend-api/celsius/ws/user`, method: "GET" },
    { url: `${CHATGPT_BASE}/backend-api/register-websocket`, method: "POST" }
  ];
  const headers = {
    ...browserHeaders(),
    ...oaiHeaders(ctx.sessionId, ctx.deviceId),
    Accept: "application/json",
    Authorization: `Bearer ${ctx.accessToken}`,
    Cookie: buildSessionCookieHeader(ctx.cookie)
  };
  if (ctx.accountId) headers["chatgpt-account-id"] = ctx.accountId;
  for (const { url, method } of candidates) {
    let r;
    try {
      r = await tlsFetchChatGpt(url, {
        method,
        headers,
        body: method === "POST" ? "" : void 0,
        timeoutMs: 3e4,
        signal: ctx.signal
      });
    } catch (err) {
      ctx.log?.warn?.(
        "CGPT-WEB",
        `register-websocket fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    if (r.status === 200) {
      try {
        const data = JSON.parse(r.text || "{}");
        const ws = data.websocket_url ?? data.wss_url;
        if (ws) {
          ctx.log?.debug?.("CGPT-WEB", `Got WebSocket URL via ${url}`);
          return ws;
        }
      } catch {
        console.warn("[chatgpt-web] WebSocket URL parse failed, falling through");
      }
    }
    ctx.log?.warn?.(
      "CGPT-WEB",
      `register-websocket via ${url} \u2192 ${r.status}: ${(r.text || "").slice(0, 200)}`
    );
  }
  return null;
}
async function waitForImageViaWebSocket(wssUrl, conversationId, timeoutMs, ctx) {
  return new Promise((resolve) => {
    const found = /* @__PURE__ */ new Map();
    let resolved = false;
    let errored = false;
    let gotAnyMessage = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      try {
        ws.close();
      } catch {
        console.warn("[chatgpt-web] ws.close failed");
      }
      resolve({
        pointers: Array.from(found.values()),
        errored,
        gotAnyMessage
      });
    };
    const ws = new WebSocket(wssUrl);
    const timer = setTimeout(() => {
      ctx.log?.warn?.("CGPT-WEB", `WebSocket image wait timed out after ${timeoutMs}ms`);
      finish();
    }, timeoutMs);
    const onAbort = () => {
      ctx.log?.debug?.("CGPT-WEB", "WebSocket aborted by client");
      finish();
    };
    ctx.signal?.addEventListener?.("abort", onAbort);
    ws.onopen = () => {
      gotAnyMessage = true;
      ctx.log?.debug?.("CGPT-WEB", "WebSocket open \u2014 waiting for image events");
    };
    ws.onerror = (e) => {
      errored = true;
      ctx.log?.warn?.("CGPT-WEB", `WebSocket error: ${e.message ?? "unknown"}`);
    };
    ws.onclose = () => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener?.("abort", onAbort);
      finish();
    };
    ws.onmessage = (event) => {
      gotAnyMessage = true;
      let payload;
      const raw = typeof event.data === "string" ? event.data : event.data.toString();
      try {
        payload = JSON.parse(raw);
      } catch {
        console.warn("[chatgpt-web] WebSocket event JSON parse failed");
        return;
      }
      const obj = payload;
      const candidates = [];
      const innerPayload = obj.payload;
      const updateContent = innerPayload?.update_content;
      if (updateContent?.message) {
        candidates.push({
          message: updateContent.message,
          conversation_id: innerPayload?.conversation_id
        });
      }
      if (innerPayload?.message) {
        candidates.push({
          message: innerPayload.message,
          conversation_id: innerPayload.conversation_id
        });
      }
      if (obj.data?.message) {
        candidates.push(obj.data);
      }
      for (const data of candidates) {
        if (data?.conversation_id && data.conversation_id !== conversationId) continue;
        const m = data?.message;
        if (Array.isArray(m?.content?.parts)) {
          for (const ptr of extractImagePointers(m.content?.parts ?? [])) {
            const existing = found.get(ptr);
            found.set(
              ptr,
              existing?.messageId ? existing : { pointer: ptr, ...m?.id ? { messageId: m.id } : {} }
            );
          }
        }
        if (m?.metadata && typeof m.metadata === "object") {
          const md = m.metadata;
          const ptr = md.asset_pointer ?? md.image_asset_pointer;
          if (typeof ptr === "string") {
            const existing = found.get(ptr);
            found.set(
              ptr,
              existing?.messageId ? existing : { pointer: ptr, ...m?.id ? { messageId: m.id } : {} }
            );
          }
        }
      }
      if (found.size > 0) finish();
    };
  });
}
const DEFAULT_ASYNC_IMAGE_TIMEOUT_MS = 18e4;
function configuredAsyncImageTimeoutMs() {
  const raw = Number(process.env.OMNIROUTE_CGPT_WEB_IMAGE_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ASYNC_IMAGE_TIMEOUT_MS;
  return Math.floor(raw);
}
async function pollForAsyncImage(conversationId, ctx, opts = {}) {
  const totalTimeoutMs = opts.timeoutMs ?? configuredAsyncImageTimeoutMs();
  const deadline = Date.now() + totalTimeoutMs;
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const wssUrl = await registerWebSocket(ctx);
    if (!wssUrl) {
      ctx.log?.warn?.(
        "CGPT-WEB",
        attempt === 0 ? "Could not register WebSocket \u2014 async image gen not retrievable" : `WebSocket re-registration failed on retry attempt ${attempt + 1}`
      );
      if (attempt === 0) continue;
      return [];
    }
    ctx.log?.debug?.(
      "CGPT-WEB",
      `Registered WebSocket for async image (attempt ${attempt + 1}, ${remaining}ms remaining)`
    );
    const outcome = await waitForImageViaWebSocket(wssUrl, conversationId, remaining, ctx);
    if (outcome.pointers.length > 0) return outcome.pointers;
    if (ctx.signal?.aborted) return [];
    if (!outcome.errored || outcome.gotAnyMessage) return [];
    ctx.log?.warn?.(
      "CGPT-WEB",
      `WebSocket attempt ${attempt + 1} ended in transport error before any frame; retrying`
    );
  }
  return [];
}
function makeImageResolver(ctx) {
  const cache = /* @__PURE__ */ new Map();
  return async (assetPointer, conversationId, parentMessageId) => {
    if (cache.has(assetPointer)) return cache.get(assetPointer) ?? null;
    let fileId = null;
    if (assetPointer.startsWith(FILE_SERVICE_PREFIX)) {
      fileId = assetPointer.slice(FILE_SERVICE_PREFIX.length);
    } else if (assetPointer.startsWith(SEDIMENT_PREFIX)) {
      fileId = assetPointer.slice(SEDIMENT_PREFIX.length);
    } else {
      ctx.log?.warn?.("CGPT-WEB", `Unknown asset_pointer scheme: ${assetPointer}`);
    }
    let signedUrl = null;
    if (fileId) {
      signedUrl = await fetchDownloadUrl(
        `${CHATGPT_BASE}/backend-api/files/${encodeURIComponent(fileId)}/download`,
        ctx
      );
      if (!signedUrl && conversationId) {
        signedUrl = await fetchDownloadUrl(
          `${CHATGPT_BASE}/backend-api/conversation/${encodeURIComponent(conversationId)}/attachment/${encodeURIComponent(fileId)}/download`,
          ctx
        );
      }
    }
    let finalUrl = null;
    if (signedUrl) {
      finalUrl = await imageUrlToCachedImageUrl(
        signedUrl,
        ctx,
        conversationId && parentMessageId ? { conversationId, parentMessageId } : void 0
      );
    }
    cache.set(assetPointer, finalUrl);
    if (finalUrl) {
      const preview = finalUrl.startsWith("data:") ? `data:... (${finalUrl.length} chars)` : finalUrl.slice(0, 80) + "...";
      ctx.log?.debug?.("CGPT-WEB", `Resolved ${assetPointer} \u2192 ${preview}`);
    }
    return finalUrl;
  };
}
class ChatGptWebExecutor extends BaseExecutor {
  constructor() {
    super("chatgpt-web", { id: "chatgpt-web", baseUrl: CONV_URL });
  }
  async execute({
    model,
    body,
    stream,
    credentials,
    signal,
    log,
    onCredentialsRefreshed,
    clientHeaders
  }) {
    const messages = body?.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return {
        response: errorResponse(400, "Missing or empty messages array"),
        url: CONV_URL,
        headers: {},
        transformedBody: body
      };
    }
    const { hasTools, requestedTools, effectiveMessages } = prepareToolMessages(
      body || {},
      messages
    );
    if (!credentials.apiKey) {
      return {
        response: errorResponse(
          401,
          "ChatGPT auth failed \u2014 paste your __Secure-next-auth.session-token cookie value."
        ),
        url: CONV_URL,
        headers: {},
        transformedBody: body
      };
    }
    const cookie = credentials.apiKey;
    let tokenEntry;
    try {
      tokenEntry = await exchangeSession(cookie, signal);
    } catch (err) {
      if (err instanceof SessionAuthError) {
        log?.warn?.("CGPT-WEB", err.message);
        return {
          response: errorResponse(
            401,
            "ChatGPT auth failed \u2014 re-paste your __Secure-next-auth.session-token cookie from chatgpt.com.",
            "HTTP_401"
          ),
          url: SESSION_URL,
          headers: {},
          transformedBody: body
        };
      }
      log?.error?.(
        "CGPT-WEB",
        `Session exchange failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return {
        response: errorResponse(
          502,
          `ChatGPT session exchange failed: ${err instanceof Error ? err.message : String(err)}`
        ),
        url: SESSION_URL,
        headers: {},
        transformedBody: body
      };
    }
    if (tokenEntry.refreshedCookie && tokenEntry.refreshedCookie !== cookie) {
      const updated = { ...credentials, apiKey: tokenEntry.refreshedCookie };
      try {
        await onCredentialsRefreshed?.(updated);
      } catch (err) {
        log?.warn?.(
          "CGPT-WEB",
          `Failed to persist refreshed cookie: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    let dplInfo;
    try {
      dplInfo = await fetchDpl(cookie, signal);
    } catch (err) {
      log?.warn?.(
        "CGPT-WEB",
        `DPL warmup failed (continuing with fallback): ${err instanceof Error ? err.message : String(err)}`
      );
      dplInfo = {
        dpl: `dpl=${OAI_CLIENT_VERSION.replace(/^prod-/, "")}`,
        scriptSrc: `${CHATGPT_BASE}/_next/static/chunks/webpack-${randomHex(16)}.js`
      };
    }
    const sessionId = randomUUID();
    const deviceId = deviceIdFor(cookie);
    await runSessionWarmup(
      tokenEntry.accessToken,
      tokenEntry.accountId,
      sessionId,
      deviceId,
      cookie,
      signal,
      log
    );
    const resolvedModel = resolveChatGptModel(model, body, credentials.providerSpecificData);
    const modelSlug = resolvedModel.slug;
    const requestedEffort = resolvedModel.effort;
    if (requestedEffort && isThinkingCapableModel(model, modelSlug)) {
      await setUserThinkingEffort(
        modelSlug,
        requestedEffort,
        tokenEntry.accessToken,
        tokenEntry.accountId,
        sessionId,
        deviceId,
        cookie,
        signal,
        log
      );
    }
    let reqs;
    try {
      reqs = await prepareChatRequirements(
        tokenEntry.accessToken,
        tokenEntry.accountId,
        sessionId,
        deviceId,
        cookie,
        dplInfo,
        signal,
        log
      );
    } catch (err) {
      if (err instanceof SentinelBlockedError) {
        log?.warn?.("CGPT-WEB", err.message);
        return {
          response: errorResponse(
            403,
            "ChatGPT blocked the request (Sentinel/Turnstile required). Try again later or open chatgpt.com in a browser to refresh state.",
            "SENTINEL_BLOCKED"
          ),
          url: SENTINEL_PREPARE_URL,
          headers: {},
          transformedBody: body
        };
      }
      log?.error?.(
        "CGPT-WEB",
        `Sentinel failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return {
        response: errorResponse(
          502,
          `ChatGPT sentinel failed: ${err instanceof Error ? err.message : String(err)}`
        ),
        url: SENTINEL_PREPARE_URL,
        headers: {},
        transformedBody: body
      };
    }
    log?.debug?.(
      "CGPT-WEB",
      `sentinel: token=${reqs.token ? "y" : "n"} pow=${reqs.proofofwork?.required ? "y" : "n"} turnstile=${reqs.turnstile?.required ? "y" : "n"}`
    );
    const turnstileToken = typeof credentials.providerSpecificData?.turnstileToken === "string" ? credentials.providerSpecificData.turnstileToken : null;
    let proofToken = null;
    if (reqs.proofofwork?.required && reqs.proofofwork.seed && reqs.proofofwork.difficulty) {
      const powConfig = buildPrekeyConfig(CHATGPT_USER_AGENT, dplInfo.dpl, dplInfo.scriptSrc);
      proofToken = await solveProofOfWork(
        reqs.proofofwork.seed,
        reqs.proofofwork.difficulty,
        powConfig,
        log
      );
    }
    const parsed = parseOpenAIMessages(effectiveMessages);
    if (!parsed.currentMsg.trim() && parsed.history.length === 0) {
      return {
        response: errorResponse(400, "Empty user message"),
        url: CONV_URL,
        headers: {},
        transformedBody: body
      };
    }
    const imageEdit = looksLikeImageEditRequest(parsed);
    const continuation = imageEdit ? parsed.latestImageContext : null;
    const forImageGen = looksLikeImageGenRequest(parsed) || imageEdit;
    const persistConversation = forImageGen || !!continuation;
    if (forImageGen) {
      log?.debug?.(
        "CGPT-WEB",
        continuation ? "Image edit intent detected \u2014 continuing saved image conversation" : "Image-gen intent detected \u2014 disabling Temporary Chat for this turn"
      );
    } else if (resolvedModel.isPro) {
      log?.debug?.("CGPT-WEB", "GPT-5.5 Pro text request \u2014 keeping Temporary Chat enabled");
    }
    const parentMessageId = continuation?.parentMessageId ?? randomUUID();
    const cgptBody = buildConversationBody(parsed, modelSlug, parentMessageId, {
      persistConversation,
      thinkingEffort: requestedEffort,
      continuation
    });
    const headers = {
      ...browserHeaders(),
      ...oaiHeaders(sessionId, deviceId),
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${tokenEntry.accessToken}`,
      Cookie: buildSessionCookieHeader(cookie)
    };
    if (tokenEntry.accountId) headers["chatgpt-account-id"] = tokenEntry.accountId;
    if (reqs.token) headers["openai-sentinel-chat-requirements-token"] = reqs.token;
    if (reqs.prepare_token)
      headers["openai-sentinel-chat-requirements-prepare-token"] = reqs.prepare_token;
    if (proofToken) headers["openai-sentinel-proof-token"] = proofToken;
    if (turnstileToken) headers["openai-sentinel-turnstile-token"] = turnstileToken;
    log?.info?.("CGPT-WEB", `Conversation request \u2192 ${modelSlug} (pow=${!!proofToken})`);
    let response;
    try {
      response = await tlsFetchChatGpt(CONV_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(cgptBody),
        timeoutMs: 12e4,
        // generations can take a while
        signal,
        // For real-time streaming, ask the TLS client to write the body to
        // a temp file and surface it as a ReadableStream as it arrives —
        // otherwise long generations buffer entirely before the client sees
        // anything (and the downstream HTTP request can time out).
        stream
      });
    } catch (err) {
      log?.error?.("CGPT-WEB", `Fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      const code = err instanceof TlsClientUnavailableError ? "TLS_UNAVAILABLE" : void 0;
      return {
        response: errorResponse(
          502,
          `ChatGPT connection failed: ${err instanceof Error ? err.message : String(err)}`,
          code
        ),
        url: CONV_URL,
        headers,
        transformedBody: cgptBody
      };
    }
    if (response.status >= 400) {
      const status = response.status;
      log?.warn?.("CGPT-WEB", `conv ${status}: ${(response.text || "").slice(0, 400)}`);
      const errMsg = describeChatGptWebHttpError(status);
      if (status === 401 || status === 403) {
        tokenCache.delete(cookieKey(cookie));
      }
      log?.warn?.("CGPT-WEB", errMsg);
      return {
        response: errorResponse(status, errMsg, `HTTP_${status}`),
        url: CONV_URL,
        headers,
        transformedBody: cgptBody
      };
    }
    let bodyStream;
    if (response.body) {
      bodyStream = response.body;
    } else if (response.text) {
      bodyStream = stringToStream(response.text);
    } else {
      return {
        response: errorResponse(502, "ChatGPT returned empty response body"),
        url: CONV_URL,
        headers,
        transformedBody: cgptBody
      };
    }
    const cid = `chatcmpl-cgpt-${crypto.randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1e3);
    const resolverCtx = {
      accessToken: tokenEntry.accessToken,
      accountId: tokenEntry.accountId,
      sessionId,
      deviceId,
      cookie,
      signal,
      log,
      publicBaseUrl: derivePublicBaseUrl(clientHeaders, log)
    };
    const imageResolver = makeImageResolver(resolverCtx);
    const pollAsyncImage = (conversationId) => pollForAsyncImage(conversationId, resolverCtx);
    const pollFinalAnswer = resolvedModel.isPro ? (conversationId) => pollForFinalAssistantAnswer(conversationId, resolverCtx) : null;
    const toolMode = hasTools && !forImageGen;
    let finalResponse;
    if (stream && !toolMode) {
      const sseStream = buildStreamingResponse(
        bodyStream,
        model,
        cid,
        created,
        imageResolver,
        pollAsyncImage,
        pollFinalAnswer,
        log,
        signal
      );
      finalResponse = new Response(sseStream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no"
        }
      });
    } else {
      finalResponse = await buildNonStreamingResponse(
        bodyStream,
        model,
        cid,
        created,
        parsed.currentMsg,
        imageResolver,
        pollAsyncImage,
        pollFinalAnswer,
        log,
        signal
      );
      if (toolMode) {
        finalResponse = await buildToolModeResponse(finalResponse, requestedTools, stream, {
          cid,
          created,
          model
        });
      }
    }
    return { response: finalResponse, url: CONV_URL, headers, transformedBody: cgptBody };
  }
}
const ENTITY_RE = /entity\["[^"]*","([^"]*)"[^\]]*\]/g;
function cleanChatGptText(text) {
  return text.replace(ENTITY_RE, "$1");
}
function stringToStream(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    }
  });
}
function __resetChatGptWebCachesForTesting() {
  tokenCache.clear();
  warmupCache.clear();
  thinkingEffortCache.clear();
  deviceIdCache.clear();
  __resetChatGptImageCacheForTesting();
  dplCache = null;
}
const __derivePublicBaseUrlForTesting = derivePublicBaseUrl;
export {
  ChatGptWebExecutor,
  __derivePublicBaseUrlForTesting,
  __resetChatGptWebCachesForTesting,
  detectImageResolutionFailure
};
