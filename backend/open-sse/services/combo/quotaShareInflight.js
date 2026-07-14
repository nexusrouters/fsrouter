const DEFAULT_LEASE_MS = 12e4;
const _inflightMap = /* @__PURE__ */ new Map();
function incrementInflight(connectionId, leaseMs = DEFAULT_LEASE_MS, nowMs = Date.now()) {
  if (!connectionId) return 0;
  pruneExpired(nowMs);
  const slot = _inflightMap.get(connectionId);
  const base = slot && slot.expiresAtMs > nowMs ? slot.count : 0;
  const newCount = base + 1;
  _inflightMap.set(connectionId, { count: newCount, expiresAtMs: nowMs + leaseMs });
  return newCount;
}
function decrementInflight(connectionId, nowMs = Date.now()) {
  if (!connectionId) return;
  const slot = _inflightMap.get(connectionId);
  if (!slot || slot.expiresAtMs <= nowMs) {
    _inflightMap.delete(connectionId);
    return;
  }
  const newCount = Math.max(0, slot.count - 1);
  if (newCount === 0) {
    _inflightMap.delete(connectionId);
  } else {
    _inflightMap.set(connectionId, { count: newCount, expiresAtMs: slot.expiresAtMs });
  }
}
function getInflight(connectionId, nowMs = Date.now()) {
  if (!connectionId) return 0;
  const slot = _inflightMap.get(connectionId);
  if (!slot || slot.expiresAtMs <= nowMs) return 0;
  return slot.count;
}
function pruneExpired(nowMs) {
  for (const [key, slot] of _inflightMap) {
    if (slot.expiresAtMs <= nowMs) _inflightMap.delete(key);
  }
}
function _clearInflightForTest() {
  _inflightMap.clear();
}
function _inflightSizeForTest() {
  return _inflightMap.size;
}
export {
  DEFAULT_LEASE_MS,
  _clearInflightForTest,
  _inflightSizeForTest,
  decrementInflight,
  getInflight,
  incrementInflight
};
