import { logToolCall } from "../audit.ts";
import {
  getCompressionSettings,
  updateCompressionSettings
} from "../../../src/lib/db/compression.ts";
import { getCompressionAnalyticsSummary } from "../../../src/lib/db/compressionAnalytics.ts";
import { getCacheStatsSummary } from "../../../src/lib/db/compressionCacheStats.ts";
import { listCompressionCombos } from "../../../src/lib/db/compressionCombos.ts";
import {
  getMcpDescriptionCompressionStats,
  snapshotMcpDescriptionCompressionStats
} from "../descriptionCompressor.ts";
async function handleCompressionStatus(args, extra) {
  const start = Date.now();
  try {
    const settings = await getCompressionSettings();
    await snapshotMcpDescriptionCompressionStats();
    const analyticsSummary = getCompressionAnalyticsSummary();
    const mcpDescriptionStats = getMcpDescriptionCompressionStats();
    const cacheStats = getCacheStatsSummary();
    const result = {
      enabled: settings.enabled,
      strategy: settings.defaultMode || "standard",
      settings: {
        maxTokens: settings.autoTriggerTokens,
        autoTriggerMode: settings.autoTriggerMode ?? "lite",
        targetRatio: 0.7,
        // Default target ratio
        preserveSystemPrompt: settings.preserveSystemPrompt,
        mcpDescriptionCompressionEnabled: settings.mcpDescriptionCompressionEnabled !== false
      },
      analytics: {
        totalRequests: analyticsSummary.totalRequests,
        compressedRequests: Object.values(analyticsSummary.byMode ?? {}).reduce(
          (sum, mode) => sum + mode.count,
          0
        ),
        tokensSaved: analyticsSummary.totalTokensSaved,
        avgCompressionRatio: analyticsSummary.avgSavingsPct,
        byMode: analyticsSummary.byMode ?? {},
        byEngine: analyticsSummary.byEngine ?? {},
        byCompressionCombo: analyticsSummary.byCompressionCombo ?? {},
        validationFallbacks: analyticsSummary.validationFallbacks,
        requestsWithReceipts: analyticsSummary.realUsage.requestsWithReceipts,
        realUsage: analyticsSummary.realUsage,
        mcpDescriptionCompression: {
          descriptionsCompressed: mcpDescriptionStats.descriptionsCompressed,
          charsBefore: mcpDescriptionStats.charsBefore,
          charsAfter: mcpDescriptionStats.charsAfter,
          charsSaved: mcpDescriptionStats.charsSaved,
          estimatedTokensSaved: mcpDescriptionStats.estimatedTokensSaved,
          persistedEstimatedTokensSaved: analyticsSummary.mcpDescriptionCompression.estimatedTokensSaved,
          persistedSnapshots: analyticsSummary.mcpDescriptionCompression.snapshots,
          source: "mcp_metadata_estimate",
          notProviderUsage: true
        }
      },
      cacheStats: cacheStats ? {
        hits: Math.round(cacheStats.cacheHitRate * (cacheStats.totalRequests || 1)),
        misses: Math.round((1 - cacheStats.cacheHitRate) * (cacheStats.totalRequests || 1)),
        hitRate: `${(cacheStats.cacheHitRate * 100).toFixed(2)}%`,
        tokensSaved: Math.round(cacheStats.avgNetSavings)
      } : null
    };
    const duration = Date.now() - start;
    await logToolCall("omniroute_compression_status", args, result, duration, true);
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    const errorMessage = error instanceof Error ? error.message : String(error);
    await logToolCall(
      "omniroute_compression_status",
      args,
      { error: errorMessage },
      duration,
      false,
      "ERROR"
    );
    throw error;
  }
}
async function handleCompressionConfigure(args, extra) {
  const start = Date.now();
  try {
    const updates = {};
    if (args.enabled !== void 0) {
      updates.enabled = args.enabled;
    }
    if (args.strategy !== void 0) {
      updates.defaultMode = args.strategy;
    }
    if (args.autoTriggerMode !== void 0) {
      updates.autoTriggerMode = args.autoTriggerMode;
    }
    if (args.maxTokens !== void 0) {
      updates.autoTriggerTokens = args.maxTokens;
    }
    if (args.preserveSystemPrompt !== void 0) {
      updates.preserveSystemPrompt = args.preserveSystemPrompt;
    }
    if (args.mcpDescriptionCompressionEnabled !== void 0) {
      updates.mcpDescriptionCompressionEnabled = args.mcpDescriptionCompressionEnabled;
    }
    const settings = await updateCompressionSettings(updates);
    const result = {
      success: true,
      updated: updates,
      settings: {
        enabled: settings.enabled,
        strategy: settings.defaultMode || "standard",
        autoTriggerMode: settings.autoTriggerMode ?? "lite",
        maxTokens: settings.autoTriggerTokens,
        targetRatio: 0.7,
        // Default target ratio
        preserveSystemPrompt: settings.preserveSystemPrompt,
        mcpDescriptionCompressionEnabled: settings.mcpDescriptionCompressionEnabled !== false
      }
    };
    const duration = Date.now() - start;
    await logToolCall("omniroute_compression_configure", args, result, duration, true);
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    const errorMessage = error instanceof Error ? error.message : String(error);
    await logToolCall(
      "omniroute_compression_configure",
      args,
      { error: errorMessage },
      duration,
      false,
      "ERROR"
    );
    throw error;
  }
}
import { z } from "zod";
import {
  compressionStatusInput,
  compressionConfigureInput,
  setCompressionEngineInput,
  listCompressionCombosInput,
  compressionComboStatsInput
} from "../schemas/tools.ts";
import { handleCcrRetrieve } from "../../services/compression/engines/ccr/index.ts";
import {
  listRtkCommandSamples,
  discoverRepeatedNoise,
  suggestFilter,
  commandToId
} from "../../services/compression/engines/rtk/index.ts";
import { resolveCallerScopeContext } from "../scopeEnforcement.ts";
import { resolveMcpCallerApiKeyId } from "../mcpCallerIdentity.ts";
const ccrRetrieveInput = z.object({
  hash: z.string().min(6).max(64).describe("24-hex content hash from a [CCR retrieve hash=<hash>] marker"),
  mode: z.enum(["full", "head", "tail", "lines", "grep", "stats"]).optional().describe("Retrieval mode: full (default) | head | tail | lines | grep | stats"),
  n: z.number().int().positive().max(1e4).optional().describe("head/tail: number of lines"),
  start: z.number().int().positive().optional().describe("lines: 1-indexed inclusive start"),
  end: z.number().int().positive().optional().describe("lines: 1-indexed inclusive end"),
  pattern: z.string().max(512).optional().describe("grep: regex (validated safe; ReDoS-rejected)"),
  unique: z.boolean().optional().describe("grep: dedupe matching lines")
});
async function handleSetCompressionEngine(args) {
  const updates = { enabled: true };
  if (args.engine) {
    updates.defaultMode = args.engine === "caveman" ? "standard" : args.engine;
    if (args.engine === "off") updates.enabled = false;
  }
  if (args.cavemanIntensity) {
    const current = await getCompressionSettings();
    updates.cavemanConfig = {
      ...current.cavemanConfig ?? {},
      intensity: args.cavemanIntensity
    };
  }
  if (args.rtkIntensity) {
    const current = await getCompressionSettings();
    updates.rtkConfig = {
      ...current.rtkConfig ?? {},
      intensity: args.rtkIntensity
    };
  }
  if (args.outputMode !== void 0) {
    const current = await getCompressionSettings();
    updates.cavemanOutputMode = {
      ...current.cavemanOutputMode ?? {},
      enabled: args.outputMode
    };
  }
  const settings = await updateCompressionSettings(updates);
  return { success: true, settings };
}
async function handleListCompressionCombos() {
  return { combos: listCompressionCombos() };
}
async function handleCompressionComboStats(args) {
  const summary = getCompressionAnalyticsSummary(args.since === "all" ? void 0 : args.since);
  if (!args.comboId) return summary;
  return {
    comboId: args.comboId,
    summary,
    combo: summary.byCompressionCombo[args.comboId] ?? { count: 0, tokensSaved: 0 }
  };
}
const rtkDiscoverInput = z.object({
  limit: z.number().int().positive().max(2e3).optional().describe("Max samples to scan (default 500)")
});
const rtkLearnInput = z.object({
  command: z.string().min(1).max(500).describe("The command to learn an RTK filter draft for"),
  limit: z.number().int().positive().max(2e3).optional().describe("Max samples to scan (default 500)")
});
function resolveSampleLimit(limit) {
  if (!Number.isFinite(limit) || !limit || limit <= 0) return 500;
  return Math.min(2e3, Math.floor(limit));
}
async function handleRtkDiscover(args) {
  const start = Date.now();
  const samples = listRtkCommandSamples({ limit: resolveSampleLimit(args.limit) });
  const candidates = discoverRepeatedNoise(samples);
  const result = { sampleCount: samples.length, candidates };
  await logToolCall("omniroute_rtk_discover", args, result, Date.now() - start, true);
  return result;
}
async function handleRtkLearn(args) {
  const start = Date.now();
  const command = args.command.trim();
  const targetId = commandToId(command);
  const matching = listRtkCommandSamples({ limit: resolveSampleLimit(args.limit) }).filter(
    (sample) => commandToId(sample.command) === targetId
  );
  const filter = suggestFilter(command, matching);
  const result = { command, sampleCount: matching.length, filter };
  await logToolCall("omniroute_rtk_learn", args, result, Date.now() - start, true);
  return result;
}
const compressionTools = {
  omniroute_compression_status: {
    name: "omniroute_compression_status",
    description: "Returns current compression configuration, strategy, analytics summary (requests compressed, tokens saved, avg ratio), and provider-aware cache statistics.",
    scopes: ["read:compression"],
    inputSchema: compressionStatusInput,
    handler: (args) => handleCompressionStatus(args)
  },
  omniroute_compression_configure: {
    name: "omniroute_compression_configure",
    description: "Configure compression settings at runtime. Supports enabling/disabling compression, changing strategy (off/lite/standard/aggressive/ultra/rtk/stacked), adjusting maxTokens threshold, targetRatio, auto-trigger mode, system prompt preservation, and MCP description compression.",
    scopes: ["write:compression"],
    inputSchema: compressionConfigureInput,
    handler: (args) => handleCompressionConfigure(args)
  },
  omniroute_set_compression_engine: {
    name: "omniroute_set_compression_engine",
    description: "Set the active compression engine and Caveman/RTK runtime options.",
    scopes: ["write:compression"],
    inputSchema: setCompressionEngineInput,
    handler: (args) => handleSetCompressionEngine(args)
  },
  omniroute_list_compression_combos: {
    name: "omniroute_list_compression_combos",
    description: "List compression combos and their engine pipelines.",
    scopes: ["read:compression"],
    inputSchema: listCompressionCombosInput,
    handler: (_args) => handleListCompressionCombos()
  },
  omniroute_compression_combo_stats: {
    name: "omniroute_compression_combo_stats",
    description: "Get compression analytics grouped by engine and compression combo.",
    scopes: ["read:compression"],
    inputSchema: compressionComboStatsInput,
    handler: (args) => handleCompressionComboStats(args)
  },
  omniroute_ccr_retrieve: {
    name: "omniroute_ccr_retrieve",
    description: "Retrieve the verbatim content block stored by the CCR compression engine. When a large block is compressed, a marker `[CCR retrieve hash=<24hex> chars=N]` is inserted. Pass the hash from the marker to this tool to get the original text back. Optional `mode` (head/tail/lines/grep/stats) retrieves a slice or summary instead of the whole block; omit for the full block. Scope: read:compression. Always available (sticky-on).",
    scopes: ["read:compression"],
    inputSchema: ccrRetrieveInput,
    handler: async (args, extra) => {
      const apiKeyPrincipal = await resolveMcpCallerApiKeyId();
      if (apiKeyPrincipal) {
        return handleCcrRetrieve(args, apiKeyPrincipal);
      }
      const { callerId } = resolveCallerScopeContext(extra, ["read:compression"]);
      return handleCcrRetrieve(args, callerId === "anonymous" ? void 0 : callerId);
    }
  },
  omniroute_rtk_discover: {
    name: "omniroute_rtk_discover",
    description: "Mine the opt-in RTK raw-output sample store for recurring noise lines and return them as ranked candidates the operator can turn into strip/collapse filters. Read-only; suggestions only. Scope: read:compression.",
    scopes: ["read:compression"],
    inputSchema: rtkDiscoverInput,
    handler: (args) => handleRtkDiscover(args)
  },
  omniroute_rtk_learn: {
    name: "omniroute_rtk_learn",
    description: "Suggest an RTK filter draft for a specific command, learned from that command's captured outputs in the opt-in raw-output sample store. Read-only; returns a draft for the operator to review and save. Scope: read:compression.",
    scopes: ["read:compression"],
    inputSchema: rtkLearnInput,
    handler: (args) => handleRtkLearn(args)
  }
};
export {
  compressionTools,
  handleCompressionComboStats,
  handleCompressionConfigure,
  handleCompressionStatus,
  handleListCompressionCombos,
  handleRtkDiscover,
  handleRtkLearn,
  handleSetCompressionEngine
};
