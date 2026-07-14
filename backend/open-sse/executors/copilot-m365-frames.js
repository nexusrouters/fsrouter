const RECORD_SEPARATOR = String.fromCharCode(30);
const HANDSHAKE_REQUEST = { protocol: "json", version: 1 };
const KEEPALIVE_PING = { type: 6 };
const ALLOWED_MESSAGE_TYPES = [
  "Chat",
  "Suggestion",
  "InternalSearchQuery",
  "Disengaged",
  "InternalLoaderMessage",
  "Progress",
  "GeneratedCode",
  "RenderCardRequest",
  "AdsQuery",
  "SemanticSerp",
  "GenerateContentQuery"
];
const M365_DEFAULT_OPTION_SETS = [
  "search_result_progress_messages_with_search_queries",
  "update_textdoc_response_after_streaming",
  "deepleo_networking_timeout_10minutes_canmore",
  "cwc_flux_image",
  "cwc_code_interpreter",
  "cwc_code_interpreter_amsfix",
  "enable_msa_user",
  "cwcgptv",
  "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch",
  "gptvnorm2048",
  "pdnascan",
  "cwc_code_interpreter_citation_fix",
  "code_interpreter_interactive_charts",
  "cwc_code_interpreter_interactive_charts_inline_image",
  "code_interpreter_matplotlib_patching",
  "cwc_fileupload_odb",
  "update_memory_plugin",
  "add_custom_instructions",
  "cwc_flux_v3",
  "flux_v3_progress_messages",
  "enable_batch_token_processing",
  "enable_gg_gpt",
  "flux_v3_image_gen_enable_non_watermarked_storage",
  "flux_v3_image_gen_enable_story",
  "rich_responses"
];
function encodeFrame(obj) {
  return JSON.stringify(obj) + RECORD_SEPARATOR;
}
function handshakeFrame() {
  return encodeFrame(HANDSHAKE_REQUEST);
}
function keepaliveFrame() {
  return encodeFrame(KEEPALIVE_PING);
}
function splitFrames(buffer) {
  const parts = buffer.split(RECORD_SEPARATOR);
  const rest = parts.pop() ?? "";
  const frames = parts.filter((p) => p.length > 0);
  return { frames, rest };
}
function parseFrame(frame) {
  const trimmed = frame.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function handshakeError(frame) {
  if (!frame) return null;
  const err = frame.error;
  return typeof err === "string" && err.length > 0 ? err : null;
}
function buildChatInvocation(opts) {
  return {
    type: 4,
    target: "chat",
    invocationId: "0",
    arguments: [
      {
        source: "officeweb",
        clientCorrelationId: opts.traceId,
        sessionId: opts.sessionId,
        optionsSets: opts.optionsSets ?? [...M365_DEFAULT_OPTION_SETS],
        streamingMode: "ConciseWithPadding",
        spokenTextMode: "None",
        options: {},
        extraExtensionParameters: {},
        allowedMessageTypes: [...ALLOWED_MESSAGE_TYPES],
        sliceIds: [],
        threadLevelGptId: {},
        traceId: opts.traceId,
        isStartOfSession: opts.isStartOfSession ?? true,
        clientInfo: {},
        message: {
          author: "user",
          inputMethod: "Keyboard",
          text: opts.text,
          messageType: "Chat"
        },
        plugins: [],
        isSbsSupported: false,
        tone: opts.tone ?? "",
        renderReferencesBehindEOS: true,
        disconnectBehavior: ""
      }
    ]
  };
}
function isUpdateFrame(frame) {
  return !!frame && frame.type === 1 && frame.target === "update";
}
function isCompletionFrame(frame) {
  return !!frame && frame.type === 3;
}
function isLastUpdate(frame) {
  if (!isUpdateFrame(frame)) return false;
  const args = frame.arguments;
  const first = Array.isArray(args) ? args[0] : void 0;
  return first?.isLastUpdate === true;
}
function extractBotText(frame) {
  if (!isUpdateFrame(frame)) return null;
  const args = frame.arguments;
  const first = Array.isArray(args) ? args[0] : void 0;
  const messages = first?.messages;
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const author = m.author;
    const text = m.text;
    if (m.messageType === "Progress" || m.contentType === "EarlyProgress") continue;
    if ((author === "bot" || author === void 0) && typeof text === "string" && text.length > 0) {
      return text;
    }
  }
  return null;
}
function incrementalDelta(previous, next) {
  if (!next) return "";
  if (next === previous) return "";
  if (next.startsWith(previous)) return next.slice(previous.length);
  return next;
}
function extractWriteAtCursor(frame) {
  if (!isUpdateFrame(frame)) return null;
  const args = frame.arguments;
  const first = Array.isArray(args) ? args[0] : void 0;
  const wac = first?.writeAtCursor;
  return typeof wac === "string" && wac.length > 0 ? wac : null;
}
function extractFinalResultMessage(frame) {
  if (!frame || frame.type !== 2) return null;
  const item = frame.item;
  const result = item?.result;
  const message = result?.message;
  return typeof message === "string" && message.length > 0 ? message : null;
}
function accumulateBotContent(previous, frame) {
  const snapshot = extractBotText(frame);
  if (snapshot) {
    return { delta: incrementalDelta(previous, snapshot), next: snapshot };
  }
  const wac = extractWriteAtCursor(frame);
  if (wac) {
    return { delta: wac, next: previous + wac };
  }
  return { delta: "", next: previous };
}
export {
  ALLOWED_MESSAGE_TYPES,
  HANDSHAKE_REQUEST,
  KEEPALIVE_PING,
  M365_DEFAULT_OPTION_SETS,
  RECORD_SEPARATOR,
  accumulateBotContent,
  buildChatInvocation,
  encodeFrame,
  extractBotText,
  extractFinalResultMessage,
  extractWriteAtCursor,
  handshakeError,
  handshakeFrame,
  incrementalDelta,
  isCompletionFrame,
  isLastUpdate,
  isUpdateFrame,
  keepaliveFrame,
  parseFrame,
  splitFrames
};
