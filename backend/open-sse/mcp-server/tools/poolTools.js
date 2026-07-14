import { z } from "zod";
import { PoolRegistry } from "../../services/sessionPool/poolRegistry.ts";
import { getWebSessionPoolHealth } from "../../services/webSessionPoolHealth.ts";
import { getBrowserPoolMetrics } from "../../services/browserPool.ts";
const poolStatusInput = z.object({
  provider: z.string().optional().describe("Provider name (e.g. 'pollinations'). Omit to list all pools")
});
const poolSessionsInput = z.object({
  provider: z.string().describe("Provider name (e.g. 'pollinations')")
});
const poolResetInput = z.object({
  provider: z.string().describe("Provider name (e.g. 'pollinations')")
});
const poolWarmInput = z.object({
  provider: z.string().describe("Provider name (e.g. 'pollinations')"),
  count: z.number().int().min(1).max(50).default(6).describe("Target session count (1\u201350)")
});
const poolHealthInput = z.object({
  provider: z.string().optional().describe("Provider name (e.g. 'pollinations'). Omit to list all pools")
});
async function handlePoolStatus(args) {
  if (args.provider) {
    const stats = PoolRegistry.getStats(args.provider);
    if (!stats) {
      return { error: `No pool found for provider '${args.provider}'` };
    }
    return { provider: args.provider, stats };
  }
  const all = PoolRegistry.getAllStats();
  return {
    totalPools: all.length,
    providers: PoolRegistry.listProviders(),
    pools: all
  };
}
async function handlePoolSessions(args) {
  const details = PoolRegistry.getSessionDetails(args.provider);
  if (!details) {
    return { error: `No pool found for provider '${args.provider}'` };
  }
  const stats = PoolRegistry.getStats(args.provider);
  return {
    provider: args.provider,
    sessionCount: details.length,
    stats,
    sessions: details
  };
}
async function handlePoolReset(args) {
  const existed = PoolRegistry.resetPool(args.provider);
  return {
    provider: args.provider,
    reset: existed,
    message: existed ? `Pool '${args.provider}' shut down and removed. It will be recreated on next request.` : `No pool found for provider '${args.provider}'`
  };
}
async function handlePoolWarm(args) {
  const pool = PoolRegistry.getPool(args.provider);
  if (!pool) {
    return { error: `No pool found for provider '${args.provider}'` };
  }
  const before = pool.totalCount;
  await pool.warmUp(args.count);
  const after = pool.totalCount;
  return {
    provider: args.provider,
    targetCount: args.count,
    sessionsBefore: before,
    sessionsAfter: after,
    created: after - before
  };
}
async function handlePoolHealth(args) {
  const report = getWebSessionPoolHealth(args.provider);
  return report;
}
const browserPoolStatusInput = z.object({});
async function handleBrowserPoolStatus() {
  return getBrowserPoolMetrics();
}
const poolTools = {
  omniroute_pool_status: {
    name: "omniroute_pool_status",
    description: "Returns session pool status for a specific provider or all providers. Includes session counts by state (active/cooldown/dead), request totals, success rate, and throughput.",
    scopes: ["read:health"],
    inputSchema: poolStatusInput,
    handler: (args) => handlePoolStatus(args)
  },
  omniroute_pool_sessions: {
    name: "omniroute_pool_sessions",
    description: "Lists all sessions in a provider's pool with per-session details: fingerprint, status, request counts, inflight, cooldown remaining, and age.",
    scopes: ["read:health"],
    inputSchema: poolSessionsInput,
    handler: (args) => handlePoolSessions(args)
  },
  omniroute_pool_reset: {
    name: "omniroute_pool_reset",
    description: "Shuts down and removes all sessions for a provider's pool. A new pool will be created automatically on the next request.",
    scopes: ["write:resilience"],
    inputSchema: poolResetInput,
    handler: (args) => handlePoolReset(args)
  },
  omniroute_pool_warm: {
    name: "omniroute_pool_warm",
    description: "Warms a session pool to the specified session count (1\u201350). Sessions beyond the current count are created with fresh browser fingerprints.",
    scopes: ["write:resilience"],
    inputSchema: poolWarmInput,
    handler: (args) => handlePoolWarm(args)
  },
  omniroute_pool_health: {
    name: "omniroute_pool_health",
    description: "Returns aggregated web-session pool health: pool stats + circuit breaker state + per-session details + health status (healthy/degraded/down) + issues list.",
    scopes: ["read:health"],
    inputSchema: poolHealthInput,
    handler: (args) => handlePoolHealth(args)
  },
  omniroute_browser_pool_status: {
    name: "omniroute_browser_pool_status",
    description: "Returns the stealth browser pool's live status (enabled, active contexts, browser running, stealth available, idle age) plus cumulative lifecycle telemetry: browser launches/failures, context create/reuse/evict/release counts, context-create failures, and shutdowns with the last reason.",
    scopes: ["read:health"],
    inputSchema: browserPoolStatusInput,
    handler: () => handleBrowserPoolStatus()
  }
};
export {
  browserPoolStatusInput,
  handleBrowserPoolStatus,
  handlePoolHealth,
  handlePoolReset,
  handlePoolSessions,
  handlePoolStatus,
  handlePoolWarm,
  poolHealthInput,
  poolResetInput,
  poolSessionsInput,
  poolStatusInput,
  poolTools,
  poolWarmInput
};
