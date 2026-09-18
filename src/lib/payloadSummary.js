// Summarize oversized observability payloads instead of blindly chopping them.
//
// Why this exists: agent traffic (Claude Code etc.) routinely sends multi-MB
// request bodies. Keeping the first N characters loses the most interesting
// part — gateway-injected directives (e.g. xiaomi-mimo's thinking prompt) are
// appended to the END of the system message, and the request's actual intent
// lives in the LAST user turn. A head-only preview shows neither.
//
// So when a payload exceeds its budget we keep:
//   - the system prompt's TAIL (where injected directives are appended)
//   - the last user message (what the request is actually about)
//   - shape/params (message count, roles, model, sampling params, tool count)
// and mark the result with `_truncated` so consumers can tell it apart.
//
// Used by both the local SQLite store (small budget, thousands of rows) and the
// Langfuse exporter (larger budget, single send) so the two never disagree.

const SYSTEM_TAIL_CHARS = 1200;
const USER_HEAD_CHARS = 1200;
const FALLBACK_PREVIEW_CHARS = 500;

// Top-level knobs worth keeping even when the messages are summarized.
const INTERESTING_PARAMS = [
  "model", "stream", "max_tokens", "max_completion_tokens", "temperature", "top_p",
  "tool_choice", "reasoning_effort", "thinking", "response_format", "n",
];

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : b?.text || b?.type || ""))
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function byteSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null) ?? "", "utf8");
  } catch {
    return -1;
  }
}

function summarizeMessages(payload) {
  const messages = payload.messages;
  const summary = {
    _truncated: true,
    _originalBytes: byteSize(payload),
    messageCount: messages.length,
    roles: messages.map((m) => m?.role).filter(Boolean).slice(0, 40),
  };

  const params = {};
  for (const k of INTERESTING_PARAMS) {
    if (payload[k] !== undefined) params[k] = payload[k];
  }
  if (Object.keys(params).length) summary.params = params;
  if (Array.isArray(payload.tools)) summary.toolCount = payload.tools.length;

  // Injected directives are appended to the system prompt → keep its tail.
  const sys = messages.find((m) => m?.role === "system");
  if (sys) {
    const text = textOf(sys.content);
    summary.systemTail = text.length > SYSTEM_TAIL_CHARS
      ? `…${text.slice(-SYSTEM_TAIL_CHARS)}`
      : text;
    summary.systemChars = text.length;
  } else {
    // No system message: the injection path may prepend one instead.
    const first = messages[0];
    if (first?.["role"] === "system") summary.systemTail = textOf(first.content).slice(-SYSTEM_TAIL_CHARS);
  }

  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  if (lastUser) summary.lastUserMessage = textOf(lastUser.content).slice(0, USER_HEAD_CHARS);

  return summary;
}

function summarizeResponse(payload) {
  const summary = { _truncated: true, _originalBytes: byteSize(payload) };
  if (typeof payload.content === "string") {
    summary.content = payload.content.slice(0, USER_HEAD_CHARS);
    summary.contentChars = payload.content.length;
  }
  if (typeof payload.thinking === "string") {
    summary.thinkingChars = payload.thinking.length;
    summary.thinkingTail = payload.thinking.slice(-SYSTEM_TAIL_CHARS);
  }
  for (const k of ["tool_calls", "finish_reason", "status", "error", "type"]) {
    if (payload[k] !== undefined) summary[k] = payload[k];
  }
  return summary;
}

/**
 * Return `payload` unchanged when it fits `maxBytes`; otherwise return a
 * structure-preserving summary. Never throws.
 *
 * `maxBytes <= 0` means "no limit" — store the payload verbatim. Traces are a
 * debugging tool: reading the real system prompt / request is the whole point,
 * so a summary is a fallback for operators who choose to bound disk usage,
 * not the default.
 */
export function summarizePayload(payload, maxBytes) {
  if (payload === undefined || payload === null) return payload;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return payload;

  const size = byteSize(payload);
  if (size >= 0 && size <= maxBytes) return payload;
  if (size < 0) return { _omitted: "unserializable" };

  try {
    if (Array.isArray(payload.messages)) return summarizeMessages(payload);
    if (payload.content !== undefined || payload.thinking !== undefined || payload.error !== undefined) {
      return summarizeResponse(payload);
    }
    return {
      _truncated: true,
      _originalBytes: size,
      _preview: JSON.stringify(payload).slice(0, FALLBACK_PREVIEW_CHARS),
    };
  } catch {
    return { _truncated: true, _originalBytes: size };
  }
}
