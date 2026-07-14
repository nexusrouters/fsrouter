const FINGERPRINT_PROVIDERS = /* @__PURE__ */ new Set(["mimocode", "mcode", "opencode"]);
function isFingerprintProvider(provider) {
  return FINGERPRINT_PROVIDERS.has(provider);
}
function getConnectionFingerprints(connection) {
  if (!connection || typeof connection !== "object") return [];
  const psd = connection["providerSpecificData"];
  if (!psd || typeof psd !== "object") return [];
  const fps = psd["fingerprints"];
  if (!Array.isArray(fps)) return [];
  return fps.filter((fp) => typeof fp === "string" && fp.trim().length > 0);
}
function hasMultipleFingerprints(connection) {
  return getConnectionFingerprints(connection).length > 1;
}
function buildFingerprintExecutionKey(originalKey, fingerprint, isFirst) {
  if (isFirst) return originalKey;
  return `${originalKey}@fp:${fingerprint}`;
}
function expandTargetsByFingerprints(targets, connectionById, getProvider) {
  const result = [];
  for (const target of targets) {
    const provider = getProvider(target);
    const { connectionId } = target;
    if (!connectionId || !isFingerprintProvider(provider)) {
      result.push(target);
      continue;
    }
    const connection = connectionById.get(connectionId);
    const fingerprints = getConnectionFingerprints(connection);
    if (fingerprints.length <= 1) {
      result.push(target);
      continue;
    }
    for (let i = 0; i < fingerprints.length; i++) {
      const isFirst = i === 0;
      result.push({
        ...target,
        executionKey: buildFingerprintExecutionKey(target.executionKey, fingerprints[i], isFirst)
      });
    }
  }
  return result;
}
export {
  buildFingerprintExecutionKey,
  expandTargetsByFingerprints,
  getConnectionFingerprints,
  hasMultipleFingerprints,
  isFingerprintProvider
};
