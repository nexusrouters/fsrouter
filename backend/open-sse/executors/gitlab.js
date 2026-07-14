import { randomUUID } from "node:crypto";
import {
  BaseExecutor,
  mergeAbortSignals,
  mergeUpstreamExtraHeaders
} from "./base.ts";
import { FETCH_TIMEOUT_MS } from "../config/constants.ts";
import { getAccessToken } from "../services/tokenRefresh.ts";
import { prepareToolMessages, buildToolAwareResult } from "../translator/webTools.ts";
import {
  buildStreamingResponse,
  buildJsonCompletion,
  buildToolJsonCompletion,
  buildToolStreamingResponse
} from "./gitlabResponses.ts";
import {
  buildGitLabDirectGatewayUrl,
  buildGitLabOAuthEndpoints,
  getCachedGitLabDirectAccess,
  isGitLabDirectAccessDisabled,
  parseGitLabDirectAccessDetails,
  resolveGitLabOAuthBaseUrl
} from "@/lib/oauth/gitlab";
const MAX_TOOL_EXCHANGE_CHARS = 24e3;
const MAX_TOOL_RESULT_CHARS = 8e3;
const MAX_USER_INSTRUCTION_CHARS = 4e3;
function capText(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}
\u2026[truncated ${text.length - max} chars]`;
}
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function extractTextContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const item = part;
    if (item.type === "text" && typeof item.text === "string") {
      return item.text;
    }
    if (item.type === "input_text" && typeof item.text === "string") {
      return item.text;
    }
    return "";
  }).filter((text) => text.trim().length > 0).join("\n").trim();
}
function hasToolExchange(messages) {
  return messages.some((message) => {
    const role = String(message?.role || "user").toLowerCase();
    if (role === "tool") return true;
    return role === "assistant" && Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
  });
}
function buildSimplePrompt(messages) {
  const systemParts = [];
  const userParts = [];
  for (const message of messages) {
    const role = String(message?.role || "user").toLowerCase();
    const text = extractTextContent(message?.content);
    if (!text) continue;
    if (role === "system" || role === "developer") {
      systemParts.push(text);
    } else if (role === "user") {
      userParts.push(text);
    }
  }
  const latestUserPrompt = userParts.at(-1) || "";
  if (!systemParts.length) return latestUserPrompt;
  return `System instructions:
${systemParts.join("\n\n")}

${latestUserPrompt}`.trim();
}
function renderAssistantTurn(message, text) {
  const lines = [];
  if (text) lines.push(text);
  for (const tc of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
    const id = tc?.id ? ` [${tc.id}]` : "";
    lines.push(
      `Called tool ${tc?.function?.name || "tool"}${id} with arguments: ${tc?.function?.arguments ?? ""}`
    );
  }
  return lines.length ? `Assistant: ${lines.join("\n")}` : null;
}
function renderConversationTurn(message, role, text) {
  if (role === "user") return text ? `User: ${text}` : null;
  if (role === "assistant") return renderAssistantTurn(message, text);
  if (role === "tool") {
    const id = message?.tool_call_id ? ` for ${message.tool_call_id}` : "";
    const name = message?.name ? ` (${message.name})` : "";
    return `Tool result${name}${id}: ${text}`;
  }
  return null;
}
function selectBoundedMessages(messages) {
  let lastUserIdx = -1;
  let lastToolRoundIdx = -1;
  messages.forEach((message, idx) => {
    const role = String(message?.role || "user").toLowerCase();
    if (role === "user") lastUserIdx = idx;
    if (role === "assistant" && Array.isArray(message?.tool_calls) && message.tool_calls.length) {
      lastToolRoundIdx = idx;
    }
  });
  const tailStart = lastToolRoundIdx >= 0 ? lastToolRoundIdx : lastUserIdx;
  const kept = [];
  messages.forEach((message, idx) => {
    const role = String(message?.role || "user").toLowerCase();
    if (role === "system" || role === "developer") {
      kept.push(message);
    } else if (idx === lastUserIdx || idx >= tailStart) {
      kept.push(message);
    }
  });
  return kept;
}
function buildToolExchangePrompt(messages) {
  const systemParts = [];
  const convo = [];
  for (const message of selectBoundedMessages(messages)) {
    const role = String(message?.role || "user").toLowerCase();
    let text = extractTextContent(message?.content);
    if (role === "system" || role === "developer") {
      if (text) systemParts.push(text);
      continue;
    }
    if (role === "tool") text = capText(text, MAX_TOOL_RESULT_CHARS);
    const line = renderConversationTurn(message, role, text);
    if (line) convo.push(line);
  }
  const header = systemParts.length ? `System instructions:
${systemParts.join("\n\n")}

