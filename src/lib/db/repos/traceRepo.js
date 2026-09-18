import crypto from "crypto";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { decodeRow } from "../helpers/rowCodec.js";
import { isObservabilityEnabled } from "./observabilityConfig.js";

const DEFAULT_MAX_RECORDS = 2000;
const CONFIG_CACHE_TTL_MS = 5000;
// A "running" trace older than this is considered abandoned (crashed/aborted
// request) and auto-finalized on read so the list never shows stale running rows.
const RUNNING_STALE_MS = 10 * 60 * 1000;

let cachedConfig = null;
let cachedConfigTs = 0;

async function getTraceConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    cachedConfig = {
      maxRecords: settings.traceMaxRecords || parseInt(process.env.TRACE_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
    };
  } catch {
    cachedConfig = { maxRecords: DEFAULT_MAX_RECORDS };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

function pruneTraces(db, maxRecords) {
  const cnt = db.get(`SELECT COUNT(*) as c FROM traces`);
  if (cnt && cnt.c > maxRecords) {
    db.run(
      `DELETE FROM traces WHERE id IN (SELECT id FROM traces ORDER BY timestamp ASC LIMIT ?)`,
      [cnt.c - maxRecords]
    );
    // Cascade scores of pruned traces to keep the table from growing unbounded.
    db.run(
      `DELETE FROM traceScores WHERE traceId NOT IN (SELECT id FROM traces)`
    );
  }
}

export async function createTrace(trace) {
  // Same master switch as the requestDetails writer: with observability off, a
  // trace row would only ever be an empty shell (no spans can be recorded), so
  // don't create it at all.
  if (!(await isObservabilityEnabled())) return trace?.id || null;
  const db = await getAdapter();
  const id = trace.id || crypto.randomUUID();
  const timestamp = trace.timestamp || new Date().toISOString();
  db.run(
    `INSERT INTO traces(id, timestamp, sessionId, apiKey, endpoint, requestedModel, comboName, status, spans, latencyTotal, promptTokens, completionTokens, cost, errorSummary, userAgent, meta)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp`,
    [
      id, timestamp, trace.sessionId || null, trace.apiKey || null,
      trace.endpoint || null, trace.requestedModel || null, trace.comboName || null,
      trace.status || "running",
      trace.errorSummary || null, trace.userAgent || null,
      trace.meta ? stringifyJson(trace.meta) : null,
    ]
  );
  return id;
}

export async function finalizeTrace(id, patch = {}) {
  if (!id) return;
  if (!(await isObservabilityEnabled())) return;
  const db = await getAdapter();
  const sets = [];
  const params = [];
  if (patch.status) { sets.push("status = ?"); params.push(patch.status); }
  if (patch.errorSummary !== undefined) { sets.push("errorSummary = ?"); params.push(patch.errorSummary); }
  if (patch.comboName !== undefined) { sets.push("comboName = ?"); params.push(patch.comboName); }
  if (patch.meta !== undefined) { sets.push("meta = ?"); params.push(patch.meta ? stringifyJson(patch.meta) : null); }
  if (!sets.length) return;
  params.push(id);
  db.run(`UPDATE traces SET ${sets.join(", ")} WHERE id = ?`, params);
}

/**
 * Recompute aggregate columns (spans, latency, tokens, cost, status) from the
 * trace's spans (requestDetails rows sharing the traceId). Safe to call after
 * each span write — covers streaming async completion and out-of-order spans.
 */
export async function refreshTraceAggregates(traceId) {
  if (!traceId) return;
  if (!(await isObservabilityEnabled())) return;
  try {
    const db = await getAdapter();
    const rows = db.all(`SELECT data, status FROM requestDetails WHERE traceId = ?`, [traceId]);
    if (!rows.length) return;

    let spans = 0;
    let latencyTotal = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let hasSuccess = false;
    for (const r of rows) {
      const detail = decodeRow(r.data) || {};
      spans += 1;
      latencyTotal = Math.max(latencyTotal, detail.latency?.total || 0);
      const t = detail.tokens || {};
      promptTokens += t.prompt_tokens || t.input_tokens || 0;
      completionTokens += t.completion_tokens || t.output_tokens || 0;
      if (detail.status === "success") hasSuccess = true;
    }

    db.run(
      `UPDATE traces SET spans = ?, latencyTotal = ?, promptTokens = ?, completionTokens = ? WHERE id = ?`,
      [spans, latencyTotal, promptTokens, completionTokens, traceId]
    );

    // Auto-finalize: any successful span marks the trace success (last-wins:
    // a later finalizeTrace(error) can still flip it, but fallback-then-success
    // is the common happy path and must not stay "running").
    if (hasSuccess) {
      db.run(`UPDATE traces SET status = 'success' WHERE id = ? AND status = 'running'`, [traceId]);
    }
  } catch (e) {
    console.error("[traceRepo] refreshTraceAggregates failed:", e);
  }
}

function maybeFinalizeStale(db, rows) {
  const cutoff = Date.now() - RUNNING_STALE_MS;
  for (const row of rows) {
    if (row.status === "running" && new Date(row.timestamp).getTime() < cutoff) {
      row.status = "error";
      row.errorSummary = row.errorSummary || "Abandoned (no finalize within 10m)";
      db.run(`UPDATE traces SET status = 'error', errorSummary = ? WHERE id = ?`, [row.errorSummary, row.id]);
    }
  }
}

export async function getTraces(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
  if (filter.sessionId) { conds.push("sessionId = ?"); params.push(filter.sessionId); }
  if (filter.requestedModel) { conds.push("requestedModel LIKE ?"); params.push(`%${filter.requestedModel}%`); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cntRow = db.get(`SELECT COUNT(*) as c FROM traces ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 20;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const rows = db.all(
    `SELECT id, timestamp, sessionId, apiKey, endpoint, requestedModel, comboName, status, spans, latencyTotal, promptTokens, completionTokens, cost, errorSummary, userAgent, meta
     FROM traces ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  maybeFinalizeStale(db, rows);
  const traces = rows.map((r) => ({ ...r, meta: parseJson(r.meta, null) }));

  return {
    traces,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

export async function getTraceById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM traces WHERE id = ?`, [id]);
  if (!row) return null;
  maybeFinalizeStale(db, [row]);
  return { ...row, meta: parseJson(row.meta, null) };
}

/** Spans of a trace = requestDetails rows carrying the traceId, ordered by spanIndex. */
export async function getTraceSpans(traceId) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT id, timestamp, provider, model, connectionId, status, spanIndex, spanName, data
     FROM requestDetails WHERE traceId = ? ORDER BY spanIndex ASC, timestamp ASC`,
    [traceId]
  );
  return rows.map((r) => {
    const detail = decodeRow(r.data) || {};
    return {
      id: r.id,
      timestamp: r.timestamp,
      provider: r.provider,
      model: r.model,
      connectionId: r.connectionId,
      status: r.status,
      spanIndex: r.spanIndex,
      spanName: r.spanName,
      latency: detail.latency || {},
      tokens: detail.tokens || {},
      pxpipe: detail.pxpipe || undefined,
    };
  });
}

export async function getSessions(filter = {}) {
  const db = await getAdapter();
  const conds = [`sessionId IS NOT NULL`, `sessionId != ''`];
  const params = [];
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }
  const where = `WHERE ${conds.join(" AND ")}`;

  const rows = db.all(
    `SELECT sessionId,
            COUNT(*) as requests,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
            SUM(promptTokens) as promptTokens,
            SUM(completionTokens) as completionTokens,
            SUM(cost) as cost,
            MIN(timestamp) as firstSeen,
            MAX(timestamp) as lastSeen
     FROM traces ${where}
     GROUP BY sessionId
     ORDER BY lastSeen DESC
     LIMIT ?`,
    [...params, filter.limit || 100]
  );
  return rows;
}

// ── Scores (Langfuse-style thumbs / evaluation) ──

export async function addTraceScore({ traceId, score, comment }) {
  const db = await getAdapter();
  const createdAt = new Date().toISOString();
  const result = db.run(
    `INSERT INTO traceScores(traceId, score, comment, createdAt) VALUES(?, ?, ?, ?)`,
    [traceId, score ?? null, comment || null, createdAt]
  );
  return result?.lastInsertRowid ?? null;
}

export async function getTraceScores(traceId) {
  const db = await getAdapter();
  return db.all(`SELECT * FROM traceScores WHERE traceId = ? ORDER BY createdAt DESC`, [traceId]);
}

export async function deleteTraceScore(id) {
  const db = await getAdapter();
  db.run(`DELETE FROM traceScores WHERE id = ?`, [id]);
}

// ── Prompt library (saved prompts extracted from traces) ──

export async function getPrompts() {
  const db = await getAdapter();
  return db.all(`SELECT * FROM promptLibrary ORDER BY updatedAt DESC`);
}

export async function getPromptById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM promptLibrary WHERE id = ?`, [id]);
  return row || null;
}

export async function savePrompt({ name, content, sourceTraceId }) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO promptLibrary(id, name, content, sourceTraceId, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [id, name, content, sourceTraceId || null, now, now]
  );
  return id;
}

export async function deletePrompt(id) {
  const db = await getAdapter();
  db.run(`DELETE FROM promptLibrary WHERE id = ?`, [id]);
}
