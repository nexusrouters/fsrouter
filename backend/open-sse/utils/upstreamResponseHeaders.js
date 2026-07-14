const STRIP_HEADER_NAMES = /* @__PURE__ */ new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding"
]);
function stripStaleEncodingHeaders(input) {
  const out = new Headers(input);
  for (const name of STRIP_HEADER_NAMES) out.delete(name);
  return out;
}
function filterUpstreamResponseHeaderEntries(entries, extraToStrip = []) {
  const drop = new Set(STRIP_HEADER_NAMES);
  for (const h of extraToStrip) drop.add(h.toLowerCase());
  const result = [];
  for (const [k, v] of entries) {
    if (!drop.has(k.toLowerCase())) result.push([k, v]);
  }
  return result;
}
const STRIP_UPSTREAM_HEADER_NAMES = STRIP_HEADER_NAMES;
export {
  STRIP_UPSTREAM_HEADER_NAMES,
  filterUpstreamResponseHeaderEntries,
  stripStaleEncodingHeaders
};
