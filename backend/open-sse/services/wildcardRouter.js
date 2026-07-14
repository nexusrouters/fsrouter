function wildcardMatch(model, pattern) {
  if (!model || !pattern) return false;
  if (pattern === "*") return true;
  if (pattern === model) return true;
  const regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  const regex = new RegExp(`^${regexStr}$`, "i");
  return regex.test(model);
}
function getSpecificity(pattern) {
  if (!pattern) return 0;
  let score = 0;
  const segments = pattern.split(/[/*?]/);
  for (const seg of segments) {
    if (seg.length > 0) score += seg.length * 10;
  }
  const wildcardCount = (pattern.match(/\*/g) || []).length;
  const questionCount = (pattern.match(/\?/g) || []).length;
  score -= wildcardCount * 50;
  score -= questionCount * 5;
  score += pattern.length;
  return score;
}
function resolveWildcardAlias(model, aliases) {
  if (!model || !aliases || !Array.isArray(aliases)) return null;
  const matches = [];
  for (const alias of aliases) {
    const pattern = alias.pattern || alias.alias || alias.from;
    const target = alias.target || alias.model || alias.to;
    if (!pattern || !target) continue;
    if (wildcardMatch(model, pattern)) {
      matches.push({
        pattern,
        target,
        specificity: getSpecificity(pattern),
        ...alias
      });
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.specificity - a.specificity);
  return matches[0];
}
function resolveModel(model, exactAliases = {}, wildcardAliases = []) {
  if (!model) return model;
  if (exactAliases instanceof Map) {
    if (exactAliases.has(model)) return exactAliases.get(model);
  } else if (exactAliases[model]) {
    return exactAliases[model];
  }
  const match = resolveWildcardAlias(model, wildcardAliases);
  if (match) return match.target;
  return model;
}
export {
  getSpecificity,
  resolveModel,
  resolveWildcardAlias,
  wildcardMatch
};
