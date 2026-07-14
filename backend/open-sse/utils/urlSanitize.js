function stripTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end--;
  }
  return end === value.length ? value : value.slice(0, end);
}
function normalizeBaseUrl(value) {
  const str = typeof value === "string" ? value : "";
  return stripTrailingSlashes(str.trim());
}
export {
  normalizeBaseUrl,
  stripTrailingSlashes
};
