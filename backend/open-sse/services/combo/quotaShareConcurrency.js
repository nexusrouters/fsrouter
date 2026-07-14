import * as semaphore from "../rateLimitSemaphore.ts";
function quotaShareConcurrencyKey(connectionId) {
  return `qsconn:${connectionId}`;
}
async function acquireQuotaShareConcurrencySlot(target, cap, opts, log) {
  const connectionId = target?.connectionId ?? "";
  if (!connectionId || cap === null || cap <= 0) return null;
  try {
    return await semaphore.acquire(quotaShareConcurrencyKey(connectionId), {
      maxConcurrency: cap,
      timeoutMs: opts.queueTimeoutMs,
      maxQueueSize: opts.maxQueueSize
    });
  } catch {
    log.warn(
      "COMBO",
      `Quota-share concurrency: connection ${connectionId} gate saturated (cap=${cap}) \u2014 proceeding without a slot`
    );
    return null;
  }
}
export {
  acquireQuotaShareConcurrencySlot,
  quotaShareConcurrencyKey
};
