function appendToolCallArgumentDelta(current, incoming) {
  const existing = typeof current === "string" ? current : "";
  const next = typeof incoming === "string" ? incoming : "";
  if (!existing) return next;
  if (!next) return existing;
  if (next === existing) return existing;
  if (next.startsWith(existing)) return next;
  return existing + next;
}
export {
  appendToolCallArgumentDelta
};
