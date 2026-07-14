import {
  classifyErrorText,
  hasPerModelQuota,
  isProviderExhaustedReason
} from "../accountFallback.ts";
import { RateLimitReason } from "../../config/constants.ts";
import { isProviderCircuitOpenResult } from "./comboPredicates.ts";
const CONNECTION_LEVEL_ERROR_STATUSES = [408, 500, 502, 503, 504, 524];
function isEmptyContentFailure(status, errorText) {
  return status === 502 && /empty content/i.test(errorText);
}
function applyComboTargetExhaustion(target, opts) {
  const {
    result,
    fallbackResult,
    errorText,
    rawModel,
    isTokenLimitBreach,
    allAccountsRateLimited,
    sets,
    log,
    tag,
    exhaustedLogLevel,
    structuredError
  } = opts;
  const { exhaustedProviders, exhaustedConnections, transientRateLimitedProviders } = sets;
  const provider = target.provider;
  const providerExhausted = Boolean(provider && provider !== "unknown") && !hasPerModelQuota(provider, rawModel) && (isProviderExhaustedReason(fallbackResult) || classifyErrorText(structuredError?.code || errorText) === RateLimitReason.QUOTA_EXHAUSTED || allAccountsRateLimited);
  if (providerExhausted) {
    exhaustedProviders.add(provider);
    const emit = exhaustedLogLevel === "debug" ? log.debug : log.info;
    emit?.(
      tag,
      `Provider ${provider} quota exhausted \u2014 marking for skip on remaining targets (#1731)`
    );
  } else {
    if (result.status === 429 && !isTokenLimitBreach && provider && provider !== "unknown") {
      transientRateLimitedProviders.add(provider);
    }
    markConnectionLevelExhaustion(target, { result, errorText, sets, log, tag, rawModel });
  }
  return providerExhausted;
}
function markConnectionLevelExhaustion(target, opts) {
  const { result, errorText, sets, log, tag, rawModel } = opts;
  const provider = target.provider;
  if (!provider || provider === "unknown" || !CONNECTION_LEVEL_ERROR_STATUSES.includes(result.status) || isProviderCircuitOpenResult(result, errorText) || // #5085: empty-content 502 is a healthy connection returning no body — model-level, not
  // connection-level. Don't exhaust the provider; let the remaining legs (incl. same-provider)
  // be tried in-request.
  isEmptyContentFailure(result.status, errorText) || // Per-model-quota providers (gemini, github, passthrough, compatible) multiplex models
  // behind one connection. A model-level 500 (e.g. Gemini "Internal error encountered")
  // must NOT exhaust the connection — other models on the same connection may still succeed.
  // Other connection-level statuses (408/502/503/504/524) indicate the connection itself is
  // bad, so they correctly exhaust even for per-model-quota providers.
  result.status === 500 && hasPerModelQuota(provider, rawModel)) {
    return;
  }
  const connId = target.connectionId ?? void 0;
  if (connId) {
    sets.exhaustedConnections.add(`${provider}:${connId}`);
    log.info(
      tag,
      `Provider ${provider} connection ${connId} error (${result.status}) \u2014 marking for skip on remaining targets (#1731v2)`
    );
  } else {
    sets.exhaustedProviders.add(provider);
    log.info(
      tag,
      `Provider ${provider} connection error (${result.status}) \u2014 marking for skip on remaining targets (#1731)`
    );
  }
}
export {
  applyComboTargetExhaustion
};
