const TASK_PATTERNS = {
  coding: {
    patterns: [
      "write code",
      "write a function",
      "implement",
      "debug",
      "fix this",
      "fix the",
      "refactor",
      "unit test",
      "write test",
      "write a script",
      "code review",
      "complete this function",
      "add a feature",
      "javascript",
      "typescript",
      "python",
      "sql query",
      "api endpoint"
    ],
    userPatterns: [
      "```",
      "def ",
      "function ",
      "class ",
      "import ",
      "const ",
      "let ",
      "var ",
      "SELECT ",
      "INSERT ",
      "<html",
      "<div"
    ]
  },
  creative: {
    patterns: [
      "write a story",
      "write a poem",
      "write a song",
      "creative writing",
      "write a blog",
      "write an article",
      "write a script",
      "write an essay",
      "imagine",
      "roleplay",
      "brainstorm",
      "creative"
    ]
  },
  analysis: {
    patterns: [
      "analyze",
      "analyse",
      "analysis",
      "compare",
      "evaluate",
      "assess",
      "explain",
      "reasoning",
      "pros and cons",
      "advantages and disadvantages",
      "what are the implications",
      "in-depth",
      "comprehensive"
    ]
  },
  vision: {
    patterns: [
      "look at this image",
      "in this image",
      "what do you see",
      "describe this image",
      "analyze this image",
      "read this screenshot"
    ],
    userPatterns: ["image_url", "data:image"]
  },
  summarization: {
    patterns: [
      "summarize",
      "summary",
      "tldr",
      "tl;dr",
      "brief overview",
      "key points",
      "main points",
      "what did",
      "highlights from"
    ]
  },
  background: {
    patterns: [
      "generate a title",
      "generate title",
      "create a title",
      "name this",
      "short description",
      "brief description",
      "one-line summary",
      "conversation title"
    ]
  },
  chat: {
    patterns: []
  }
};
const DEFAULT_TASK_MODEL_MAP = {
  coding: "deepseek/deepseek-chat",
  // DeepSeek V3.2 — best coding OSS
  creative: "",
  // No override — use requested model
  analysis: "gemini/gemini-2.5-pro",
  // Best long-context reasoning
  vision: "openai/gpt-4o",
  // Best vision baseline
  summarization: "gemini/gemini-2.5-flash",
  // Fast + cheap for summarization
  background: "gemini/gemini-2.5-flash-lite",
  // Cheapest for utility tasks
  chat: ""
  // No override — use requested model
};
let _config = {
  enabled: false,
  // User must explicitly enable
  taskModelMap: { ...DEFAULT_TASK_MODEL_MAP },
  detectionEnabled: true,
  stats: { detected: 0, routed: 0 }
};
function setTaskRoutingConfig(config) {
  _config = {
    ..._config,
    ...config,
    stats: _config.stats
    // preserve stats across config changes
  };
}
function getTaskRoutingConfig() {
  return {
    ..._config,
    taskModelMap: { ..._config.taskModelMap },
    stats: { ..._config.stats }
  };
}
function resetTaskRoutingStats() {
  _config.stats = { detected: 0, routed: 0 };
}
function getDefaultTaskModelMap() {
  return { ...DEFAULT_TASK_MODEL_MAP };
}
function extractText(content) {
  if (typeof content === "string") return content.toLowerCase();
  if (Array.isArray(content)) {
    return content.map(
      (part) => typeof part === "string" ? part.toLowerCase() : part?.text?.toLowerCase() || ""
    ).join(" ");
  }
  return "";
}
function hasImages(messages) {
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === "image_url" || part?.type === "image") return true;
      }
    }
  }
  return false;
}
function detectTaskType(body) {
  if (!body || typeof body !== "object") return "chat";
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  if (messages.length === 0) return "chat";
  if (hasImages(messages)) return "vision";
  const systemMsg = messages.find((m) => m.role === "system" || m.role === "developer");
  const systemText = systemMsg ? extractText(systemMsg.content) : "";
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const userText = lastUserMsg ? extractText(lastUserMsg.content) : "";
  const priorityOrder = [
    "background",
    "coding",
    "vision",
    "summarization",
    "analysis",
    "creative"
  ];
  for (const taskType of priorityOrder) {
    const { patterns, userPatterns } = TASK_PATTERNS[taskType];
    if (patterns.some((p) => systemText.includes(p.toLowerCase()))) {
      return taskType;
    }
    if (patterns.some((p) => userText.includes(p.toLowerCase()))) {
      return taskType;
    }
    if (userPatterns?.some((p) => userText.includes(p.toLowerCase()))) {
      return taskType;
    }
  }
  return "chat";
}
function applyTaskAwareRouting(originalModel, body) {
  if (!_config.enabled || !_config.detectionEnabled) {
    return { model: originalModel, taskType: "chat", wasRouted: false };
  }
  const taskType = detectTaskType(body);
  _config.stats.detected++;
  const preferred = _config.taskModelMap[taskType];
  if (!preferred || preferred === "") {
    return { model: originalModel, taskType, wasRouted: false };
  }
  if (taskType !== "background" && taskType !== "summarization") {
  }
  _config.stats.routed++;
  return { model: preferred, taskType, wasRouted: true };
}
export {
  applyTaskAwareRouting,
  detectTaskType,
  getDefaultTaskModelMap,
  getTaskRoutingConfig,
  resetTaskRoutingStats,
  setTaskRoutingConfig
};
