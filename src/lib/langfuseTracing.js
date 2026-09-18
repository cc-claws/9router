// Langfuse SDK instrumentation helpers (v5, OTel-based).
//
// All entry points are fail-open no-ops when Langfuse is disabled or the SDK
// failed to initialize — tracing must never break the request path.
//
// Span model mapped onto 9router's routing flow:
//
//   trace (root span, one per client request)            ← handleChat
//    └─ span "combo <name>"                              ← combo rotation
//         └─ span "account <provider>/<model> @ <acc>"   ← account fallback loop
//              └─ generation "<provider>/<model>"        ← the actual upstream LLM call
//
// Parenting is automatic via OTel AsyncLocalStorage: any observation created
// while a parent is active nests under it, across awaits.

import { summarizePayload } from "@/lib/payloadSummary.js";

const NOOP = {
  id: null,
  traceId: null,
  otelSpan: null,
  update: () => NOOP,
  end: () => {},
};

const GATE_TTL_MS = 5000;
let gateCache = null;
let gateCacheTs = 0;

/**
 * Whether tracing is live right now. Two layers:
 *
 *  - env `LANGFUSE_ENABLED` + the OTel SDK having started. These are fixed at
 *    process start, so they gate whether Langfuse is *available* at all.
 *  - the `enableObservability` setting, which is the operator's master switch
 *    for all observability. It is read from the DB with a short TTL so toggling
 *    it in the UI takes effect within seconds — no restart, which matters
 *    because restarting also drops the traffic being debugged.
 *
 * Cached for GATE_TTL_MS so this does not hit the DB on every span.
 */
export async function isLangfuseEnabled() {
  if (gateCache !== null && Date.now() - gateCacheTs < GATE_TTL_MS) return gateCache;
  gateCache = await computeGate();
  gateCacheTs = Date.now();
  return gateCache;
}

async function computeGate() {
  if (String(process.env.LANGFUSE_ENABLED || "").toLowerCase() !== "true") return false;
  if (process.env.NINEROUTER_LANGFUSE_OTEL !== "1") return false;
  try {
    const { getSettings } = await import("@/lib/db/index.js");
    const settings = await getSettings();
    // Master switch off ⇒ nothing is recorded locally either; keeping the two
    // in lockstep is what makes "off" mean off (no local rows, no cloud egress).
    if (settings.enableObservability === false) return false;
  } catch {
    // Settings unreadable: fall back to the env decision rather than silently
    // dropping traces. The operator configured Langfuse explicitly.
  }
  return true;
}

/** Test seam: force re-read of the gate. */
export function __resetLangfuseGate() {
  gateCache = null;
  gateCacheTs = 0;
}

async function loadTracing() {
  return import("@langfuse/tracing");
}

/**
 * Root observation for one client request. Runs `fn` with the span active so
 * every nested observation parents under it. The span is NOT auto-ended —
 * streaming responses outlive `fn` — so the caller ends it when the request
 * truly completes (see finalizeRootSpan).
 *
 * `attribution` carries trace-level identity (userId/sessionId/traceName).
 * These are Langfuse trace attributes, not span attributes, so they must be
 * set via propagateAttributes while the root context is active — setting them
 * on the span itself leaves the trace row with a null session.
 */
export async function withRootSpan(name, attributes, fn, attribution = {}) {
  if (!(await isLangfuseEnabled())) return fn(NOOP);
  try {
    const { startActiveObservation, propagateAttributes } = await loadTracing();
    const { userId, sessionId, traceName } = attribution;
    const props = {};
    if (userId) props.userId = String(userId).slice(0, 200);
    if (sessionId) props.sessionId = String(sessionId).slice(0, 200);
    props.traceName = String(traceName || name || "request").slice(0, 200);

    return await startActiveObservation(
      name,
      async (span) => {
        try {
          span.update(attributes || {});
        } catch { /* fail-open */ }
        // propagateAttributes wraps in context.with, so the attributes reach
        // every span created inside — including ones from nested modules.
        return await propagateAttributes(props, async () => fn(span));
      },
      { endOnExit: false }
    );
  } catch (e) {
    console.error("[langfuse] root span failed:", e?.message || e);
    return fn(NOOP);
  }
}

/** End a root span, recording final status. Safe to call twice. */
export function finalizeRootSpan(span, { level, statusMessage, output } = {}) {
  if (!span || span === NOOP) return;
  try {
    const attrs = {};
    if (output !== undefined) attrs.output = output;
    if (level) attrs.level = level;
    if (statusMessage) attrs.statusMessage = statusMessage;
    if (Object.keys(attrs).length) span.update(attrs);
    span.end();
  } catch { /* fail-open */ }
}

