import { buildClineHeaders } from "../shared/clineAuth.js";

const CLINEPASS_MODELS_ENDPOINT = "https://api.cline.bot/api/v1/models";
const CLINE_CHAT_ENDPOINT = "https://api.cline.bot/api/v1/chat/completions";
const FETCH_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 6000;
const PROBE_MAX_TOKENS = 16;
const PROBE_CONCURRENCY = 8;

/**
 * Cline's catalog lists `<model>:batch` entries for offline batch jobs. They are
 * not usable for interactive chat, so every caller (live catalog, dashboard
 * import, probe) has to drop them.
 */
export function isBatchModelId(modelId) {
  return typeof modelId === "string" && modelId.endsWith(":batch");
}

/**
 * Build request headers for the ClinePass /models endpoint (Cline's upstream API).
 * - API keys are sent as plain Bearer tokens.
 * - OAuth access tokens must carry the WorkOS `workos:` prefix (handled by buildClineHeaders).
 */
function buildModelListHeaders(token, isApiKey) {
  if (isApiKey) {
    return {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    };
  }
  return buildClineHeaders(token, { Accept: "application/json" });
}

/**
 * Internal: fetch the raw model list from Cline's /models endpoint.
 * Returns the parsed array or null on any failure.
 */
async function fetchClineRawModels(credentials) {
  const isApiKey = Boolean(credentials?.apiKey);
  const token = isApiKey ? credentials.apiKey : credentials?.accessToken;
  if (!token) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers = buildModelListHeaders(token, isApiKey);

    const response = await fetch(CLINEPASS_MODELS_ENDPOINT, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const json = await response.json();
    const rawList = Array.isArray(json) ? json : json?.data;
    return Array.isArray(rawList) ? rawList : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch ClinePass live model catalog from Cline's /models endpoint.
 * Returns only models with the cline-pass/ prefix.
 *
 * @param {object} credentials - Connection credentials ({ accessToken, apiKey })
 * @returns {Promise<{ models: { id: string, name: string }[] } | null>}
 */
export async function resolveClinepassModels(credentials) {
  const rawList = await fetchClineRawModels(credentials);
  if (!rawList) return null;

  const models = rawList
    .filter((m) => typeof m?.id === "string" && m.id.startsWith("cline-pass/"))
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
    }));

  return models.length ? { models } : null;
}

/**
 * Fetch Cline live model catalog from Cline's /models endpoint.
 * Unlike resolveClinepassModels, this returns ALL models (including
 * free-tier models like z-ai/glm-5.3-flash) without the cline-pass/ prefix filter.
 *
 * @param {object} credentials - Connection credentials ({ accessToken, apiKey })
 * @returns {Promise<{ models: { id: string, name: string }[] } | null>}
 */
export async function resolveClineModels(credentials) {
  const rawList = await fetchClineRawModels(credentials);
  if (!rawList) return null;

  const models = rawList
    .filter((m) => typeof m?.id === "string" && m.id.trim() !== "" && !isBatchModelId(m.id))
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
    }));

  return models.length ? { models } : null;
}

/**
 * Probe one model with a minimal non-stream chat completion.
 * Returns `{ id, ok: true }` only when the upstream actually returns choices —
 * Cline answers 200 with `{"error":"empty response content"}` for catalog
 * entries whose upstream is gone, so the status code alone is not enough.
 */
async function probeSingleClineModel(modelId, token, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(CLINE_CHAT_ENDPOINT, {
      method: "POST",
      headers: buildClineHeaders(token, { "Content-Type": "application/json", Accept: "application/json" }),
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "1" }],
        max_tokens: PROBE_MAX_TOKENS,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { id: modelId, ok: false, status: response.status };
    }

    const json = await response.json().catch(() => null);
    const hasChoice = Boolean(json?.data?.choices?.[0]?.message || json?.choices?.[0]?.message);
    return hasChoice ? { id: modelId, ok: true } : { id: modelId, ok: false, reason: "no choices returned" };
  } catch (err) {
    return { id: modelId, ok: false, reason: err?.message || "probe failed" };
  } finally {
    clearTimeout(timer);
  }
}

// Bounded-concurrency map so a 400-model catalog does not open 400 sockets.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Probe which Cline models the account can actually call.
 *
 * Cline's `/models` endpoint returns its whole routing catalog (~440 entries)
 * rather than the caller's usable set, so importing it verbatim fills the
 * dashboard with models that answer 403/404/500. Probing each candidate with a
 * 16-token completion keeps only the ones that really work.
 *
 * @param {object} credentials - Connection credentials ({ accessToken, apiKey })
 * @param {string[]} modelIds - Candidate model ids
 * @param {object} [options]
 * @param {number} [options.concurrency] Parallel probes (default 8)
 * @param {number} [options.timeoutMs] Per-probe timeout (default 6000)
 * @returns {Promise<{ accessible: string[], inaccessible: { id: string, status?: number, reason?: string }[] }>}
 */
export async function probeClineModels(credentials, modelIds, options = {}) {
  const token = credentials?.apiKey || credentials?.accessToken;
  const candidates = Array.isArray(modelIds)
    ? modelIds.filter((id) => typeof id === "string" && id.trim() !== "" && !isBatchModelId(id))
    : [];

  if (!token || candidates.length === 0) {
    return { accessible: [], inaccessible: [] };
  }

  const timeoutMs = options.timeoutMs || PROBE_TIMEOUT_MS;
  const results = await mapWithConcurrency(
    candidates,
    options.concurrency || PROBE_CONCURRENCY,
    (modelId) => probeSingleClineModel(modelId, token, timeoutMs)
  );

  const accessible = [];
  const inaccessible = [];
  for (const result of results) {
    if (result.ok) {
      accessible.push(result.id);
    } else {
      inaccessible.push({ id: result.id, status: result.status, reason: result.reason });
    }
  }

  return { accessible, inaccessible };
}
