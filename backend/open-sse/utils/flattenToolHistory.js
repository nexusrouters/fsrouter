import { extractTextContent } from "../translator/helpers/geminiHelper.ts";
const TOOL_CALL_PREFIX = "[Called tools: ";
const TOOL_RESULT_PREFIX = "[Tool result: ";
function isMessage(m) {
  return m != null && typeof m === "object";
}
function flattenToolHistory(messages) {
  const out = [];
  for (const raw of messages) {
    if (!isMessage(raw)) continue;
    const msg = raw;
    if (msg.role === "tool" || msg.role === "function") {
      const text = extractTextContent(msg.content) || String(msg.content ?? "");
      out.push({
        role: "assistant",
        content: `${TOOL_RESULT_PREFIX}${text}]`
      });
      continue;
    }
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      const { tool_calls, ...rest } = msg;
      const names = tool_calls.map((c) => c?.function?.name || c?.name || "tool").join(", ");
      const base = extractTextContent(rest.content) || (typeof rest.content === "string" ? rest.content : "");
      out.push({
        ...rest,
        content: `${base}${base ? "\n" : ""}${TOOL_CALL_PREFIX}${names}]`
      });
      continue;
    }
    if (Array.isArray(msg.content)) {
      const blocks = msg.content;
      const hasToolUse = blocks.some((c) => c?.type === "tool_use");
      const hasToolResult = blocks.some((c) => c?.type === "tool_result");
      if (hasToolUse || hasToolResult) {
        const textParts = [];
        const toolNames = [];
        const toolResults = [];
        for (const block of blocks) {
          if (block?.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
          } else if (block?.type === "tool_use") {
            toolNames.push(block.name || "tool");
          } else if (block?.type === "tool_result") {
            toolResults.push(
              extractTextContent(block.content) || String(block.content ?? "")
            );
          }
        }
        let newContent = textParts.join("\n");
        if (toolNames.length > 0) {
          newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_CALL_PREFIX}${toolNames.join(", ")}]`;
        }
        if (toolResults.length > 0) {
          newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_RESULT_PREFIX}${toolResults.join("\n")}]`;
        }
        out.push({ ...msg, content: newContent });
        continue;
      }
    }
    out.push(msg);
  }
  return out;
}
export {
  TOOL_CALL_PREFIX,
  TOOL_RESULT_PREFIX,
  flattenToolHistory
};
