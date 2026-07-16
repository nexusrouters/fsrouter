import { createHash } from "node:crypto";
import { computeHeadroom } from "./headroomRanking.ts";
const STICKINESS_HEADROOM_THRESHOLD = 0.15;
const TTL_MS = 15 * 60 * 1e3;
const MAX_ENTRIES = 500;
let _fetcherOverride = null;
function __setStickinessHeadroomFetcherForTests(fetcher) {
  _fetcherOverride = fetcher;
}
async function resolveSaturation(connectionId, provider) {
  if (_fetcherOverride) return _fetcherOverride(connectionId);
  try {
    const mod = await import('../../dist/lib/quota/saturationSignals.js');
    const getSaturation = mod.getSaturation;
    const [util5h, util7d] = await Promise.all([
      getSaturation(connectionId, provider, { unit: "percent", window: "5h" }),
      getSaturation(connectionId, provider, { unit: "percent", window: "weekly" })
    ]);
    return { util5h, util7d };
  } catch {
    return void 0;
  }
}
const stickyMap = /* @__PURE__ */ new Map();
function deriveMessageHash(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const first = messages.find((m) => m?.role === "user");
  if (!first) return null;
  let text;
  if (typeof first.content === "string") {
    text = first.content;
  } else if (Array.isArray(first.content)) {
    text = first.content.filter((p) => p != null && typeof p === "object").map((p) => typeof p.text === "string" ? p.text : "").join("");
  } else {
    return null;
  }
  if (!text) return null;
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
function evict() {
  const now = Date.now();
  for (const [key, entry] of stickyMap) {
    if (now - entry.lastUsedAt > TTL_MS) stickyMap.delete(key);
  }
  while (stickyMap.size > MAX_ENTRIES) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, entry] of stickyMap) {
      if (entry.lastUsedAt < oldestTime) {
        oldestTime = entry.lastUsedAt;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    stickyMap.delete(oldestKey);
  }
}
function recordStickyBinding(messageHash, connectionId) {
  const existing = stickyMap.get(messageHash);
  if (existing) {
    existing.connectionId = connectionId;
    existing.lastUsedAt = Date.now();
  } else {
    evict();
    stickyMap.set(messageHash, {
      connectionId,
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    });
  }
}
function clearStickyBinding(messageHash) {
  stickyMap.delete(messageHash);
}
function clearAllStickyBindings() {
  stickyMap.clear();
}
function resolveDisableSessionStickiness(config, settings) {
  const perCombo = config?.disableSessionStickiness;
  if (typeof perCombo === "boolean") return perCombo;
  return settings?.disableSessionStickiness === true;
}
async function applySessionStickiness(orderedTargets, messages) {
  const noOp = { targets: orderedTargets, messageHash: null, stuck: false };
  try {
    if (orderedTargets.length <= 1) return noOp;
    const messageHash = deriveMessageHash(messages);
    if (!messageHash) return noOp;
    const existing = stickyMap.get(messageHash);
    if (!existing) return { targets: orderedTargets, messageHash, stuck: false };
    if (Date.now() - existing.lastUsedAt > TTL_MS) {
      stickyMap.delete(messageHash);
      return { targets: orderedTargets, messageHash, stuck: false };
    }
    const { connectionId } = existing;
    const stickyIdx = orderedTargets.findIndex((t) => t.connectionId === connectionId);
    if (stickyIdx === -1) {
      clearStickyBinding(messageHash);
      return { targets: orderedTargets, messageHash, stuck: false };
    }
    const stickyTarget = orderedTargets[stickyIdx];
    const sat = await resolveSaturation(connectionId, stickyTarget.provider);
    const headroom = computeHeadroom(sat);
    if (headroom <= STICKINESS_HEADROOM_THRESHOLD) {
      clearStickyBinding(messageHash);
      return { targets: orderedTargets, messageHash, stuck: false };
    }
    const reordered = [
      orderedTargets[stickyIdx],
      ...orderedTargets.slice(0, stickyIdx),
      ...orderedTargets.slice(stickyIdx + 1)
    ];
    existing.lastUsedAt = Date.now();
    return { targets: reordered, messageHash, stuck: true };
  } catch {
    return noOp;
  }
}
export {
  STICKINESS_HEADROOM_THRESHOLD,
  __setStickinessHeadroomFetcherForTests,
  applySessionStickiness,
  clearAllStickyBindings,
  clearStickyBinding,
  deriveMessageHash,
  recordStickyBinding,
  resolveDisableSessionStickiness
};
