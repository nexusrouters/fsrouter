const VERBOSITY_LEVELS = /* @__PURE__ */ new Set(["low", "medium", "high"]);
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function normalizeLevel(value) {
  if (typeof value !== "string") return void 0;
  const level = value.toLowerCase();
  return VERBOSITY_LEVELS.has(level) ? level : void 0;
}
function normalizeCodexVerbosity(body) {
  const textRecord = asRecord(body.text);
  let verbosity = textRecord ? normalizeLevel(textRecord.verbosity) : void 0;
  const topLevel = normalizeLevel(body.verbosity);
  if (topLevel) verbosity = topLevel;
  delete body.verbosity;
  const nextText = textRecord ? { ...textRecord } : {};
  if (verbosity) {
    nextText.verbosity = verbosity;
  } else {
    delete nextText.verbosity;
  }
  if (Object.keys(nextText).length > 0) {
    body.text = nextText;
  } else {
    delete body.text;
  }
}
export {
  normalizeCodexVerbosity
};
