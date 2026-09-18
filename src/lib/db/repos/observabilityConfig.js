// Shared gate + tuning for all observability writes (requestDetails rows and
// the traces table they aggregate into).
//
// Why a shared module: the operator has ONE master switch (`enableObservability`
// in Settings). If only one of the two tables honoured it, turning observability
// off would still accumulate empty trace shells — and the Traces page would show
// rows that can never have spans. Both writers read the gate from here.
//
// Read path is cached briefly so hot paths don't hit the DB per span, while a
// UI toggle still takes effect within seconds (no restart needed).

const DEFAULT_MAX_RECORDS = 2000;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
// 0 = store payloads verbatim. Traces are a debugging tool — reading the real
// system prompt / request is the whole point — so full content is the default
// and summarization only kicks in when an operator bounds disk usage.
const DEFAULT_MAX_JSON_SIZE_KB = 0;
const CONFIG_CACHE_TTL_MS = 5000;

let cachedConfig = null;
let cachedConfigTs = 0;

// KB setting -> bytes. 0 / negative / unset means "no limit". Note the explicit
// nullish checks: `setting || fallback` would swallow an intentional 0.
function resolveMaxJsonBytes(settings) {
  const raw = settings.observabilityMaxJsonSize ?? process.env.OBSERVABILITY_MAX_JSON_SIZE;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MAX_JSON_SIZE_KB * 1024;
  const kb = parseInt(raw, 10);
  if (!Number.isFinite(kb) || kb <= 0) return 0;
  return kb * 1024;
}

export async function getObservabilityConfig() {
  if (cachedConfig && Date.now() - cachedConfigTs < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();

    // A hard env kill-switch wins over everything (deploy-level "never").
    if (process.env.OBSERVABILITY_ENABLED === "false") {
      cachedConfig = { enabled: false, maxRecords: DEFAULT_MAX_RECORDS, maxJsonSize: 0 };
      cachedConfigTs = Date.now();
      return cachedConfig;
    }

    // Legacy: ENABLE_REQUEST_LOGS, when set, is the sole authority.
    const envRequestLogs = process.env.ENABLE_REQUEST_LOGS;
    const uiFlag = typeof settings.enableObservability === "boolean";
    const enabled = envRequestLogs !== undefined
      ? envRequestLogs.toLowerCase() === "true"
      : (uiFlag ? settings.enableObservability : true);

    cachedConfig = {
      enabled,
      maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
      maxJsonSize: resolveMaxJsonBytes(settings),
    };
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: 0,
    };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

/** Convenience gate for writers that only need the boolean. */
export async function isObservabilityEnabled() {
  const cfg = await getObservabilityConfig();
  return !!cfg.enabled;
}

export const __test__ = { resolveMaxJsonBytes, DEFAULT_MAX_JSON_SIZE_KB };
