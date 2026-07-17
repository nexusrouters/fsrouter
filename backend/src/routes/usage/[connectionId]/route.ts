// Ensure proxyFetch is loaded to patch globalThis.fetch
import '../../../../open-sse/index.js';

import { getProviderConnectionById, updateProviderConnection } from "../../../lib/localDb.js";
import { getUsageForProvider } from "../../../open-sse/services/usage.js"; // Watcher trigger comment
import { getExecutor } from "../../../open-sse/executors/index.js";
import { resolveConnectionProxyConfig } from "../../../lib/network/connectionProxy.js";
import { USAGE_APIKEY_PROVIDERS } from "../../../shared/constants/providers.js";

// Detect auth-expired messages returned by usage providers instead of throwing
const AUTH_EXPIRED_PATTERNS = ["expired", "authentication", "unauthorized", "401", "re-authorize"];
function isAuthExpiredMessage(usage) {
  if (!usage?.message) return false;
  const msg = usage.message.toLowerCase();
  return AUTH_EXPIRED_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Refresh credentials using executor and update database
 * @param {boolean} force - Skip needsRefresh check and always attempt refresh
 * @returns Promise<{ connection, refreshed }>
 */
async function refreshAndUpdateCredentials(connection, force = false, proxyOptions = null) {
  const executor = getExecutor(connection.provider);

  // Build credentials object from connection
  const credentials = {
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    idToken: connection.idToken,
    expiresAt: connection.expiresAt || connection.tokenExpiresAt,
    lastRefreshAt: connection.lastRefreshAt,
    connectionId: connection.id,
    providerSpecificData: connection.providerSpecificData,
    // For GitHub
    copilotToken: connection.providerSpecificData?.copilotToken,
    copilotTokenExpiresAt: connection.providerSpecificData?.copilotTokenExpiresAt,
    apiKey: connection.apiKey,
    cookie: connection.apiKey || connection.cookie || connection.providerSpecificData?.cookie,
  };

  // Check if refresh is needed (skip when force=true)
  const needsRefresh = force || executor.needsRefresh(credentials);

  if (!needsRefresh) {
    return { connection, refreshed: false };
  }

  // Use executor's refreshCredentials method (with optional proxy)
  const refreshResult = await executor.refreshCredentials(credentials, console, proxyOptions);

  if (!refreshResult) {
    // Refresh failed but we still have an accessToken — try with existing token
    if (connection.accessToken) {
      return { connection, refreshed: false };
    }
    throw new Error("Failed to refresh credentials. Please re-authorize the connection.");
  }

  // Build update object
  const now = new Date().toISOString();
  const updateData = {
    updatedAt: now,
  };

  // Update accessToken if present
  if (refreshResult.accessToken) {
    updateData.accessToken = refreshResult.accessToken;
  }

  // Update refreshToken if present
  if (refreshResult.refreshToken) {
    updateData.refreshToken = refreshResult.refreshToken;
  }

  if (refreshResult.idToken) {
    updateData.idToken = refreshResult.idToken;
  }

  if (refreshResult.lastRefreshAt) {
    updateData.lastRefreshAt = refreshResult.lastRefreshAt;
  }

  // Update token expiry
  if (refreshResult.expiresIn) {
    updateData.expiresAt = new Date(Date.now() + refreshResult.expiresIn * 1000).toISOString();
    updateData.expiresIn = refreshResult.expiresIn;
  } else if (refreshResult.expiresAt) {
    updateData.expiresAt = refreshResult.expiresAt;
  }

  // Handle provider-specific data (copilotToken for GitHub, etc.)
  const providerSpecificUpdates = {
    ...(refreshResult.providerSpecificData || {}),
    ...(refreshResult.copilotToken ? { copilotToken: refreshResult.copilotToken } : {}),
    ...(refreshResult.copilotTokenExpiresAt ? { copilotTokenExpiresAt: refreshResult.copilotTokenExpiresAt } : {}),
  };
  if (Object.keys(providerSpecificUpdates).length > 0) {
    updateData.providerSpecificData = {
      ...(connection.providerSpecificData || {}),
      ...providerSpecificUpdates,
    };
  }

  // Update database
  await updateProviderConnection(connection.id, updateData);

  // Return updated connection
  const updatedConnection = {
    ...connection,
    ...updateData,
    providerSpecificData: updateData.providerSpecificData || connection.providerSpecificData,
  };

  return {
    connection: updatedConnection,
    refreshed: true,
  };
}

/**
 * GET /api/usage/[connectionId] - Get usage data for a specific connection
 */
export async function GET_handler(req, res, { params }) {
  let connection;
  try {
    const { connectionId } = await params;


    // Get connection from database
    connection = await getProviderConnectionById(connectionId);
    if (!connection) {
      return Response.json({ error: "Connection not found" }, { status: 404 });
    }

    // Allow OAuth/cookie connections, plus whitelisted apikey providers (glm/minimax/...)
    const isOAuth = connection.authType === "oauth";
    const isCookie = connection.authType === "cookie";
    const isApikeyEligible =
      connection.authType === "apikey" &&
      USAGE_APIKEY_PROVIDERS.includes(connection.provider);

    if (!isOAuth && !isCookie && !isApikeyEligible) {
      return Response.json({ message: "Usage not available for this connection" });
    }

    // Resolve connection proxy config; force strictProxy=false so quota/refresh fall back to direct on failure
    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    };

    // Refresh credentials for OAuth or cookie-based connections (since they have token refresh)
    if (isOAuth || isCookie) {
      try {
        const result = await refreshAndUpdateCredentials(connection, false, proxyOptions);
        connection = result.connection;
      } catch (refreshError) {
        console.error("[Usage API] Credential refresh failed:", refreshError);
        return Response.json({
          error: `Credential refresh failed: ${refreshError.message}`
        }, { status: 401 });
      }
    }

    // Fetch usage from provider API
    let usage = await getUsageForProvider(connection, proxyOptions);

    // Intercept cloudflare-ai usage to inject real neuron count from database
    if (connection.provider === "cloudflare-ai") {
      try {
        const { getAdapter } = await import("../../../lib/db/driver.js");
        const db = await getAdapter();
        // Sum neurons since start of day UTC for this connectionId
        const rows = db.all(
          `SELECT model, promptTokens, completionTokens FROM usageHistory 
           WHERE provider = 'cloudflare-ai' 
             AND connectionId = ? 
             AND status = 'ok' 
             AND timestamp >= (date('now', 'start of day') || 'T00:00:00.000Z')`,
          [connection.id]
        );
        let totalNeurons = 0;
        for (const row of rows) {
          const modelLower = (row.model || "").toLowerCase();
          let neurons = 0;
          if (modelLower.includes("flux-2-dev")) {
            neurons = 2500;
          } else if (modelLower.includes("flux-1-schnell") || modelLower.includes("flux")) {
            neurons = 1500;
          } else if (modelLower.includes("xl") || modelLower.includes("phoenix") || modelLower.includes("stable-diffusion")) {
            neurons = 1000;
          } else if (modelLower.includes("dreamshaper") || modelLower.includes("lightning") || modelLower.includes("image") || modelLower.includes("draw")) {
            neurons = 200;
          } else if (modelLower.includes("whisper")) {
            neurons = 10;
          } else if (modelLower.includes("speech") || modelLower.includes("tts")) {
            neurons = 5;
          } else {
            const totalTokens = (row.promptTokens || 0) + (row.completionTokens || 0);
            if (modelLower.includes("70b") || modelLower.includes("72b") || modelLower.includes("large")) {
              neurons = totalTokens * 0.00077;
            } else {
              neurons = totalTokens * 0.000077;
            }
          }
          totalNeurons += neurons;
        }
        
        totalNeurons = Math.round(totalNeurons);

        const nextReset = new Date();
        nextReset.setUTCHours(24, 0, 0, 0); // Next 00:00 UTC
        const resetAt = nextReset.toISOString();
        
        if (usage && usage.quotas && usage.quotas.neurons) {
          usage.quotas.neurons.used = totalNeurons;
          usage.quotas.neurons.remaining = Math.max(0, usage.quotas.neurons.total - totalNeurons);
          usage.quotas.neurons.remainingPercentage = (usage.quotas.neurons.remaining / usage.quotas.neurons.total) * 100;
          usage.quotas.neurons.resetAt = resetAt; // Inject dynamic countdown time!
        }
      } catch (dbError) {
        console.error("[Usage API] Failed to calculate real cloudflare-ai neurons:", dbError);
      }
    }

    // If provider returned an auth-expired message instead of throwing,
    // force-refresh token and retry once (OAuth or cookie)
    if ((isOAuth && connection.refreshToken || isCookie) && isAuthExpiredMessage(usage)) {
      try {
        const retryResult = await refreshAndUpdateCredentials(connection, true, proxyOptions);
        connection = retryResult.connection;
        usage = await getUsageForProvider(connection, proxyOptions);
      } catch (retryError) {
        console.warn(`[Usage] ${connection.provider}: force refresh failed: ${retryError.message}`);
      }
    }

    return Response.json(usage);
  } catch (error) {
    const provider = connection?.provider ?? "unknown";
    console.warn(`[Usage] ${provider}: ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
