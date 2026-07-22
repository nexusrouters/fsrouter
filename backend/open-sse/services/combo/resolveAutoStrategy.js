import { unavailableResponse } from "../../utils/error.ts";
import { selectProvider as selectAutoProvider } from "../autoCombo/engine.ts";
import {
  resolveRequestModePack,
  parseRequestBudgetCap
} from "../autoCombo/requestControls.ts";
import { selectWithStrategy } from "../autoCombo/routerStrategy.ts";
import { buildComplexityRoutingHint } from "../autoCombo/complexityRouter";
import { recordComboIntent } from "../comboMetrics.ts";
import { estimateTokens } from "../contextManager.ts";
import { classifyWithConfig } from "../intentClassifier.ts";
import { parseModel } from "../model.ts";
import { supportsToolCalling } from "../modelCapabilities.ts";
import { parseAutoConfig } from "./autoConfig.ts";
import { dedupeTargetsByExecutionKey } from "./comboData.ts";
import { getModelContextLimitForModelString } from "./comboStructure.ts";
import {
  _registerExecutionCandidates,
  expandAutoComboCandidatePool,
  extractPromptForIntent,
  getIntentConfig,
  mapIntentToTaskType,
  scoreAutoTargets
} from "./autoStrategy.ts";
async function resolveAutoStrategyOrder(deps) {
  const {
    body,
    combo,
    settings,
    config,
    relayOptions,
    resilienceSettings,
    log,
    buildAutoCandidates
  } = deps;
  let orderedTargets = deps.orderedTargets;
  let autoUsedExplicitRouter = false;
  const requestHasTools = Array.isArray(body?.tools) && body.tools.length > 0;
  let eligibleTargets = [...orderedTargets];
  if (requestHasTools) {
    const filtered = eligibleTargets.filter((target) => supportsToolCalling(target.modelStr));
    if (filtered.length > 0) {
      eligibleTargets = filtered;
    } else {
      log.warn(
        "COMBO",
        "Auto strategy: all candidates filtered by tool-calling policy, falling back to full pool"
      );
    }
  }
  const requestMessages = body.messages;
  const estimatedInputTokens = estimateTokens(
    typeof requestMessages === "string" || requestMessages !== null && typeof requestMessages === "object" ? requestMessages : []
  );
  if (estimatedInputTokens > 0) {
    const filteredByContext = eligibleTargets.filter((target) => {
      const limit = getModelContextLimitForModelString(target.modelStr);
      if (limit === null || limit === void 0) return true;
      return limit >= estimatedInputTokens;
    });
    if (filteredByContext.length > 0) {
      log.debug?.(
        "COMBO",
        `Auto strategy: context-window filter kept ${filteredByContext.length}/${eligibleTargets.length} candidates (est. ${estimatedInputTokens} tokens)`
      );
      eligibleTargets = filteredByContext;
    } else {
      log.warn(
        "COMBO",
        `Auto strategy: all candidates filtered by context-window policy (est. ${estimatedInputTokens} tokens), falling back to full pool`
      );
    }
    eligibleTargets = await expandAutoComboCandidatePool(eligibleTargets, combo);
  }
  const prompt = extractPromptForIntent(body);
  const systemPrompt = typeof combo?.system_message === "string" ? combo.system_message : void 0;
  const intentConfig = getIntentConfig(settings, combo);
  const intent = classifyWithConfig(prompt, intentConfig, systemPrompt);
  recordComboIntent(combo.name, intent);
  const taskType = mapIntentToTaskType(intent);
  const {
    routingStrategy,
    candidatePool,
    weights,
    explorationRate,
    budgetCap: configBudgetCap,
    modePack: configModePack,
    resetWindowConfig,
    slaPolicy
  } = parseAutoConfig(combo, eligibleTargets);
  const requestBudgetCap = parseRequestBudgetCap(relayOptions?.budgetCap);
  const budgetCap = requestBudgetCap ?? configBudgetCap;
  const requestModePack = resolveRequestModePack(relayOptions?.mode);
  const modePack = requestModePack.override ? requestModePack.modePack : configModePack;
  if (requestModePack.override || requestBudgetCap !== void 0) {
    log.debug?.(
      "COMBO",
      `Auto strategy: per-request controls applied (mode=${requestModePack.override ? requestModePack.modePack ?? "balanced" : "\u2014"}, budgetCap=${requestBudgetCap ?? "\u2014"})`
    );
  }
  let lastKnownGoodProvider;
  try {
    const { getLKGP } = await import('../../../lib/localDb.js');
    const lkgp = await getLKGP(combo.name, combo.id || combo.name);
    if (lkgp) lastKnownGoodProvider = lkgp.provider;
  } catch (err) {
    log.warn("COMBO", "Failed to retrieve Last Known Good Provider. This is non-fatal.", { err });
  }
  const autoCandidateResilienceSettings = relayOptions?.bypassProviderQuotaPolicy === true ? {
    ...resilienceSettings,
    quotaPreflight: {
      ...resilienceSettings.quotaPreflight,
      enabled: false
    }
  } : resilienceSettings;
  const candidates = await buildAutoCandidates(
    eligibleTargets,
    combo.name,
    relayOptions?.sessionId,
    resetWindowConfig,
    autoCandidateResilienceSettings
  );
  const routableCandidates = candidates.filter(
    (candidate) => candidate.quotaCutoffBlocked !== true
  );
  const quotaBlockedCount = candidates.length - routableCandidates.length;
  if (quotaBlockedCount > 0) {
    log.info(
      "COMBO",
      `Auto strategy: quota cutoff skipped ${quotaBlockedCount}/${candidates.length} account candidates`
    );
  }
  _registerExecutionCandidates(routableCandidates);
  if (candidates.length > 0 && routableCandidates.length === 0) {
    return {
      earlyResponse: unavailableResponse(
        429,
        "All auto strategy candidates are below configured quota cutoffs"
      )
    };
  }
  if (routableCandidates.length > 0) {
    let selectedProvider = null;
    let selectedModel = null;
    let selectionReason = "";
    if (routingStrategy !== "rules") {
      try {
        const decision = selectWithStrategy(
          routableCandidates,
          {
            taskType,
            requestHasTools,
            lastKnownGoodProvider,
            estimatedInputTokens,
            sla: slaPolicy
          },
          routingStrategy
        );
        selectedProvider = decision.provider;
        selectedModel = decision.model;
        selectionReason = decision.reason;
        autoUsedExplicitRouter = true;
      } catch (err) {
        log.warn(
          "COMBO",
          `Auto strategy '${routingStrategy}' failed (${err?.message || "unknown"}), falling back to rules`
        );
      }
    }
    if (!selectedProvider || !selectedModel) {
      const selection = selectAutoProvider(
        {
          id: combo.id || combo.name,
          name: combo.name,
          type: "auto",
          candidatePool,
          weights,
          modePack,
          budgetCap,
          explorationRate
        },
        routableCandidates,
        taskType
      );
      selectedProvider = selection.provider;
      selectedModel = selection.model;
      selectionReason = `score=${selection.score.toFixed(3)}${selection.isExploration ? " (exploration)" : ""}`;
    }
    const autoManifestHint = config.complexityAwareRouting === true ? buildComplexityRoutingHint(
      eligibleTargets.filter((t) => t.kind === "model"),
      body,
      log
    ) : null;
    const scoredTargets = scoreAutoTargets(
      eligibleTargets,
      routableCandidates,
      taskType,
      weights,
      autoManifestHint
    );
    const rankedTargets = scoredTargets.map((entry) => entry.target);
    const selectedTarget = scoredTargets.find((entry) => {
      const parsed = parseModel(entry.target.modelStr);
      const modelId = parsed.model || entry.target.modelStr;
      return entry.target.provider === selectedProvider && modelId === selectedModel;
    })?.target || rankedTargets[0] || eligibleTargets[0];
    if (!selectedTarget) {
      return {
        earlyResponse: unavailableResponse(
          429,
          "No auto strategy targets remained after quota cutoff filtering"
        )
      };
    }
    orderedTargets = dedupeTargetsByExecutionKey(
      [selectedTarget, ...rankedTargets, ...eligibleTargets].filter(
        (entry) => entry !== void 0 && entry !== null
      )
    );
    log.info(
      "COMBO",
      `Auto selection: ${selectedTarget?.modelStr || `${selectedProvider}/${selectedModel}`} | intent=${intent} task=${taskType} | strategy=${routingStrategy} | ${selectionReason}`
    );
  } else {
    log.warn("COMBO", "Auto strategy has no candidates, keeping default ordering");
  }
  return { orderedTargets, autoUsedExplicitRouter };
}
export {
  resolveAutoStrategyOrder
};
