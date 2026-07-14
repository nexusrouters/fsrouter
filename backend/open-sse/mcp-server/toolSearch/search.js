const NAME_PHRASE_BONUS = 25;
const NAME_TOKEN_BONUS = 6;
const DESC_PHRASE_BONUS = 20;
const DESC_TOKEN_BONUS = 3;
const MIN_LIMIT = 1;
const MAX_LIMIT = 25;
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}
function scoreEntry(entry, normalizedQuery, tokens) {
  const nameLower = entry.name.toLowerCase();
  const descLower = entry.description.toLowerCase();
  let score = 0;
  if (nameLower.includes(normalizedQuery)) {
    score += NAME_PHRASE_BONUS;
  }
  for (const token of tokens) {
    score += countOccurrences(nameLower, token) * NAME_TOKEN_BONUS;
  }
  if (descLower.includes(normalizedQuery)) {
    score += DESC_PHRASE_BONUS;
  }
  for (const token of tokens) {
    score += countOccurrences(descLower, token) * DESC_TOKEN_BONUS;
  }
  return score;
}
function searchTools(entries, query, limit = 8) {
  const clampedLimit = Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, limit));
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const entry of entries) {
    const score = scoreEntry(entry, normalizedQuery, tokens);
    if (score > 0) {
      scored.push({ ...entry, score });
    }
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return scored.slice(0, clampedLimit);
}
export {
  searchTools
};
