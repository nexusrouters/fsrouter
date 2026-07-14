import { BaseExecutor } from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";
const REASONING_ALLOWED = ["grok-4.3", "grok-4.20-0309-reasoning"];
const REASONING_DENIED = ["grok-build-0.1", "grok-4.20-0309-non-reasoning"];
const EFFORT_SUFFIXES = ["low", "medium", "high", "xhigh"];
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
class XaiExecutor extends BaseExecutor {
  constructor() {
    super("xai", PROVIDERS.xai);
  }
  transformRequest(model, body, stream, credentials) {
    const cleaned = super.transformRequest(model, body, stream, credentials);
    const record = asRecord(cleaned);
    if (!record) return cleaned;
    const out = { ...record };
    let modelId = typeof out.model === "string" ? out.model : model;
    let suffixEffort = null;
    for (const level of EFFORT_SUFFIXES) {
      const suffix = `-${level}`;
      if (modelId.endsWith(suffix)) {
        suffixEffort = level;
        modelId = modelId.slice(0, -suffix.length);
        break;
      }
    }
    if (suffixEffort && typeof out.model === "string") {
      out.model = modelId;
    }
    const isDenied = REASONING_DENIED.some((id) => modelId.includes(id));
    const isAllowed = REASONING_ALLOWED.some((id) => modelId.includes(id));
    if (isDenied) {
      delete out.reasoning_effort;
    } else if (isAllowed) {
      const effort = suffixEffort || out.reasoning_effort;
      if (effort) out.reasoning_effort = effort;
    }
    return out;
  }
}
var xai_default = XaiExecutor;
export {
  XaiExecutor,
  xai_default as default
};
