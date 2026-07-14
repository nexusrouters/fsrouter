const FW = "[\uFF5C|]";
const SEP = "[\u2581_]";
const OUTER_RE = new RegExp(
  `<${FW}tool${SEP}calls${SEP}begin${FW}>([\\s\\S]*?)<${FW}tool${SEP}calls${SEP}end${FW}>`,
  "i"
);
const INNER_RE = new RegExp(
  `<${FW}tool${SEP}call${SEP}begin${FW}>([\\s\\S]*?)<${FW}tool${SEP}call${SEP}end${FW}>`,
  "gi"
);
const ARG_SEP_RE = new RegExp(`<${FW}tool${SEP}sep${FW}>`, "gi");
const PARTIAL_OPEN_MARKER_RE = new RegExp(
  `<${FW}?(?:t(?:o(?:o(?:l(?:${SEP}(?:c(?:a(?:l(?:l(?:s)?(?:${SEP}(?:b(?:e(?:g(?:i(?:n${FW}?>?)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?$`,
  "i"
);
function hasComposerToolCalls(text) {
  if (!text || typeof text !== "string") return false;
  return OUTER_RE.test(text);
}
function generateToolCallId(index) {
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  return `call_${rand}${index}`;
}
function parseInnerCall(body) {
  const trimmed = body.replace(/^\s+|\s+$/g, "");
  const segments = trimmed.split(ARG_SEP_RE);
  const name = (segments.shift() ?? "").trim();
  if (!name) {
    return null;
  }
  const args = {};
  for (const seg of segments) {
    if (!seg) continue;
    const idxNl = seg.indexOf("\n");
    let argName;
    let argValue;
    if (idxNl < 0) {
      argName = seg.trim();
      argValue = "";
    } else {
      argName = seg.slice(0, idxNl).trim();
      argValue = seg.slice(idxNl + 1);
    }
    if (!argName) continue;
    argValue = argValue.replace(/\n+$/, "");
    args[argName] = coerceArgValue(argValue);
  }
  return { name, arguments: JSON.stringify(args) };
}
function coerceArgValue(raw) {
  if (raw === "") return "";
  const stripped = raw.trim();
  if (stripped.startsWith("{") && stripped.endsWith("}") || stripped.startsWith("[") && stripped.endsWith("]")) {
    try {
      return JSON.parse(stripped);
    } catch {
    }
  }
  if (stripped === "true") return true;
  if (stripped === "false") return false;
  if (stripped === "null") return null;
  if (/^-?\d+$/.test(stripped)) {
    const n = Number(stripped);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d*\.\d+$/.test(stripped)) {
    const n = Number(stripped);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}
function parseComposerToolCalls(text) {
  if (!text || typeof text !== "string") {
    return { content: text || "", toolCalls: [] };
  }
  const match = text.match(OUTER_RE);
  if (!match || match.index === void 0) {
    return { content: text, toolCalls: [] };
  }
  const preamble = text.slice(0, match.index);
  const trailing = text.slice(match.index + match[0].length);
  const block = match[1];
  const toolCalls = [];
  let idx = 0;
  for (const innerMatch of block.matchAll(INNER_RE)) {
    const parsed = parseInnerCall(innerMatch[1]);
    if (!parsed) continue;
    toolCalls.push({
      id: generateToolCallId(idx),
      type: "function",
      function: parsed
    });
    idx += 1;
  }
  const residual = (preamble + trailing).trim();
  return { content: residual, toolCalls };
}
function createStreamingState() {
  return {
    emitted: 0,
    // number of safe content chars already emitted
    done: false
  };
}
function feedStreamingChunk(state, accumulated) {
  if (state.done) {
    return { safeDelta: "", ready: false, toolCalls: [], holdback: false };
  }
  if (!accumulated) {
    return { safeDelta: "", ready: false, toolCalls: [], holdback: false };
  }
  const m = accumulated.match(OUTER_RE);
  if (m && m.index !== void 0) {
    const preamble = accumulated.slice(0, m.index);
    const block = m[1];
    const toolCalls = [];
    let idx = 0;
    for (const innerMatch of block.matchAll(INNER_RE)) {
      const parsed = parseInnerCall(innerMatch[1]);
      if (!parsed) continue;
      toolCalls.push({
        id: generateToolCallId(idx),
        type: "function",
        function: parsed
      });
      idx += 1;
    }
    const safe = preamble;
    const safeDelta2 = safe.length > state.emitted ? safe.slice(state.emitted) : "";
    state.emitted = safe.length;
    state.done = true;
    return { safeDelta: safeDelta2, ready: true, toolCalls, holdback: false };
  }
  const openOnlyRe = new RegExp(`<${FW}tool${SEP}calls${SEP}begin${FW}>`, "i");
  const openMatch = accumulated.match(openOnlyRe);
  if (openMatch && openMatch.index !== void 0) {
    const safe = accumulated.slice(0, openMatch.index);
    const safeDelta2 = safe.length > state.emitted ? safe.slice(state.emitted) : "";
    state.emitted = safe.length;
    return { safeDelta: safeDelta2, ready: false, toolCalls: [], holdback: true };
  }
  const tailMatch = accumulated.match(PARTIAL_OPEN_MARKER_RE);
  if (tailMatch && tailMatch.index !== void 0) {
    const safe = accumulated.slice(0, tailMatch.index);
    const safeDelta2 = safe.length > state.emitted ? safe.slice(state.emitted) : "";
    state.emitted = safe.length;
    return { safeDelta: safeDelta2, ready: false, toolCalls: [], holdback: true };
  }
  const safeDelta = accumulated.length > state.emitted ? accumulated.slice(state.emitted) : "";
  state.emitted = accumulated.length;
  return { safeDelta, ready: false, toolCalls: [], holdback: false };
}
export {
  createStreamingState,
  feedStreamingChunk,
  hasComposerToolCalls,
  parseComposerToolCalls
};
