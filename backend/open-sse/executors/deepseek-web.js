import { BaseExecutor } from "./base.ts";
import { solveDeepSeekPowAsync } from "../lib/deepseek-pow.ts";
import {
  serializeDeepSeekToolPrompt,
  parseDeepSeekToolCalls,
  buildToolConversationPrompt
} from "../translator/deepseekWebTools.ts";
import { sanitizeErrorMessage } from "../utils/error.js";
import {
  isThinkingModel,
  isSearchModel,
  formatStreamContent,
  appendSearchCitations
} from "./deepseek-web/stream-format.ts";
const DEEPSEEK_WEB_BASE = "https://chat.deepseek.com";
const DEEPSEEK_API_BASE = `${DEEPSEEK_WEB_BASE}/api`;
const COMPLETION_URL = `${DEEPSEEK_API_BASE}/v0/chat/completion`;
const FAKE_HEADERS = {
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: DEEPSEEK_WEB_BASE,
  Referer: `${DEEPSEEK_WEB_BASE}/`,
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  "X-Client-Bundle-Id": "com.deepseek.chat",
  "X-Client-Locale": "en-US",
  "X-Client-Platform": "web",
  "X-Client-Version": "2.0.0"
};
const tokenCache = /* @__PURE__ */ new Map();
const sessionCache = /* @__PURE__ */ new Map();
const CACHE_MAX_SIZE = 100;
function evictOldest(cache) {
  if (cache.size >= CACHE_MAX_SIZE) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
}
function extractUserToken(credentials) {
  const raw = credentials?.apiKey || credentials?.accessToken;
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.value === "string") return parsed.value;
  } catch {
  }
  return raw;
}
function errorResponse(status, message, dsCode) {
  return new Response(
    JSON.stringify({
      error: { message, type: "upstream_error", code: dsCode ?? `HTTP_${status}` }
    }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}
function resolveModelOptions(model, bodyObj) {
  const m = (model || "").toLowerCase();
  const modelType = m.includes("pro") || m.includes("expert") ? "expert" : "default";
  const thinkingEnabled = m.includes("r1") || m.includes("think") || m.includes("reason") || bodyObj?.thinking_enabled === true || bodyObj?.thinking === true || !!bodyObj?.reasoning_effort;
  const searchEnabled = m.includes("search") || bodyObj?.search_enabled === true || bodyObj?.search === true || bodyObj?.web_search === true;
  return { modelType, thinkingEnabled, searchEnabled };
}
function generateFakeCookie() {
  const ts = Date.now();
  const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const uid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : r & 3 | 8).toString(16);
  });
  return `intercom-HWWAFSESTIME=${ts}; HWWAFSESID=${hex(18)}; Hm_lvt_${uid()}=${Math.floor(ts / 1e3)}; _frid=${uid()}`;
}
async function solvePow(challenge) {
  const answer = await solveDeepSeekPowAsync(
    challenge.algorithm,
    challenge.challenge,
    challenge.salt,
    challenge.difficulty,
    challenge.expire_at
  );
  if (answer < 0) throw new Error("PoW solver failed");
  return Buffer.from(
    JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: challenge.target_path
    })
  ).toString("base64");
}
function transformSSE(deepseekStream, model) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const streamModel = model || "deepseek-web";
  const id = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1e3);
  let emittedRole = false;
  let currentPath = "";
  const thinkingModel = isThinkingModel(streamModel);
  const searchResults = [];
  return new ReadableStream(
    {
      async start(controller) {
        const reader = deepseekStream.getReader();
        let buffer = "";
        const emit = (obj) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}

`));
        };
        const chunk = (delta, finish) => {
          emit({
            id,
            object: "chat.completion.chunk",
            created,
            model: streamModel,
            choices: [{ index: 0, delta, finish_reason: finish ?? null }]
          });
        };
        const ensureRole = () => {
          if (!emittedRole) {
            emittedRole = true;
            chunk({ role: "assistant", content: "" });
          }
        };
        const finishStream = () => {
          const citations = appendSearchCitations(searchResults, streamModel);
          if (citations) {
            ensureRole();
            chunk({ content: `

${citations}` });
          }
          ensureRole();
          chunk({}, "stop");
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        };
        const sendByPath = (raw) => {
          const text = formatStreamContent(raw, streamModel);
          if (!text) return;
          ensureRole();
          let path = currentPath;
          if (!path && thinkingModel) path = "thinking";
          else if (!path && isSearchModel(streamModel)) path = "content";
          if (path === "thinking") {
            chunk({ reasoning_content: text });
          } else {
            chunk({ content: text });
          }
        };
        const applyFragmentType = (frag) => {
          const type = String(frag?.type || "").toUpperCase();
          if (type === "THINK") currentPath = "thinking";
          else if (type === "ANSWER" || type === "RESPONSE") currentPath = "content";
        };
        const handleFragment = (frag, setPathFromType = false) => {
          if (setPathFromType) applyFragmentType(frag);
          if (typeof frag?.content !== "string" || frag.content.length === 0) return;
          if (!setPathFromType) {
            const type = String(frag?.type || "").toUpperCase();
            if (type === "THINK") currentPath = "thinking";
            else if (type === "ANSWER" || type === "RESPONSE") currentPath = "content";
          }
          sendByPath(frag.content);
        };
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (!line.startsWith("data: ") && !line.startsWith("data:")) continue;
              const payload = line.replace(/^data:\s*/, "").trim();
              if (payload === "[DONE]") {
                finishStream();
                return;
              }
              let data;
              try {
                data = JSON.parse(payload);
              } catch {
                continue;
              }
              const p = data?.p;
              const o = data?.o;
              const v = data?.v;
              if (v && typeof v === "object" && v.response) {
                if (v.response.thinking_enabled === true) currentPath = "thinking";
                else if (v.response.thinking_enabled === false) currentPath = "content";
                const fragments = v.response.fragments;
                if (Array.isArray(fragments)) {
                  for (const frag of fragments) handleFragment(frag, false);
                }
              }
              if (p === "response/fragments") {
                if (Array.isArray(v)) {
                  for (const frag of v) handleFragment(frag, true);
                } else if (v && typeof v === "object") {
                  handleFragment(v, true);
                }
              }
              if (p === "response" && Array.isArray(v)) {
                for (const entry of v) {
                  if (entry?.p === "response" && entry?.v?.thinking_enabled === true) {
                    currentPath = "thinking";
                  }
                }
              }
              if (p === "response/search_status") continue;
              if (p === "response/search_results" && Array.isArray(v)) {
                if (o !== "BATCH") {
                  searchResults.length = 0;
                  searchResults.push(...v);
                } else {
                  for (const op of v) {
                    const match = String(op?.p || "").match(/^(\d+)\/cite_index$/);
                    if (match) {
                      const index = parseInt(match[1], 10);
                      if (searchResults[index]) searchResults[index].cite_index = op.v;
                    }
                  }
                }
                continue;
              }
              if (typeof v === "string") {
                sendByPath(v);
              } else if (Array.isArray(v) && p === "response") {
                for (const entry of v) {
                  if (Array.isArray(entry?.v)) {
                    const joined = entry.v.map((item) => item?.content || "").join("");
                    if (joined) sendByPath(joined);
                  }
                }
              }
              if (p === "response/status" && v === "FINISHED") {
                continue;
              }
            }
          }
        } catch (err) {
          controller.error(err);
          return;
        }
        finishStream();
      }
    },
    { highWaterMark: 16384 }
  );
}
async function collectSSEContent(deepseekStream, model) {
  const decoder = new TextDecoder();
  const reader = deepseekStream.getReader();
  let buffer = "";
  let content = "";
  let reasoningContent = "";
  let currentPath = "";
  const streamModel = model || "deepseek-web";
  const thinkingModel = isThinkingModel(streamModel);
  const searchResults = [];
  const appendByPath = (raw) => {
    const text = formatStreamContent(raw, streamModel);
    if (!text) return;
    let path = currentPath;
    if (!path && thinkingModel) path = "thinking";
    else if (!path && isSearchModel(streamModel)) path = "content";
    if (path === "thinking") reasoningContent += text;
    else content += text;
  };
  const applyFragmentType = (frag) => {
    const type = String(frag?.type || "").toUpperCase();
    if (type === "THINK") currentPath = "thinking";
    else if (type === "ANSWER" || type === "RESPONSE") currentPath = "content";
  };
  const handleFragment = (frag, setPathFromType = false) => {
    if (setPathFromType) applyFragmentType(frag);
    if (typeof frag?.content !== "string" || frag.content.length === 0) return;
    if (!setPathFromType) {
      const type = String(frag?.type || "").toUpperCase();
      if (type === "THINK") currentPath = "thinking";
      else if (type === "ANSWER" || type === "RESPONSE") currentPath = "content";
    }
    appendByPath(frag.content);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ") && !line.startsWith("data:")) continue;
      const payload = line.replace(/^data:\s*/, "").trim();
      try {
        const data = JSON.parse(payload);
        const p = data?.p;
        const v = data?.v;
        if (v && typeof v === "object" && v.response) {
          if (v.response.thinking_enabled === true) currentPath = "thinking";
          else if (v.response.thinking_enabled === false) currentPath = "content";
          if (Array.isArray(v.response.fragments)) {
            for (const frag of v.response.fragments) handleFragment(frag, false);
          }
        }
        if (p === "response/fragments") {
          if (Array.isArray(v)) {
            for (const frag of v) handleFragment(frag, true);
          } else if (v && typeof v === "object") {
            handleFragment(v, true);
          }
        }
        if (p === "response" && Array.isArray(v)) {
          for (const entry of v) {
            if (entry?.p === "response" && entry?.v?.thinking_enabled === true) {
              currentPath = "thinking";
            }
          }
        }
        if (p === "response/search_status") continue;
        if (p === "response/search_results" && Array.isArray(v)) {
          if (data?.o !== "BATCH") {
            searchResults.length = 0;
            searchResults.push(...v);
          } else {
            for (const op of v) {
              const match = String(op?.p || "").match(/^(\d+)\/cite_index$/);
              if (match) {
                const index = parseInt(match[1], 10);
                if (searchResults[index]) searchResults[index].cite_index = op.v;
              }
            }
          }
          continue;
        }
        if (typeof v === "string") {
          appendByPath(v);
        } else if (Array.isArray(v) && p === "response") {
          for (const entry of v) {
            if (Array.isArray(entry?.v)) {
              const joined = entry.v.map((item) => item?.content || "").join("");
              if (joined) appendByPath(joined);
            }
          }
        }
      } catch {
      }
    }
  }
  const citations = appendSearchCitations(searchResults, streamModel);
  if (citations) content += `

${citations}`;
  return { content, reasoningContent };
}
function extractMessageText(content) {
  if (Array.isArray(content)) {
    return content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
  }
  return String(content || "");
}
function messagesToPrompt(messages, historyWindow = 0) {
  if (messages.length === 0) return "";
  const systemParts = [];
  const conversation = [];
  const callNameById = /* @__PURE__ */ new Map();
  let lastUserContent = "";
  for (const m of messages) {
    const text = extractMessageText(m.content).trim();
    if (m.role === "system") {
      if (text) systemParts.push(text);
    } else if (m.role === "user" || m.role === "assistant") {
      if (text) conversation.push({ role: m.role, text });
      if (m.role === "user") lastUserContent = text;
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      for (const c of calls) {
        if (c?.id && typeof c.function?.name === "string") callNameById.set(c.id, c.function.name);
      }
    } else if (m.role === "tool") {
      if (text) {
        const name = m.tool_call_id && callNameById.get(m.tool_call_id) || m.name || "tool";
        conversation.push({ role: "tool", text: `(${name}) ${text}` });
      }
    }
  }
  const parts = [];
  if (systemParts.length > 0) {
    parts.push(systemParts.join("\n\n"));
  }
  if (historyWindow > 0 && conversation.length > 1) {
    const recent = conversation.slice(-historyWindow);
    const transcript = recent.map(
      (turn) => turn.role === "assistant" ? `Assistant: ${turn.text}` : turn.role === "tool" ? `Tool result ${turn.text}` : `User: ${turn.text}`
    ).join("\n\n");
    parts.push(transcript);
  } else if (lastUserContent) {
    parts.push(lastUserContent);
  }
  return parts.join("\n\n").replace(/!\[.*?\]\(.*?\)/g, "");
}
async function acquireAccessToken(userToken, signal, log) {
  const cached = tokenCache.get(userToken);
  if (cached && cached.expiresAt > Math.floor(Date.now() / 1e3)) {
    return cached.accessToken;
  }
  log?.info?.("DEEPSEEK-WEB", "Acquiring access token from /users/current...");
  const resp = await fetch(`${DEEPSEEK_API_BASE}/v0/users/current`, {
    headers: {
      Authorization: `Bearer ${userToken}`,
      ...FAKE_HEADERS
    },
    signal: signal ?? void 0
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new Error("Token invalid or expired \u2014 get a new userToken from DeepSeek localStorage");
  }
  if (!resp.ok) {
    throw new Error(`users/current HTTP ${resp.status}`);
  }
  const json = await resp.json();
  if (json?.code && json.code !== 0) {
    const errMsg = json.msg || json?.data?.biz_msg || `error code ${json.code}`;
    tokenCache.delete(userToken);
    throw new Error(`DeepSeek rejected token: ${errMsg}`);
  }
  const bizData = json?.data?.biz_data || json?.biz_data;
  if (!bizData?.token) {
    const errMsg = json?.msg || json?.data?.biz_msg || "Unknown error";
    throw new Error(`Failed to acquire token: ${errMsg}`);
  }
  const accessToken = bizData.token;
  evictOldest(tokenCache);
  tokenCache.set(userToken, {
    accessToken,
    expiresAt: Math.floor(Date.now() / 1e3) + 3600
  });
  log?.info?.("DEEPSEEK-WEB", `Access token acquired (${accessToken.length} chars)`);
  return accessToken;
}
function parseDeepSeekErrorPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const record = payload;
  const codeRaw = record.code;
  const code = typeof codeRaw === "number" ? codeRaw : void 0;
  const msg = record.msg;
  const data = record.data;
  const bizMsg = data?.biz_msg;
  const messageRaw = typeof msg === "string" ? msg : typeof bizMsg === "string" ? bizMsg : "";
  if (code !== void 0 && code !== 0) {
    return { code, message: messageRaw || `DeepSeek error ${code}` };
  }
  return null;
}
async function createSession(accessToken, signal) {
  const resp = await fetch(`${DEEPSEEK_API_BASE}/v0/chat_session/create`, {
    method: "POST",
    headers: {
      ...FAKE_HEADERS,
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      Cookie: generateFakeCookie()
    },
    body: JSON.stringify({}),
    signal: signal ?? void 0
  });
  if (!resp.ok) throw new Error(`chat_session/create HTTP ${resp.status}`);
  const json = await resp.json();
  const bizData = json?.data?.biz_data || json?.biz_data;
  const id = bizData?.chat_session?.id;
  if (!id) throw new Error(`No session id: code=${json?.code}`);
  return id;
}
async function deleteSessionOnDeepSeek(accessToken, sessionId) {
  try {
    await fetch(`${DEEPSEEK_API_BASE}/v0/chat_session/delete`, {
      method: "POST",
      headers: {
        ...FAKE_HEADERS,
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({ chat_session_id: sessionId })
    });
  } catch {
  }
}
function wrapStreamWithCleanup(responseStream, cleanup) {
  const reader = responseStream.getReader();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        cleanup().catch(() => {
        });
        return;
      }
      controller.enqueue(value);
    },
    cancel() {
      reader.cancel();
      cleanup().catch(() => {
      });
    }
  });
}
async function getPowChallenge(accessToken, signal) {
  const resp = await fetch(`${DEEPSEEK_API_BASE}/v0/chat/create_pow_challenge`, {
    method: "POST",
    headers: {
      ...FAKE_HEADERS,
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
    signal: signal ?? void 0
  });
  if (!resp.ok) throw new Error(`create_pow_challenge HTTP ${resp.status}`);
  const json = await resp.json();
  const bizData = json?.data?.biz_data || json?.biz_data;
  if (!bizData?.challenge?.challenge) throw new Error(`No PoW challenge: code=${json?.code}`);
  return bizData.challenge;
}
function buildToolAwareResult(opts) {
  const { stream, clientModel, content, reasoningContent, toolCalls, reqHeaders, requestPayload } = opts;
  const hasCalls = !!toolCalls && toolCalls.length > 0;
  const finishReason = hasCalls ? "tool_calls" : "stop";
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1e3);
  if (stream) {
    const encoder = new TextEncoder();
    const emit = (controller, delta, finish) => {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: clientModel,
            choices: [{ index: 0, delta, finish_reason: finish }]
          })}

`
        )
      );
    };
    const sse = new ReadableStream({
      start(controller) {
        emit(controller, { role: "assistant", content: "" }, null);
        if (reasoningContent) emit(controller, { reasoning_content: reasoningContent }, null);
        if (content) emit(controller, { content }, null);
        if (hasCalls) {
          emit(
            controller,
            {
              tool_calls: toolCalls.map((tc, i) => ({
                index: i,
                id: tc.id,
                type: "function",
                function: { name: tc.function.name, arguments: tc.function.arguments }
              }))
            },
            null
          );
        }
        emit(controller, {}, finishReason);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    return {
      response: new Response(sse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }
      }),
      url: COMPLETION_URL,
      headers: reqHeaders,
      transformedBody: requestPayload
    };
  }
  const message = { role: "assistant", content: content || "" };
  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (hasCalls) {
    message.tool_calls = toolCalls;
    if (!content) message.content = null;
  }
  const openaiResponse = {
    id,
    object: "chat.completion",
    created,
    model: clientModel,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
  return {
    response: new Response(JSON.stringify(openaiResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }),
    url: COMPLETION_URL,
    headers: reqHeaders,
    transformedBody: requestPayload
  };
}
class DeepSeekWebExecutor extends BaseExecutor {
  constructor() {
    super("deepseek-web", { baseUrl: DEEPSEEK_WEB_BASE });
  }
  async testConnection(credentials, signal) {
    try {
      const userToken = extractUserToken(credentials);
      if (!userToken) return false;
      const accessToken = await acquireAccessToken(userToken, signal);
      return !!accessToken;
    } catch {
      return false;
    }
  }
  async execute({ model, body, stream, credentials, signal, log }) {
    const bodyObj = body || {};
    const requestedTools = bodyObj.tools;
    const hasTools = Array.isArray(requestedTools) && requestedTools.length > 0;
    const toolSystemPrompt = hasTools ? serializeDeepSeekToolPrompt(requestedTools) : "";
    const messages = Array.isArray(bodyObj.messages) ? bodyObj.messages : [];
    const promptMessages = toolSystemPrompt ? [{ role: "system", content: toolSystemPrompt }, ...messages] : messages;
    const rawCreds = credentials;
    const userToken = extractUserToken(rawCreds);
    if (!userToken) {
      return {
        response: errorResponse(
          400,
          "Invalid credentials: paste your userToken from DeepSeek localStorage (DevTools \u2192 Application \u2192 Local Storage \u2192 chat.deepseek.com \u2192 userToken)"
        ),
        url: COMPLETION_URL,
        headers: {},
        transformedBody: body
      };
    }
    const { modelType, thinkingEnabled, searchEnabled } = resolveModelOptions(
      model,
      bodyObj
    );
    const psd = rawCreds.providerSpecificData ?? {};
    const persistSession = psd.persistSession === true;
    const historyWindow = typeof psd.historyWindow === "number" && psd.historyWindow > 0 ? psd.historyWindow : 0;
    try {
      let t0 = Date.now();
      const accessToken = await acquireAccessToken(userToken, signal, log);
      log?.info?.("DEEPSEEK-WEB", `Token acquired in ${Date.now() - t0}ms`);
      const prompt = hasTools ? buildToolConversationPrompt(messages, toolSystemPrompt) : messagesToPrompt(promptMessages, historyWindow);
      const refFileIds = Array.isArray(bodyObj.ref_file_ids) ? bodyObj.ref_file_ids : [];
      log?.info?.(
        "DEEPSEEK-WEB",
        `model_type=${modelType}, thinking=${thinkingEnabled}, search=${searchEnabled}, files=${refFileIds.length}, stream=${stream !== false}, persist=${persistSession}, window=${historyWindow}`
      );
      const performCompletion = async (sid) => {
        const powChallenge = await getPowChallenge(accessToken, signal);
        const powAnswer = await solvePow(powChallenge);
        const reqHeaders2 = {
          ...FAKE_HEADERS,
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          "X-Ds-Pow-Response": powAnswer,
          "X-Client-Timezone-Offset": String((/* @__PURE__ */ new Date()).getTimezoneOffset() * -60),
          Cookie: generateFakeCookie()
        };
        const requestPayload2 = {
          chat_session_id: sid,
          parent_message_id: null,
          model_type: modelType,
          prompt,
          ref_file_ids: refFileIds,
          thinking_enabled: thinkingEnabled,
          search_enabled: searchEnabled,
          preempt: false
        };
        const resp2 = await fetch(COMPLETION_URL, {
          method: "POST",
          headers: reqHeaders2,
          body: JSON.stringify(requestPayload2),
          signal: signal ?? void 0
        });
        return { resp: resp2, reqHeaders: reqHeaders2, requestPayload: requestPayload2 };
      };
      const acquireSession = async () => {
        if (persistSession) {
          const cached = sessionCache.get(userToken);
          if (cached) return { sessionId: cached.sessionId, reused: true };
          const created = await createSession(accessToken, signal);
          evictOldest(sessionCache);
          sessionCache.set(userToken, { sessionId: created, createdAt: Date.now() });
          return { sessionId: created, reused: false };
        }
        return { sessionId: await createSession(accessToken, signal), reused: false };
      };
      t0 = Date.now();
      let { sessionId, reused: reusedSession } = await acquireSession();
      log?.info?.(
        "DEEPSEEK-WEB",
        `Session ${reusedSession ? "reused" : "created"} in ${Date.now() - t0}ms`
      );
      t0 = Date.now();
      log?.info?.("DEEPSEEK-WEB", `POST ${COMPLETION_URL}`);
      let { resp, reqHeaders, requestPayload } = await performCompletion(sessionId);
      log?.info?.(
        "DEEPSEEK-WEB",
        `Completion response in ${Date.now() - t0}ms, status=${resp.status}`
      );
      if (!resp.ok && persistSession && reusedSession) {
        log?.warn?.("DEEPSEEK-WEB", "Reused session failed \u2014 retrying with a fresh session");
        sessionCache.delete(userToken);
        sessionId = await createSession(accessToken, signal);
        evictOldest(sessionCache);
        sessionCache.set(userToken, { sessionId, createdAt: Date.now() });
        reusedSession = false;
        ({ resp, reqHeaders, requestPayload } = await performCompletion(sessionId));
      }
      if (!resp.ok) {
        const status = resp.status;
        let errMsg = `DeepSeek API error (${status})`;
        if (status === 401 || status === 403) {
          tokenCache.delete(userToken);
          errMsg = "DeepSeek token expired \u2014 get a fresh userToken from localStorage.";
        } else if (status === 429) {
          errMsg = "DeepSeek rate limited. Wait and retry.";
        }
        log?.warn?.("DEEPSEEK-WEB", errMsg);
        try {
          const errBody = await resp.json();
          if (errBody?.code && errBody.code !== 0) {
            errMsg = `DeepSeek error ${errBody.code}: ${errBody.msg}`;
          }
        } catch {
        }
        if (persistSession) sessionCache.delete(userToken);
        deleteSessionOnDeepSeek(accessToken, sessionId).catch(() => {
        });
        return {
          response: errorResponse(status, errMsg),
          url: COMPLETION_URL,
          headers: reqHeaders,
          transformedBody: requestPayload
        };
      }
      const ct = resp.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        try {
          const json = await resp.json();
          const parsed = parseDeepSeekErrorPayload(json);
          if (parsed) {
            const errMsg = `DeepSeek error ${parsed.code}: ${parsed.message}`;
            log?.warn?.("DEEPSEEK-WEB", errMsg);
            const status = parsed.code === 40003 ? 401 : parsed.code === 40002 ? 429 : 502;
            if (parsed.code === 40003) {
              tokenCache.delete(userToken);
            }
            if (persistSession) sessionCache.delete(userToken);
            deleteSessionOnDeepSeek(accessToken, sessionId).catch(() => {
            });
            return {
              response: errorResponse(status, errMsg, parsed.code),
              url: COMPLETION_URL,
              headers: reqHeaders,
              transformedBody: requestPayload
            };
          }
          if (!persistSession) deleteSessionOnDeepSeek(accessToken, sessionId).catch(() => {
          });
          return {
            response: new Response(JSON.stringify(json), {
              status: 200,
              headers: { "Content-Type": "application/json" }
            }),
            url: COMPLETION_URL,
            headers: reqHeaders,
            transformedBody: requestPayload
          };
        } catch {
        }
      }
      const cleanupFn = persistSession ? async () => {
      } : () => deleteSessionOnDeepSeek(accessToken, sessionId);
      const clientModel = typeof model === "string" && model.trim() ? model.trim() : "deepseek-web";
      if (hasTools) {
        const { content: content2, reasoningContent: reasoningContent2 } = await collectSSEContent(resp.body, clientModel);
        await cleanupFn();
        const { content: cleanedContent, toolCalls } = parseDeepSeekToolCalls(
          content2,
          `call-${Date.now()}`,
          requestedTools
        );
        return buildToolAwareResult({
          stream: stream !== false,
          clientModel,
          content: cleanedContent,
          reasoningContent: reasoningContent2,
          toolCalls,
          reqHeaders,
          requestPayload
        });
      }
      if (stream !== false) {
        const openaiStream = transformSSE(resp.body, clientModel);
        const wrappedStream = wrapStreamWithCleanup(openaiStream, cleanupFn);
        return {
          response: new Response(wrappedStream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }
          }),
          url: COMPLETION_URL,
          headers: reqHeaders,
          transformedBody: requestPayload
        };
      }
      const { content, reasoningContent } = await collectSSEContent(resp.body, clientModel);
      await cleanupFn();
      const message = { role: "assistant", content };
      if (reasoningContent) message.reasoning_content = reasoningContent;
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1e3),
        model: model || modelType,
        choices: [
          {
            index: 0,
            message,
            finish_reason: "stop"
          }
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };
      return {
        response: new Response(JSON.stringify(openaiResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }),
        url: COMPLETION_URL,
        headers: reqHeaders,
        transformedBody: requestPayload
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.error?.("DEEPSEEK-WEB", `Execute failed: ${msg}`);
      if (err instanceof DOMException && err.name === "AbortError") {
        return {
          response: errorResponse(499, "Request cancelled"),
          url: COMPLETION_URL,
          headers: {},
          transformedBody: body
        };
      }
      return {
        response: errorResponse(502, `DeepSeek error: ${sanitizeErrorMessage(msg)}`),
        url: COMPLETION_URL,
        headers: {},
        transformedBody: body
      };
    }
  }
}
const deepseekWebExecutor = new DeepSeekWebExecutor();
export {
  DEEPSEEK_WEB_BASE,
  DeepSeekWebExecutor,
  acquireAccessToken,
  deepseekWebExecutor,
  extractUserToken,
  messagesToPrompt,
  sessionCache,
  tokenCache
};
