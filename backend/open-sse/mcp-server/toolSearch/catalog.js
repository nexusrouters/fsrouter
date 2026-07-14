import { MCP_TOOLS } from "../schemas/tools.ts";
import { memoryTools } from "../tools/memoryTools.ts";
import { skillTools } from "../tools/skillTools.ts";
import { agentSkillTools } from "../tools/agentSkillTools.ts";
import { poolTools } from "../tools/poolTools.ts";
import { gamificationTools } from "../tools/gamificationTools.ts";
import { pluginTools } from "../tools/pluginTools.ts";
import { notionTools } from "../tools/notionTools.ts";
import { obsidianTools } from "../tools/obsidianTools.ts";
import { compressionTools } from "../tools/compressionTools.ts";
function normalizeEntry(raw) {
  const name = typeof raw.name === "string" ? raw.name : null;
  const description = typeof raw.description === "string" ? raw.description : "";
  if (!name) return null;
  const scopes = Array.isArray(raw.scopes) ? raw.scopes.filter((s) => typeof s === "string") : [];
  return { name, description, scopes, inputSchema: raw.inputSchema };
}
function collectFromArray(arr) {
  const result = [];
  for (const item of arr) {
    const entry = normalizeEntry(item);
    if (entry) result.push(entry);
  }
  return result;
}
function collectFromRecord(rec) {
  return collectFromArray(Object.values(rec));
}
function collectAny(collection) {
  if (Array.isArray(collection)) return collectFromArray(collection);
  if (collection && typeof collection === "object") {
    return collectFromRecord(collection);
  }
  return [];
}
function getAllToolDefinitions() {
  const collections = [
    MCP_TOOLS,
    memoryTools,
    skillTools,
    agentSkillTools,
    poolTools,
    gamificationTools,
    pluginTools,
    notionTools,
    obsidianTools,
    // compressionTools holds omniroute_ccr_retrieve, which is NOT in MCP_TOOLS — without it
    // a `tool_search("compression")` would miss that tool. The other 5 overlap MCP_TOOLS and
    // are resolved by the dedup-by-name below (first wins).
    compressionTools
  ];
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const collection of collections) {
    for (const entry of collectAny(collection)) {
      if (!seen.has(entry.name)) {
        seen.add(entry.name);
        result.push(entry);
      }
    }
  }
  return result;
}
export {
  getAllToolDefinitions
};
