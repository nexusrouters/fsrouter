import { getAppLogFormat, getAppLogLevel } from "../../src/lib/logEnv";
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
function isLogLevel(value) {
  return Object.prototype.hasOwnProperty.call(LEVELS, value);
}
const configuredLevel = getAppLogLevel("info").toLowerCase();
const currentLevel = isLogLevel(configuredLevel) ? LEVELS[configuredLevel] : LEVELS.info;
const jsonFormat = getAppLogFormat("text") === "json";
let requestCounter = 0;
function generateRequestId() {
  return `req_${Date.now()}_${++requestCounter}`;
}
function maskKey(key) {
  if (!key || key.length < 12) return "(redacted)";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}
function getConsoleFn(level) {
  switch (level) {
    case "debug":
      return console.debug;
    case "warn":
      return console.warn;
    case "error":
      return console.error;
    default:
      return console.log;
  }
}
function formatMeta(meta) {
  if (!meta || typeof meta !== "object") return "";
  const cleaned = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v !== void 0 && v !== null) cleaned[k] = v;
  }
  return Object.keys(cleaned).length > 0 ? ` ${JSON.stringify(cleaned)}` : "";
}
function logger(tag) {
  const emit = (level, message, meta) => {
    if (LEVELS[level] < currentLevel) return;
    const consoleFn = getConsoleFn(level);
    if (jsonFormat) {
      const entry = {
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        level,
        tag,
        msg: message
      };
      if (meta && typeof meta === "object" && Object.keys(meta).length > 0) {
        entry.data = meta;
      }
      consoleFn(JSON.stringify(entry));
    } else {
      consoleFn(`[${level.toUpperCase()}] [${tag}] ${message}${formatMeta(meta)}`);
    }
  };
  return {
    debug: (message, meta) => emit("debug", message, meta),
    info: (message, meta) => emit("info", message, meta),
    warn: (message, meta) => emit("warn", message, meta),
    error: (message, meta) => emit("error", message, meta)
  };
}
function createLogger(requestId = null) {
  const emit = (level, tag, message, data) => {
    if (LEVELS[level] < currentLevel) return;
    const consoleFn = getConsoleFn(level);
    if (jsonFormat) {
      const entry = {
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        level,
        tag,
        msg: message
      };
      if (requestId) entry.reqId = requestId;
      if (data && typeof data === "object" && Object.keys(data).length > 0) {
        entry.data = data;
      }
      consoleFn(JSON.stringify(entry));
    } else {
      const ts = (/* @__PURE__ */ new Date()).toISOString().slice(11, 23);
      const prefix = requestId ? `[${requestId}]` : "";
      const dataStr = formatMeta(data);
      consoleFn(`${ts} ${prefix}[${tag}] ${message}${dataStr}`);
    }
  };
  return {
    debug: (tag, msg, data) => emit("debug", tag, msg, data),
    info: (tag, msg, data) => emit("info", tag, msg, data),
    warn: (tag, msg, data) => emit("warn", tag, msg, data),
    error: (tag, msg, data) => emit("error", tag, msg, data)
  };
}
const defaultLogger = createLogger();
const log = defaultLogger;
var logger_default = logger;
export {
  createLogger,
  logger_default as default,
  defaultLogger,
  generateRequestId,
  log,
  logger,
  maskKey
};
