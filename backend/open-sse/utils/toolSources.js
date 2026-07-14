const MAX_VISIBLE_NAMES = 80;
function getToolName(tool) {
  return tool?.name || tool?.function?.name || tool?.type || "unknown";
}
function getToolSource(name) {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return parts[1] ? `mcp:${parts[1]}` : "mcp";
  }
  if (name.startsWith("web_search") || name.startsWith("web_fetch")) return "hosted:web";
  if (name.startsWith("computer_") || name.startsWith("str_replace_")) return "hosted:computer";
  return "client";
}
function summarizeToolSources(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const names = tools.map((tool) => getToolName(tool));
  const sourceCounts = /* @__PURE__ */ new Map();
  for (const name of names) {
    const source = getToolSource(name);
    sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
  }
  const sources = Array.from(sourceCounts.entries()).map(([source, count]) => `${source}=${count}`).join(", ");
  const visibleNames = names.slice(0, MAX_VISIBLE_NAMES).join(", ");
  const suffix = names.length > MAX_VISIBLE_NAMES ? `, ... +${names.length - MAX_VISIBLE_NAMES} more` : "";
  return `${tools.length} tools | sources: ${sources} | names: ${visibleNames}${suffix}`;
}
export {
  getToolName,
  getToolSource,
  summarizeToolSources
};
