import { hashInput, summarizeOutput } from "./schemas/audit.ts";
import { isNativeSqliteLoadError } from "../../src/lib/db/core.ts";
function createNodeSqliteAuditAdapter(db) {
  let _isOpen = true;
  return {
    driver: "node:sqlite",
    get open() {
      return _isOpen;
    },
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        get: (...params) => stmt.get(...params),
        all: (...params) => stmt.all(...params),
        run: (...params) => stmt.run(...params)
      };
    },
    pragma(pragmaSql) {
      try {
        db.exec(`PRAGMA ${pragmaSql}`);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    close: () => {
      if (!_isOpen) return;
      try {
        db.close();
      } finally {
        _isOpen = false;
      }
    }
  };
}
function toNullableString(value) {
  return typeof value === "string" ? value : null;
}
function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  return fallback;
}
function toPositiveInt(value, fallback) {
  const parsed = toNumber(value, fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}
function mapAuditEntry(row) {
  return {
    id: toPositiveInt(row.id, 0),
    toolName: toString(row.tool_name),
    inputHash: toString(row.input_hash),
    outputSummary: toString(row.output_summary),
    durationMs: toNumber(row.duration_ms, 0),
    apiKeyId: toNullableString(row.api_key_id),
    success: toBoolean(row.success, false),
    errorCode: toNullableString(row.error_code),
    createdAt: toString(row.created_at)
  };
}
function buildAuditFilterSql(filters) {
  const clauses = [];
  const params = [];
  if (typeof filters.tool === "string" && filters.tool.trim().length > 0) {
    clauses.push("tool_name = ?");
    params.push(filters.tool.trim());
  }
  if (typeof filters.success === "boolean") {
    clauses.push("success = ?");
    params.push(filters.success ? 1 : 0);
  }
  if (typeof filters.apiKeyId === "string" && filters.apiKeyId.trim().length > 0) {
    clauses.push("api_key_id = ?");
    params.push(filters.apiKeyId.trim());
  }
  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params
  };
}
function getCachedAuditDb() {
  return globalThis.__omnirouteMcpAuditDb ?? null;
}
function setCachedAuditDb(database) {
  globalThis.__omnirouteMcpAuditDb = database;
}
function toNumber(value, fallback = 0) {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim().length > 0 ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}
function toString(value) {
  return typeof value === "string" ? value : "";
}
async function openBetterSqliteAuditDb(dbPath) {
  const Database = (await import("better-sqlite3")).default;
  return new Database(dbPath);
}
function nodeSqliteFallbackAvailable() {
  const [maj, min] = (process.versions.node ?? "0.0").split(".").map(Number);
  return maj > 22 || maj === 22 && (min ?? 0) >= 5;
}
async function openNodeSqliteAuditDb(dbPath) {
  const { DatabaseSync } = await import("node:sqlite");
  return createNodeSqliteAuditAdapter(new DatabaseSync(dbPath));
}
async function openFallbackAuditDb(dbPath, nativeMessage) {
  if (!nodeSqliteFallbackAvailable()) {
    console.error(
      `[MCP Audit] better-sqlite3 native binding unavailable and Node ${process.version} has no built-in sqlite. Audit logging disabled. Fix: run \`npm rebuild better-sqlite3\` in the omniroute install root.`
    );
    return null;
  }
  try {
    const adapter = await openNodeSqliteAuditDb(dbPath);
    console.warn(
      `[MCP Audit] better-sqlite3 binding unavailable \u2014 fell back to node:sqlite (${nativeMessage.split("\n")[0]})`
    );
    return adapter;
  } catch (nodeErr) {
    const nodeMessage = nodeErr instanceof Error ? nodeErr.message : String(nodeErr);
    console.error("[MCP Audit] Failed to connect to database:", nodeMessage);
    return null;
  }
}
async function getDb() {
  const cachedDb = getCachedAuditDb();
  if (cachedDb) return cachedDb;
  try {
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const { existsSync } = await import("node:fs");
    const dbPath = process.env.DATA_DIR ? join(process.env.DATA_DIR, "storage.sqlite") : join(homedir(), ".omniroute", "storage.sqlite");
    if (!existsSync(dbPath)) {
      console.error(`[MCP Audit] Database not found at ${dbPath} \u2014 audit logging disabled`);
      return null;
    }
    try {
      const database = await openBetterSqliteAuditDb(dbPath);
      setCachedAuditDb(database);
      return database;
    } catch (nativeErr) {
      const nativeMessage = nativeErr instanceof Error ? nativeErr.message : String(nativeErr);
      if (!isNativeSqliteLoadError(nativeErr)) {
        console.error("[MCP Audit] Failed to connect to database:", nativeMessage);
        return null;
      }
      const fallbackDb = await openFallbackAuditDb(dbPath, nativeMessage);
      setCachedAuditDb(fallbackDb);
      return fallbackDb;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[MCP Audit] Failed to connect to database:", message);
    return null;
  }
}
function closeAuditDb() {
  const database = getCachedAuditDb();
  if (!database) return false;
  setCachedAuditDb(null);
  try {
    try {
      if (database.open !== false) {
        database.pragma("wal_checkpoint(TRUNCATE)");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[MCP Audit] WAL checkpoint failed during close:", message);
    }
  } finally {
    try {
      database.close();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[MCP Audit] Failed to close database:", message);
    }
  }
  return true;
}
async function logToolCall(toolName, input, output, durationMs, success, errorCode) {
  try {
    const database = await getDb();
    if (!database) return;
    const inputHash = await hashInput(input);
    const outputSummary = summarizeOutput(output);
    const apiKeyId = process.env.OMNIROUTE_API_KEY_ID || null;
    database.prepare(
      `INSERT INTO mcp_tool_audit (tool_name, input_hash, output_summary, duration_ms, api_key_id, success, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      toolName,
      inputHash,
      outputSummary,
      durationMs,
      apiKeyId,
      success ? 1 : 0,
      errorCode || null
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[MCP Audit] Failed to log:", message);
  }
}
async function queryAuditEntries(filters = {}) {
  try {
    const database = await getDb();
    const limit = Math.max(1, Math.min(500, toPositiveInt(filters.limit, 50)));
    const offset = Math.max(0, toPositiveInt(filters.offset, 0));
    if (!database) return { entries: [], total: 0, limit, offset };
    const { whereSql, params } = buildAuditFilterSql(filters);
    const totalRow = database.prepare(`SELECT COUNT(*) as total FROM mcp_tool_audit ${whereSql}`).get(...params);
    const rows = database.prepare(
      `SELECT
           id,
           tool_name,
           input_hash,
           output_summary,
           duration_ms,
           api_key_id,
           success,
           error_code,
           created_at
         FROM mcp_tool_audit
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);
    return {
      entries: rows.map(mapAuditEntry),
      total: toPositiveInt(totalRow?.total, 0),
      limit,
      offset
    };
  } catch {
    return { entries: [], total: 0, limit: 50, offset: 0 };
  }
}
async function getRecentAuditEntries(limit = 50) {
  const result = await queryAuditEntries({ limit, offset: 0 });
  return result.entries;
}
async function getAuditStats() {
  try {
    const database = await getDb();
    if (!database) return { totalCalls: 0, successRate: 0, avgDurationMs: 0, topTools: [] };
    const stats = database.prepare(
      `SELECT 
           COUNT(*) as total,
           AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) as successRate,
           AVG(duration_ms) as avgDuration
         FROM mcp_tool_audit
         WHERE created_at > datetime('now', '-24 hours')`
    ).get();
    const topTools = database.prepare(
      `SELECT tool_name as tool, COUNT(*) as count
         FROM mcp_tool_audit
         WHERE created_at > datetime('now', '-24 hours')
         GROUP BY tool_name
         ORDER BY count DESC
         LIMIT 10`
    ).all();
    return {
      totalCalls: toNumber(stats?.total, 0),
      successRate: toNumber(stats?.successRate, 0),
      avgDurationMs: toNumber(stats?.avgDuration, 0),
      topTools: (topTools || []).map((entry) => ({
        tool: toString(entry.tool),
        count: toNumber(entry.count, 0)
      }))
    };
  } catch {
    return { totalCalls: 0, successRate: 0, avgDurationMs: 0, topTools: [] };
  }
}
export {
  closeAuditDb,
  getAuditStats,
  getRecentAuditEntries,
  logToolCall,
  queryAuditEntries
};
