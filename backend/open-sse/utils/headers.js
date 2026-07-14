function normalizeHeaders(h) {
  if (!h) return {};
  const out = {};
  try {
    if (typeof h.forEach === "function") {
      h.forEach((value, key) => {
        out[key.toLowerCase()] = value;
      });
      return out;
    }
  } catch {
  }
  try {
    if (typeof h.entries === "function") {
      for (const [k, v] of h.entries()) {
        out[k.toLowerCase()] = String(v);
      }
      return out;
    }
  } catch {
  }
  if (typeof h === "object") {
    for (const [k, v] of Object.entries(h)) {
      out[k.toLowerCase()] = String(v ?? "");
    }
  }
  return out;
}
function getHeader(h, name) {
  const plain = normalizeHeaders(h);
  return plain[name.toLowerCase()] ?? null;
}
export {
  getHeader,
  normalizeHeaders
};
