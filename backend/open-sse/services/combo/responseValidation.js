const MAX_REASON_SNIPPET = 60;
function snippet(value) {
  return value.length > MAX_REASON_SNIPPET ? `${value.slice(0, MAX_REASON_SNIPPET)}\u2026` : value;
}
function parseJsonPath(path) {
  const tokens = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      tokens.push(buf);
      buf = "";
    }
  };
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (ch === ".") {
      flush();
    } else if (ch === "[") {
      flush();
      let inner = "";
      i++;
      while (i < path.length && path[i] !== "]") {
        inner += path[i];
        i++;
      }
      const trimmed = inner.trim();
      const n = Number(trimmed);
      tokens.push(trimmed !== "" && Number.isInteger(n) ? n : trimmed);
    } else {
      buf += ch;
    }
  }
  flush();
  return tokens;
}
function resolveJsonPath(root, path) {
  let current = root;
  for (const token of parseJsonPath(path)) {
    if (current === null || current === void 0) return void 0;
    if (typeof token === "number") {
      if (!Array.isArray(current)) return void 0;
      current = current[token];
    } else {
      if (typeof current !== "object") return void 0;
      current = current[token];
    }
  }
  return current;
}
function isNonEmpty(value) {
  if (value === null || value === void 0) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}
function checkCondition(value, condition, expected) {
  switch (condition) {
    case "exists":
      return value !== void 0 && value !== null;
    case "nonEmpty":
      return isNonEmpty(value);
    case "equals":
      return value === expected;
    case "notEquals":
      return value !== expected;
  }
}
function extractContentText(json) {
  if (!json || typeof json !== "object") return "";
  const obj = json;
  const choices = obj.choices;
  if (Array.isArray(choices)) {
    const parts = [];
    for (const choice of choices) {
      const message = choice?.message;
      const content = message?.content;
      if (typeof content === "string") parts.push(content);
      else if (Array.isArray(content)) {
        for (const part of content) {
          const text = part?.text;
          if (typeof text === "string") parts.push(text);
        }
      }
    }
    if (parts.length) return parts.join("");
  }
  const output = obj.output;
  if (Array.isArray(output)) {
    const parts = [];
    for (const item of output) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          const text = part?.text;
          if (typeof text === "string") parts.push(text);
        }
      }
    }
    if (parts.length) return parts.join("");
  }
  return "";
}
function evaluateResponseValidation(json, config) {
  if (!config || typeof config !== "object") return { valid: true };
  const content = extractContentText(json);
  for (const sub of config.forbiddenSubstrings ?? []) {
    if (typeof sub === "string" && sub.length > 0 && content.includes(sub)) {
      return { valid: false, reason: `response contains forbidden substring "${snippet(sub)}"` };
    }
  }
  for (const sub of config.requiredSubstrings ?? []) {
    if (typeof sub === "string" && sub.length > 0 && !content.includes(sub)) {
      return { valid: false, reason: `response missing required substring "${snippet(sub)}"` };
    }
  }
  if (typeof config.minContentLength === "number" && Number.isFinite(config.minContentLength) && config.minContentLength > 0 && content.trim().length < config.minContentLength) {
    return {
      valid: false,
      reason: `response content shorter than ${config.minContentLength} chars`
    };
  }
  for (const predicate of config.jsonPathPredicates ?? []) {
    if (!predicate || typeof predicate.path !== "string" || !predicate.path) continue;
    const resolved = resolveJsonPath(json, predicate.path);
    if (!checkCondition(resolved, predicate.condition, predicate.value)) {
      return {
        valid: false,
        reason: `jsonpath check failed: "${snippet(predicate.path)}" ${predicate.condition}`
      };
    }
  }
  return { valid: true };
}
export {
  evaluateResponseValidation,
  extractContentText,
  parseJsonPath,
  resolveJsonPath
};
