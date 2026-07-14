const ThinkingMode = {
  AUTO: "auto",
  // Let provider decide (remove client's budget)
  PASSTHROUGH: "passthrough",
  // No changes (current behavior)
  CUSTOM: "custom",
  // Set fixed budget
  ADAPTIVE: "adaptive"
  // Scale based on request complexity
};
import {
  capThinkingBudget,
  getDefaultThinkingBudget,
  getResolvedModelCapabilities,
  supportsReasoning
} from "@/lib/modelCapabilities";
const EFFORT_BUDGETS = {
  none: 0,
  low: 1024,
  medium: 10240,
  high: 131072,
  // Handled globally by capThinkingBudget later
  max: 131072,
  // T11: Claude "max" / "xhigh" — full budget
  xhigh: 131072
  // T11: explicit alias used internally
};
const THINKING_LEVEL_MAP = {
  none: 0,
  low: 4096,
  medium: 8192,
  high: 24576,
  max: 131072,
  // T11: max = full Claude budget (sub2api: xhigh)
  xhigh: 131072
  // T11: explicit xhigh alias
};
const DEFAULT_THINKING_CONFIG = {
  mode: ThinkingMode.PASSTHROUGH,
  customBudget: 10240,
  effortLevel: "medium"
};
const GLOBAL_KEY = "__omniroute_thinkingBudget_config__";
const _store = globalThis;
function getConfig() {
  if (!_store[GLOBAL_KEY]) {
    _store[GLOBAL_KEY] = { ...DEFAULT_THINKING_CONFIG };
  }
  return _store[GLOBAL_KEY];
}
function toRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function getStringField(record, key) {
  const value = record[key];
  return typeof value === "string" ? value : "";
}
function setThinkingBudgetConfig(config) {
  _store[GLOBAL_KEY] = { ...DEFAULT_THINKING_CONFIG, ...config };
}
function getThinkingBudgetConfig() {
  return { ...getConfig() };
}
function hydrateThinkingBudgetConfig(settings) {
  const tb = toRecord(settings).thinkingBudget;
  if (tb && typeof tb === "object" && !Array.isArray(tb)) {
    setThinkingBudgetConfig(tb);
    return true;
  }
  return false;
}
function normalizeThinkingLevel(body) {
  if (!body || typeof body !== "object") return body;
  const result = { ...body };
  const levelStr = result.thinkingLevel || result.thinking_level;
  if (typeof levelStr === "string" && THINKING_LEVEL_MAP[levelStr.toLowerCase()] !== void 0) {
    const rawBudget = THINKING_LEVEL_MAP[levelStr.toLowerCase()];
    const budget = capThinkingBudget(getStringField(result, "model"), rawBudget);
    result.thinking = {
      type: budget > 0 ? "enabled" : "disabled",
      budget_tokens: budget
    };
    delete result.thinkingLevel;
    delete result.thinking_level;
  }
  const generationConfig = toRecord(result.generationConfig);
  const thinkingConfig = toRecord(generationConfig.thinkingConfig);
  const thinkingConfigSnake = toRecord(generationConfig.thinking_config);
  const geminiLevel = thinkingConfig.thinkingLevel || thinkingConfigSnake.thinkingLevel;
  if (typeof geminiLevel === "string" && THINKING_LEVEL_MAP[geminiLevel.toLowerCase()] !== void 0) {
    const rawBudget = THINKING_LEVEL_MAP[geminiLevel.toLowerCase()];
    const budget = capThinkingBudget(getStringField(result, "model"), rawBudget);
    result.generationConfig = {
      ...generationConfig,
      thinkingConfig: { ...thinkingConfig, thinkingBudget: budget }
    };
    const nextGenerationConfig = result.generationConfig;
    const nextThinkingConfig = toRecord(nextGenerationConfig.thinkingConfig);
    if (Object.keys(nextThinkingConfig).length > 0) {
      delete nextThinkingConfig.thinkingLevel;
      nextGenerationConfig.thinkingConfig = nextThinkingConfig;
    }
    if ("thinking_config" in nextGenerationConfig) {
      delete nextGenerationConfig.thinking_config;
    }
  }
  return result;
}
function ensureThinkingConfig(body) {
  if (!body || typeof body !== "object") return body;
  const bodyRecord = body;
  const model = getStringField(bodyRecord, "model");
  if (!model.endsWith("-thinking")) return body;
  if (bodyRecord.thinking) return body;
  const result = { ...bodyRecord };
  result.thinking = {
    type: "enabled",
    budget_tokens: getDefaultThinkingBudget(model) || EFFORT_BUDGETS.medium
  };
  return result;
}
function applyThinkingBudget(body, config = null) {
  const cfg = config || getConfig();
  if (!body || typeof body !== "object") return body;
  const bodyRecord = body;
  const modelStr = typeof bodyRecord.model === "string" ? bodyRecord.model : "";
  if (modelStr && !supportsReasoning(modelStr)) {
    return stripThinkingConfig(body);
  }
  let processed = normalizeThinkingLevel(body);
  processed = ensureThinkingConfig(processed);
  switch (cfg.mode) {
    case ThinkingMode.AUTO:
      return stripThinkingConfig(processed);
    case ThinkingMode.PASSTHROUGH:
      return processed;
    case ThinkingMode.CUSTOM:
      return setCustomBudget(processed, cfg.customBudget ?? DEFAULT_THINKING_CONFIG.customBudget);
    case ThinkingMode.ADAPTIVE:
      return applyAdaptiveBudget(processed, cfg);
    default:
      return processed;
  }
}
function stripThinkingConfig(body) {
  const result = { ...toRecord(body) };
  delete result.thinking;
  delete result.reasoning_effort;
  delete result.reasoning;
  if (result.output_config && typeof result.output_config === "object") {
    const outputConfig = { ...toRecord(result.output_config) };
    delete outputConfig.effort;
    if (Object.keys(outputConfig).length === 0) {
      delete result.output_config;
    } else {
      result.output_config = outputConfig;
    }
  }
  if (result.generationConfig) {
    const generationConfig = { ...toRecord(result.generationConfig) };
    delete generationConfig.thinking_config;
    delete generationConfig.thinkingConfig;
    result.generationConfig = generationConfig;
  }
  return result;
}
function setCustomBudget(body, budget) {
  const result = { ...toRecord(body) };
  if (result.thinking || hasThinkingCapableModel(result)) {
    result.thinking = {
      type: budget > 0 ? "enabled" : "disabled",
      budget_tokens: budget
    };
  }
  if (result.reasoning_effort !== void 0 || result.reasoning !== void 0) {
    if (budget <= 0) {
      delete result.reasoning_effort;
      delete result.reasoning;
    } else if (budget <= 1024) {
      result.reasoning_effort = "low";
    } else if (budget <= 10240) {
      result.reasoning_effort = "medium";
    } else if (budget < 131072) {
      result.reasoning_effort = "high";
    } else {
      result.reasoning_effort = "xhigh";
    }
  }
  const generationConfig = toRecord(result.generationConfig);
  if (generationConfig.thinking_config || generationConfig.thinkingConfig) {
    result.generationConfig = {
      ...generationConfig,
      thinking_config: { thinking_budget: budget }
    };
  }
  return result;
}
function applyAdaptiveBudget(body, cfg) {
  const bodyRecord = toRecord(body);
  const messages = Array.isArray(bodyRecord.messages) ? bodyRecord.messages : Array.isArray(bodyRecord.input) ? bodyRecord.input : [];
  const messageCount = messages.length;
  const tools = Array.isArray(bodyRecord.tools) ? bodyRecord.tools : [];
  const toolCount = tools.length;
  let lastMsgLength = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const msgRecord = toRecord(msg);
    if (msgRecord.role === "user") {
      lastMsgLength = typeof msgRecord.content === "string" ? msgRecord.content.length : JSON.stringify(msgRecord.content || "").length;
      break;
    }
  }
  let multiplier = 1;
  if (messageCount > 10) multiplier += 0.5;
  if (toolCount > 3) multiplier += 0.5;
  if (lastMsgLength > 2e3) multiplier += 0.3;
  const baseBudget = EFFORT_BUDGETS[typeof cfg.effortLevel === "string" ? cfg.effortLevel : "medium"] || getDefaultThinkingBudget(getStringField(bodyRecord, "model")) || EFFORT_BUDGETS.medium;
  const budget = capThinkingBudget(
    getStringField(bodyRecord, "model"),
    Math.ceil(baseBudget * multiplier)
  );
  return setCustomBudget(body, budget);
}
function hasThinkingCapableModel(body) {
  const model = getStringField(toRecord(body), "model");
  const resolved = getResolvedModelCapabilities(model);
  if (resolved.supportsThinking === true) return true;
  if (resolved.supportsThinking === false) return false;
  return model.includes("claude") || model.includes("o1") || model.includes("o3") || model.includes("o4") || model.includes("gemini") || model.endsWith("-thinking") || model.includes("thinking");
}
export {
  DEFAULT_THINKING_CONFIG,
  EFFORT_BUDGETS,
  THINKING_LEVEL_MAP,
  ThinkingMode,
  applyThinkingBudget,
  ensureThinkingConfig,
  getThinkingBudgetConfig,
  hasThinkingCapableModel,
  hydrateThinkingBudgetConfig,
  normalizeThinkingLevel,
  setThinkingBudgetConfig
};
