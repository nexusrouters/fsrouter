function clampUtil(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}
function computeHeadroom(sat) {
  const u5 = clampUtil(sat?.util5h);
  const u7 = clampUtil(sat?.util7d);
  return 1 - Math.max(u5, u7);
}
function rankByHeadroom(candidates, satByKey, keyOf) {
  if (candidates.length <= 1) return candidates;
  const decorated = candidates.map((candidate, index) => ({
    candidate,
    index,
    headroom: computeHeadroom(satByKey.get(keyOf(candidate)))
  }));
  decorated.sort((a, b) => {
    if (b.headroom !== a.headroom) return b.headroom - a.headroom;
    return a.index - b.index;
  });
  return decorated.map((entry) => entry.candidate);
}
export {
  computeHeadroom,
  rankByHeadroom
};
