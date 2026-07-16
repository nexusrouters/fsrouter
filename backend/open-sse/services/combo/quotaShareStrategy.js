import { isBucketSaturated } from '../../dist/lib/quota/accountBuckets.ts.js';
import { incrementInflight, decrementInflight, getInflight } from "./quotaShareInflight.ts";
const MAX_DRR_COMBOS = 200;
const _drrState = /* @__PURE__ */ new Map();
function getDrrDeficits(comboName) {
  let deficits = _drrState.get(comboName);
  if (!deficits) {
    if (_drrState.size >= MAX_DRR_COMBOS) {
      const oldestKey = _drrState.keys().next().value;
      if (oldestKey !== void 0) _drrState.delete(oldestKey);
    }
    deficits = /* @__PURE__ */ new Map();
    _drrState.set(comboName, deficits);
  }
  return deficits;
}
function bareModelName(modelStr) {
  const slash = modelStr.indexOf("/");
  return slash >= 0 ? modelStr.slice(slash + 1) : modelStr;
}
function filterEligibleBySaturation(targets, modelStr, nowMs) {
  const modelName = bareModelName(modelStr);
  const eligible = targets.filter((target) => {
    const connId = target.connectionId ?? "";
    if (connId === "") return true;
    const saturated = isBucketSaturated(connId, "5h", nowMs) || isBucketSaturated(connId, "7d", nowMs) || modelName !== "" && isBucketSaturated(connId, `7d:${modelName}`, nowMs);
    return !saturated;
  });
  return eligible.length > 0 ? eligible : targets;
}
function resolveConnectionCap(connectionId, caps) {
  if (!connectionId || !caps) return null;
  const cap = caps.get(connectionId);
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) return null;
  return cap;
}
function partitionByConcurrencyCap(targets, caps, nowMs) {
  if (!caps || caps.size === 0) return { withRoom: targets, atCap: [] };
  const withRoom = [];
  const atCap = [];
  for (const target of targets) {
    const connId = target.connectionId ?? "";
    const cap = resolveConnectionCap(connId, caps);
    if (cap === null) {
      withRoom.push(target);
      continue;
    }
    if (getInflight(connId, nowMs) >= cap) {
      atCap.push(target);
    } else {
      withRoom.push(target);
    }
  }
  if (withRoom.length === 0) return { withRoom: targets, atCap: [] };
  return { withRoom, atCap };
}
function applyDrr(targets, comboName) {
  if (targets.length <= 1) return targets.slice();
  const deficits = getDrrDeficits(comboName);
  const totalWeight = targets.reduce((sum, t) => sum + normalizeWeight(t.weight), 0);
  for (const target of targets) {
    const quantum = normalizeWeight(target.weight) / totalWeight;
    deficits.set(target.executionKey, (deficits.get(target.executionKey) ?? 0) + quantum);
  }
  let winner = targets[0];
  let bestDeficit = deficits.get(winner.executionKey) ?? 0;
  for (let i = 1; i < targets.length; i++) {
    const d = deficits.get(targets[i].executionKey) ?? 0;
    if (d > bestDeficit) {
      bestDeficit = d;
      winner = targets[i];
    }
  }
  deficits.set(winner.executionKey, bestDeficit - 1);
  const rest = targets.filter((t) => t.executionKey !== winner.executionKey);
  return [winner, ...rest];
}
function normalizeWeight(weight) {
  return Number.isFinite(weight) && weight > 0 ? weight : 1;
}
function pickByInflightP2C(first, second, nowMs) {
  const loadFirst = getInflight(first.connectionId ?? "", nowMs);
  const loadSecond = getInflight(second.connectionId ?? "", nowMs);
  return loadSecond < loadFirst ? 1 : 0;
}
function selectQuotaShareTarget(targets, comboName, modelStr, nowMs = Date.now(), options) {
  const noOp = () => {
  };
  if (targets.length === 0) {
    return { target: null, orderedTargets: [], decrementInflight: noOp };
  }
  const eligible = filterEligibleBySaturation(targets, modelStr, nowMs);
  const saturatedDeprioritized = targets.filter((t) => !eligible.includes(t));
  const { withRoom, atCap } = partitionByConcurrencyCap(
    eligible,
    options?.maxConcurrentByConnection,
    nowMs
  );
  const ordered = applyDrr(withRoom, comboName);
  let winner;
  let rest;
  if (ordered.length >= 2 && pickByInflightP2C(ordered[0], ordered[1], nowMs) === 1) {
    winner = ordered[1];
    rest = [ordered[0], ...ordered.slice(2)];
  } else {
    winner = ordered[0];
    rest = ordered.slice(1);
  }
  const winnerConnectionId = winner.connectionId ?? "";
  if (winnerConnectionId) incrementInflight(winnerConnectionId, void 0, nowMs);
  const orderedTargets = [winner, ...rest, ...atCap, ...saturatedDeprioritized];
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (winnerConnectionId) decrementInflight(winnerConnectionId, nowMs);
  };
  return { target: winner, orderedTargets, decrementInflight: release };
}
function _clearDrrStateForTest() {
  _drrState.clear();
}
function _getDrrDeficitForTest(comboName, executionKey) {
  return _drrState.get(comboName)?.get(executionKey) ?? 0;
}
export {
  _clearDrrStateForTest,
  _getDrrDeficitForTest,
  selectQuotaShareTarget
};
