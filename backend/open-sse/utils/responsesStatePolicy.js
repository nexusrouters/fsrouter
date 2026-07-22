import { isOpenAIResponsesStoreEnabled } from '../../lib/providers/requestDefaults.js';
import {
  DEFAULT_RESPONSES_PREVIOUS_RESPONSE_ID_MODE,
  RESPONSES_PREVIOUS_RESPONSE_ID_MODES
} from '../../dist/shared/constants/responsesPreviousResponseId.js';
import { FORMATS } from "../translator/formats.ts";
const MODE_SET = new Set(RESPONSES_PREVIOUS_RESPONSE_ID_MODES);
function toRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function normalizeResponsesPreviousResponseIdMode(value) {
  if (typeof value === "string" && MODE_SET.has(value)) {
    return value;
  }
  return DEFAULT_RESPONSES_PREVIOUS_RESPONSE_ID_MODE;
}
function shouldStripPreviousResponseId({
  mode,
  sourceFormat,
  targetFormat,
  credentials
}) {
  const normalizedMode = normalizeResponsesPreviousResponseIdMode(mode);
  if (normalizedMode === "preserve") return false;
  if (normalizedMode === "strip") return true;
  const isResponsesSource = sourceFormat === FORMATS.OPENAI_RESPONSES;
  const isResponsesTarget = targetFormat === FORMATS.OPENAI_RESPONSES;
  if (!isResponsesSource && !isResponsesTarget) return false;
  const providerSpecificData = toRecord(toRecord(credentials).providerSpecificData);
  return !isOpenAIResponsesStoreEnabled(providerSpecificData);
}
function applyResponsesPreviousResponseIdPolicy(body, options) {
  const mode = normalizeResponsesPreviousResponseIdMode(options.mode);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { body, stripped: false, mode };
  }
  const record = body;
  if (!Object.hasOwn(record, "previous_response_id")) {
    return { body, stripped: false, mode };
  }
  if (!shouldStripPreviousResponseId({ ...options, mode })) {
    return { body, stripped: false, mode };
  }
  const next = { ...record };
  delete next.previous_response_id;
  return { body: next, stripped: true, mode };
}
export {
  applyResponsesPreviousResponseIdPolicy,
  normalizeResponsesPreviousResponseIdMode,
  shouldStripPreviousResponseId
};