/**
 * Child span under the currently active observation (falls back to a new root
 * when nothing is active). Manual end — the caller decides when the step is done.
 */
export async function beginSpan(name, attributes = {}) {
  if (!(await isLangfuseEnabled())) return NOOP;
  try {
    const { startObservation } = await loadTracing();
    const span = startObservation(name, attributes);
    return span || NOOP;
  } catch (e) {
    console.error("[langfuse] beginSpan failed:", e?.message || e);
    return NOOP;
  }
}


/**
 * A generation — Langfuse's first-class representation of one LLM call.
 * Carries model/usage so Langfuse computes cost and renders input/output.
 *
 * `parentSpanContext` (from a span's `.otelSpan.spanContext()`) pins the parent
 * explicitly. Needed because the tracing bundle and the runtime can each carry
 * their own @opentelemetry/api instance — their context registries are then
 * disjoint, so context-based parenting silently falls back to the trace root.
 */
export async function beginGeneration(name, attributes = {}, parentSpanContext = null) {
  if (!(await isLangfuseEnabled())) return NOOP;
  try {
    const { startObservation } = await loadTracing();
    const opts = { asType: "generation" };
    if (parentSpanContext) opts.parentSpanContext = parentSpanContext;
    const gen = startObservation(name, attributes, opts);
    return gen || NOOP;
  } catch (e) {
    console.error("[langfuse] beginGeneration failed:", e?.message || e);
    return NOOP;
  }
}

/**
 * Set the TRACE-level input/output (what Langfuse shows on the trace row and
 * detail header). A span's own `update({input})` only writes the observation
 * attributes, so the trace stays empty without this.
 *
 * Writes straight onto the span, so it works even after the originating
 * context has unwound (unlike the SDK's setActiveTraceIO, which needs an
 * active span and the same @opentelemetry/api instance).
 */
export async function setTraceIO(span, { input, output } = {}) {
  if (!span || span === NOOP || !span.otelSpan) return;
  try {
    const { createTraceAttributes } = await loadTracing();
    const attrs = createTraceAttributes({ input, output });
    if (Object.keys(attrs).length) span.otelSpan.setAttributes(attrs);
  } catch (e) {
    console.error("[langfuse] setTraceIO failed:", e?.message || e);
  }
}

// Langfuse ingestion rejects oversized payloads, so this stays bounded by
// default even though the local store keeps everything: the cloud API has real
// request limits, while SQLite does not. Set LANGFUSE_MAX_CONTENT_BYTES=0 to
// send verbatim (and accept that very large traces may be rejected upstream).
const MAX_CONTENT_BYTES = (() => {
  const raw = process.env.LANGFUSE_MAX_CONTENT_BYTES;
  if (raw === undefined || raw === "") return 256 * 1024;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 256 * 1024;
  return n <= 0 ? 0 : n;
})();

/**
 * Update a live generation's attributes (e.g. replace the placeholder input
 * with the body that actually went upstream — which may carry gateway-injected
 * directives the client never sent).
 */
export async function updateGeneration(gen, attributes = {}) {
  if (!gen || gen === NOOP) return;
  try {
    const attrs = {};
    if (attributes.input !== undefined) attrs.input = summarizePayload(attributes.input, MAX_CONTENT_BYTES);
    if (attributes.output !== undefined) attrs.output = summarizePayload(attributes.output, MAX_CONTENT_BYTES);
    if (attributes.metadata !== undefined) attrs.metadata = attributes.metadata;
    if (Object.keys(attrs).length) gen.update(attrs);
  } catch { /* fail-open */ }
}

/** OpenTelemetry span context for a Langfuse observation, or null. */
export function spanContextOf(span) {
  try {
    return span?.otelSpan?.spanContext?.() || null;
  } catch {
    return null;
  }
}

/**
 * Finish a generation with the outcome of the upstream call.
 * usage: { input, output } in tokens — Langfuse adds `total` itself.
 */
export function endGeneration(gen, { output, usage, level, statusMessage, completionStartTime } = {}) {
  if (!gen || gen === NOOP) return;
  try {
    const attrs = {};
    if (output !== undefined) attrs.output = output;
    if (usage) {
      attrs.usageDetails = { input: usage.input || 0, output: usage.output || 0 };
    }
    if (completionStartTime) attrs.completionStartTime = completionStartTime;
    if (level) attrs.level = level;
    if (statusMessage) attrs.statusMessage = statusMessage;
    if (Object.keys(attrs).length) gen.update(attrs);
    gen.end();
  } catch { /* fail-open */ }
}
