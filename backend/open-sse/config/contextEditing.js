const CLEAR_TOOL_USES_STRATEGY = "clear_tool_uses_20250919";
const CLEAR_THINKING_STRATEGY = "clear_thinking_20251015";
const CONTEXT_EDITING_DEFAULT_TRIGGER_TOKENS = 1e5;
const CONTEXT_EDITING_DEFAULT_KEEP_TOOL_USES = 3;
function applyContextEditingToBody(body, opts) {
  if (!opts.enabled || !body || typeof body !== "object") return;
  const existing = body.context_management && typeof body.context_management === "object" ? body.context_management : {};
  const edits = Array.isArray(existing.edits) ? [...existing.edits] : [];
  const hasToolUseEdit = edits.some((edit) => edit && edit.type === CLEAR_TOOL_USES_STRATEGY);
  if (!hasToolUseEdit) {
    edits.push({
      type: CLEAR_TOOL_USES_STRATEGY,
      trigger: { type: "input_tokens", value: CONTEXT_EDITING_DEFAULT_TRIGGER_TOKENS },
      keep: { type: "tool_uses", value: CONTEXT_EDITING_DEFAULT_KEEP_TOOL_USES }
    });
    edits.sort((a, b) => {
      const aRank = a && a.type === CLEAR_THINKING_STRATEGY ? 0 : 1;
      const bRank = b && b.type === CLEAR_THINKING_STRATEGY ? 0 : 1;
      return aRank - bRank;
    });
  }
  existing.edits = edits;
  body.context_management = existing;
}
function toClearedInt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return 0;
}
function getNested(obj, keys) {
  let cur = obj;
  for (const key of keys) {
    if (!cur || typeof cur !== "object") return void 0;
    cur = cur[key];
  }
  return cur;
}
function extractContextEditingTelemetry(responseBody) {
  if (!responseBody || typeof responseBody !== "object") return null;
  const candidates = [
    getNested(responseBody, ["context_management", "applied_edits"]),
    getNested(responseBody, ["usage", "context_management", "applied_edits"]),
    getNested(responseBody, ["usage", "applied_edits"])
  ];
  const edits = candidates.find((c) => Array.isArray(c));
  if (!Array.isArray(edits) || edits.length === 0) return null;
  let clearedInputTokens = 0;
  let clearedToolUses = 0;
  for (const entry of edits) {
    if (!entry || typeof entry !== "object") continue;
    const edit = entry;
    clearedInputTokens += toClearedInt(edit.cleared_input_tokens ?? edit.clearedInputTokens);
    clearedToolUses += toClearedInt(edit.cleared_tool_uses ?? edit.clearedToolUses);
  }
  if (clearedInputTokens <= 0 && clearedToolUses <= 0) return null;
  return { editCount: edits.length, clearedInputTokens, clearedToolUses };
}
export {
  CLEAR_THINKING_STRATEGY,
  CLEAR_TOOL_USES_STRATEGY,
  CONTEXT_EDITING_DEFAULT_KEEP_TOOL_USES,
  CONTEXT_EDITING_DEFAULT_TRIGGER_TOKENS,
  applyContextEditingToBody,
  extractContextEditingTelemetry
};
