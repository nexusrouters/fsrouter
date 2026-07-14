function estimateSizeFast(value) {
  let bytes = 0;
  const stack = [value];
  const seen = /* @__PURE__ */ new WeakSet();
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || v === void 0) continue;
    if (typeof v === "string") {
      bytes += v.length;
      if (bytes > 262144) return bytes;
    } else if (typeof v === "number") bytes += 8;
    else if (typeof v === "boolean") bytes += 4;
    else if (typeof v === "object") {
      if (seen.has(v)) continue;
      seen.add(v);
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) stack.push(v[i]);
      } else {
        for (const key in v) {
          if (Object.prototype.hasOwnProperty.call(v, key)) stack.push(v[key]);
        }
      }
    }
  }
  return bytes;
}
function isSmallEnoughForSemanticCache(value) {
  return estimateSizeFast(value) <= 256 * 1024;
}
export {
  estimateSizeFast,
  isSmallEnoughForSemanticCache
};
