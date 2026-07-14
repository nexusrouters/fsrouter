function asString(value) {
  return typeof value === "string" ? value : "";
}
function hasNativeWebSearchTool(body) {
  if (!body || typeof body !== "object") return false;
  const tools = body.tools;
  if (!Array.isArray(tools)) return false;
  return tools.some((tool) => {
    if (!tool || typeof tool !== "object") return false;
    const record = tool;
    if (record.function) return false;
    return asString(record.type).startsWith("web_search");
  });
}
function resolveWebSearchRouteOverride(currentModel, body, settings) {
  const fallthrough = { wasRouted: false, model: currentModel };
  if (!hasNativeWebSearchTool(body)) return fallthrough;
  const configured = asString(settings?.webSearchRouteModel).trim();
  if (!configured || configured === currentModel) return fallthrough;
  return { wasRouted: true, model: configured };
}
export {
  hasNativeWebSearchTool,
  resolveWebSearchRouteOverride
};