` : "";
  const body = `${header}${convo.join(
    "\n\n"
  )}

Continue the response using the tool result above; do not repeat the tool call.`.trim();
  return capText(body, MAX_TOOL_EXCHANGE_CHARS);
}
function buildLatestUserInstruction(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = String(messages[i]?.role || "user").toLowerCase();
    if (role === "user") {
      const text = extractTextContent(messages[i]?.content);
      if (text) return capText(text, MAX_USER_INSTRUCTION_CHARS);
    }
  }
  return "";
}
function buildPrompt(messages) {
  if (!Array.isArray(messages)) return "";
  return hasToolExchange(messages) ? buildToolExchangePrompt(messages) : buildSimplePrompt(messages);
}
function toOpenAIError(status, message) {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: status === 401 || status === 403 ? "authentication_error" : status === 429 ? "rate_limit_error" : "api_error"
      }
    }),
    {
      status,
      headers: { "Content-Type": "application/json" }
    }
  );
}
function mergeCredentials(current, patch) {
  if (!patch) return current;
  return {
    ...current,
    ...patch,
    providerSpecificData: {
      ...current.providerSpecificData || {},
      ...patch.providerSpecificData || {}
    }
  };
}
function resolveGitLabRoot(credentials) {
  return resolveGitLabOAuthBaseUrl(credentials?.providerSpecificData);
}
function resolveResponseModel(payload, fallbackModel) {
  const modelField = payload.model;
  if (typeof modelField === "string" && modelField.trim().length > 0) {
    return modelField.trim();
  }
  const modelRecord = asRecord(modelField);
  const modelName = typeof modelRecord.name === "string" && modelRecord.name.trim().length > 0 ? modelRecord.name.trim() : typeof modelRecord.id === "string" && modelRecord.id.trim().length > 0 ? modelRecord.id.trim() : null;
  if (modelName) {
    return modelName;
  }
  const metadata = asRecord(payload.metadata);
  const metadataModelDetails = asRecord(metadata.model_details);
  const payloadModelDetails = asRecord(payload.model_details);
  const nestedCandidates = [metadataModelDetails, payloadModelDetails];
  for (const candidate of nestedCandidates) {
    const value = typeof candidate.model_name === "string" && candidate.model_name.trim().length > 0 ? candidate.model_name.trim() : typeof candidate.name === "string" && candidate.name.trim().length > 0 ? candidate.name.trim() : null;
    if (value) {
      return value;
    }
  }
  return fallbackModel;
}
function buildMonolithHeaders(token) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...token ? { Authorization: `Bearer ${token}` } : {}
  };
}
function buildDirectHeaders(directAccess) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${directAccess.token}`,
    ...directAccess.headers
  };
}
function isGitLabDuoOAuthProvider(providerId) {
  return providerId === "gitlab-duo";
}
async function persistGitLabDirectAccessCache(input, credentials, root, directAccess) {
  if (!input.onCredentialsRefreshed) return;
  await input.onCredentialsRefreshed({
    providerSpecificData: {
      ...credentials.providerSpecificData || {},
      baseUrl: root,
      gitlabDirectAccess: {
        token: directAccess.token,
        baseUrl: directAccess.baseUrl,
        expiresAt: directAccess.expiresAt,
        headers: directAccess.headers
      }
    }
  });
}
class GitlabExecutor extends BaseExecutor {
  constructor(providerId = "gitlab") {
    super(providerId, {
      id: providerId,
      baseUrl: "https://gitlab.com/api/v4/code_suggestions/completions",
      headers: { "Content-Type": "application/json" }
    });
  }
  buildUrl(_model, _stream, _urlIndex = 0, credentials = null) {
    const endpoints = buildGitLabOAuthEndpoints(resolveGitLabRoot(credentials || {}));
    return endpoints.publicCompletionsUrl;
  }
  buildHeaders(credentials, _stream = false) {
    const token = credentials?.apiKey || credentials?.accessToken || null;
    return buildMonolithHeaders(token);
  }
  transformRequest(_model, body, _stream, credentials) {
    const messages = body.messages;
    const prompt = buildPrompt(messages);
    const isToolExchange = Array.isArray(messages) && hasToolExchange(messages);
    const userInstruction = isToolExchange ? buildLatestUserInstruction(messages) : prompt;
    const providerData = credentials?.providerSpecificData && typeof credentials.providerSpecificData === "object" ? credentials.providerSpecificData : {};
    const projectPath = typeof providerData.projectPath === "string" && providerData.projectPath.trim().length > 0 ? providerData.projectPath.trim() : void 0;
    const fileName = typeof providerData.fileName === "string" && providerData.fileName.trim().length > 0 ? providerData.fileName.trim() : "snippet.txt";
    return {
      current_file: {
        file_name: fileName,
        content_above_cursor: prompt,
        content_below_cursor: ""
      },
      intent: "generation",
      generation_type: "small_file",
      stream: false,
      ...projectPath ? { project_path: projectPath } : {},
      ...userInstruction ? { user_instruction: userInstruction } : {}
    };
  }
  async refreshCredentials(credentials, log) {
    if (!isGitLabDuoOAuthProvider(this.provider) || !credentials.refreshToken) {
      return null;
    }
    try {
      return await getAccessToken(this.provider, credentials, log);
    } catch (error) {
      log?.error?.(
        "TOKEN",
        `GitLab Duo refresh error: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }
  needsRefresh(credentials) {
    if (isGitLabDuoOAuthProvider(this.provider) && !credentials?.accessToken && credentials?.refreshToken) {
      return true;
    }
    return super.needsRefresh(credentials);
  }
  async fetchGitLabDirectAccess(root, accessToken, signal) {
    const endpoints = buildGitLabOAuthEndpoints(root);
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const combinedSignal = signal ? mergeAbortSignals(signal, timeoutSignal) : timeoutSignal;
    const response = await fetch(endpoints.directAccessUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      },
      signal: combinedSignal
    });
    const bodyText = await response.text();
    if (!response.ok) {
      return { directAccess: null, response, bodyText };
    }
    const parsed = bodyText ? JSON.parse(bodyText) : {};
    return {
      directAccess: parseGitLabDirectAccessDetails(parsed),
      response,
      bodyText
    };
  }
  async resolveRequestTarget(input, credentials) {
    const root = resolveGitLabRoot(credentials);
    const endpoints = buildGitLabOAuthEndpoints(root);
    if (!isGitLabDuoOAuthProvider(this.provider)) {
      return {
        target: {
          mode: "monolith",
          url: endpoints.publicCompletionsUrl,
          headers: buildMonolithHeaders(credentials.apiKey || credentials.accessToken || null)
        },
        credentials,
        errorResponse: null
      };
    }
    if (!credentials.accessToken) {
      return {
        target: null,
        credentials,
        errorResponse: toOpenAIError(401, "GitLab Duo OAuth connection is missing an access token")
      };
    }
    const cachedDirectAccess = getCachedGitLabDirectAccess(credentials.providerSpecificData);
    if (cachedDirectAccess) {
      return {
        target: {
          mode: "direct",
          url: buildGitLabDirectGatewayUrl(cachedDirectAccess.baseUrl),
          headers: buildDirectHeaders(cachedDirectAccess)
        },
        credentials,
        errorResponse: null
      };
    }
    try {
      const { directAccess, response, bodyText } = await this.fetchGitLabDirectAccess(
        root,
        credentials.accessToken,
        input.signal
      );
      if (directAccess) {
        await persistGitLabDirectAccessCache(input, credentials, root, directAccess);
        const mergedCredentials = mergeCredentials(credentials, {
          providerSpecificData: {
            ...credentials.providerSpecificData || {},
            baseUrl: root,
            gitlabDirectAccess: {
              token: directAccess.token,
              baseUrl: directAccess.baseUrl,
              expiresAt: directAccess.expiresAt,
              headers: directAccess.headers
            }
          }
        });
        return {
          target: {
            mode: "direct",
            url: buildGitLabDirectGatewayUrl(directAccess.baseUrl),
            headers: buildDirectHeaders(directAccess)
          },
          credentials: mergedCredentials,
          errorResponse: null
        };
      }
      if (!response) {
        return {
          target: {
            mode: "monolith",
            url: endpoints.publicCompletionsUrl,
            headers: buildMonolithHeaders(credentials.accessToken)
          },
          credentials,
          errorResponse: null
        };
      }
      if (response.status === 401) {
        return {
          target: null,
          credentials,
          errorResponse: toOpenAIError(401, "GitLab Duo direct access token request was rejected")
        };
      }
      if (response.status === 403 && !isGitLabDirectAccessDisabled(response.status, bodyText)) {
        return {
          target: null,
          credentials,
          errorResponse: toOpenAIError(403, "GitLab Duo direct access scope is unavailable")
        };
      }
      return {
        target: {
          mode: "monolith",
          url: endpoints.publicCompletionsUrl,
          headers: buildMonolithHeaders(credentials.accessToken)
        },
        credentials,
        errorResponse: null
      };
    } catch (error) {
      return {
        target: {
          mode: "monolith",
          url: endpoints.publicCompletionsUrl,
          headers: buildMonolithHeaders(credentials.accessToken)
        },
        credentials,
        errorResponse: null
      };
    }
  }
  async performRequest(input, target, transformedBody) {
    const headers = { ...target.headers };
    mergeUpstreamExtraHeaders(headers, input.upstreamExtraHeaders);
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const combinedSignal = input.signal ? mergeAbortSignals(input.signal, timeoutSignal) : timeoutSignal;
    const response = await fetch(target.url, {
      method: "POST",
      headers,
      body: JSON.stringify(transformedBody),
      signal: combinedSignal
    });
    return { response, headers };
  }
  async execute(input) {
    const bodyObj = input.body || {};
    const rawMessages = bodyObj.messages || [];
    const { hasTools, requestedTools, effectiveMessages } = prepareToolMessages(
      bodyObj,
      rawMessages
    );
    const prompt = buildPrompt(effectiveMessages);
    if (!prompt) {
      return {
        response: toOpenAIError(400, "GitLab Duo requires at least one user message")
      };
    }
    let activeCredentials = input.credentials;
    if (this.needsRefresh(activeCredentials)) {
      const refreshed = await this.refreshCredentials(activeCredentials, input.log || null);
      if (refreshed) {
        activeCredentials = mergeCredentials(activeCredentials, refreshed);
        await input.onCredentialsRefreshed?.({
          ...refreshed,
          providerSpecificData: {
            ...input.credentials.providerSpecificData || {},
            ...refreshed.providerSpecificData || {}
          }
        });
      }
    }
    const transformedBody = this.transformRequest(
      input.model,
      { ...bodyObj, messages: effectiveMessages },
      false,
      activeCredentials
    );
    const {
      target,
      credentials: resolvedCredentials,
      errorResponse
    } = await this.resolveRequestTarget(input, activeCredentials);
    if (errorResponse || !target) {
      return {
        response: errorResponse || toOpenAIError(500, "GitLab Duo target resolution failed")
      };
    }
    activeCredentials = resolvedCredentials;
    let upstream;
    let requestHeaders;
    let activeTarget = target;
    try {
      const requestResult = await this.performRequest(input, target, transformedBody);
      upstream = requestResult.response;
      requestHeaders = requestResult.headers;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        response: toOpenAIError(502, `GitLab Duo connection failed: ${message}`),
        url: target.url,
        headers: target.headers,
        transformedBody
      };
    }
    if (!upstream.ok && target.mode === "direct") {
      const fallbackTarget = {
        mode: "monolith",
        url: buildGitLabOAuthEndpoints(resolveGitLabRoot(activeCredentials)).publicCompletionsUrl,
        headers: buildMonolithHeaders(activeCredentials.accessToken || null)
      };
      try {
        const fallbackResult = await this.performRequest(input, fallbackTarget, transformedBody);
        upstream = fallbackResult.response;
        requestHeaders = fallbackResult.headers;
        activeTarget = fallbackTarget;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          response: toOpenAIError(502, `GitLab Duo connection failed: ${message}`),
          url: fallbackTarget.url,
          headers: fallbackTarget.headers,
          transformedBody
        };
      }
    }
    if (!upstream.ok) {
      const text = await upstream.text();
      const message = upstream.status === 401 || upstream.status === 403 ? `GitLab Duo auth failed: ${upstream.status}` : upstream.status === 429 ? "GitLab Duo rate limited the request" : text || `GitLab Duo request failed: ${upstream.status}`;
      return {
        response: toOpenAIError(upstream.status, message),
        url: activeTarget.url,
        headers: requestHeaders,
        transformedBody
      };
    }
    const payload = await upstream.json();
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const firstChoice = choices[0] && typeof choices[0] === "object" ? choices[0] : {};
    const content = typeof firstChoice.text === "string" ? firstChoice.text : typeof payload.content === "string" ? payload.content : "";
    const resolvedModel = resolveResponseModel(payload, input.model);
    const responseId = `chatcmpl-gitlab-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1e3);
    if (hasTools) {
      const {
        content: toolContent,
        toolCalls,
        finishReason
      } = buildToolAwareResult(content, requestedTools, "gitlab");
      const message = { role: "assistant", content: toolContent };
      if (toolCalls) {
        message.tool_calls = toolCalls;
        message.content = null;
      }
      const response2 = input.stream ? buildToolStreamingResponse(message, finishReason, resolvedModel, responseId, created) : buildToolJsonCompletion(message, finishReason, resolvedModel, responseId, created);
      return { response: response2, url: activeTarget.url, headers: requestHeaders, transformedBody };
    }
    const response = input.stream ? buildStreamingResponse(content, resolvedModel, responseId, created) : buildJsonCompletion(content, resolvedModel, responseId, created);
    return { response, url: activeTarget.url, headers: requestHeaders, transformedBody };
  }
}
var gitlab_default = GitlabExecutor;
export {
  GitlabExecutor,
  buildPrompt,
  gitlab_default as default
};
