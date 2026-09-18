"use client";

import { useState, useEffect, useCallback } from "react";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";
import Drawer from "@/shared/components/Drawer";
import Pagination from "@/shared/components/Pagination";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { cn } from "@/shared/utils/cn";

function formatMs(ms) {
  if (!ms && ms !== 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n) {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}

function formatCost(c) {
  if (!c) return "$0";
  if (c < 0.01) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(2)}`;
}

function StatusBadge({ status }) {
  const map = {
    success: { variant: "success", icon: "check_circle" },
    error: { variant: "error", icon: "error" },
    running: { variant: "warning", icon: "pending" },
  };
  const { variant, icon } = map[status] || map.running;
  return (
    <Badge variant={variant} size="sm" icon={icon}>
      {status}
    </Badge>
  );
}

function TextBlock({ label, text, tail = false }) {
  return (
    <div className="rounded border border-black/5 dark:border-white/5 p-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted mb-1">
        {label}
      </div>
      <div className="text-[11px] text-text-main whitespace-pre-wrap break-words max-h-60 overflow-auto">
        {tail ? `…${text}` : text}
      </div>
    </div>
  );
}

// Render a stored payload readably:
//  - chat messages → role/content transcript
//  - oversized payload summary (from payloadSummary.js) → its kept fields, so a
//    gateway-injected directive in `systemTail` is readable, not escaped JSON
//  - anything else → formatted JSON
function PayloadView({ payload }) {
  const messages = payload?.messages;
  if (Array.isArray(messages) && messages.length) {
    return (
      <div className="space-y-2">
        {messages.map((m, i) => (
          <TextBlock
            key={i}
            label={m.role || "unknown"}
            text={typeof m.content === "string"
              ? m.content
              : Array.isArray(m.content)
                ? m.content.map((b) => (typeof b === "string" ? b : b?.text || JSON.stringify(b))).join("\n")
                : JSON.stringify(m.content, null, 2)}
          />
        ))}
      </div>
    );
  }

  if (payload?._truncated) {
    const kb = Math.round((payload._originalBytes || 0) / 1024);
    return (
      <div className="space-y-2">
        <p className="text-[10px] text-text-muted">
          Payload summarized ({kb} KB → {JSON.stringify(payload).length} chars).
          {payload.messageCount !== undefined && ` ${payload.messageCount} messages.`}
          {payload.toolCount !== undefined && ` ${payload.toolCount} tools.`}
        </p>
        {payload.params && (
          <pre className="text-[10px] text-text-muted whitespace-pre-wrap break-all font-mono">
            {JSON.stringify(payload.params)}
          </pre>
        )}
        {payload.systemTail && <TextBlock label="system prompt (tail)" text={payload.systemTail} tail />}
        {payload.lastUserMessage && <TextBlock label="last user message" text={payload.lastUserMessage} />}
        {payload.content && <TextBlock label="content" text={payload.content} />}
        {payload.thinkingTail && <TextBlock label="thinking (tail)" text={payload.thinkingTail} tail />}
        {payload.tool_calls && <TextBlock label="tool calls" text={JSON.stringify(payload.tool_calls, null, 2)} />}
        {payload.error && <TextBlock label="error" text={String(payload.error)} />}
      </div>
    );
  }

  // Assistant response shape: { content, thinking, tool_calls, ... } — show the
  // parts as readable blocks rather than one escaped JSON string.
  if (payload && typeof payload === "object" && (payload.content !== undefined || payload.thinking !== undefined)) {
    return (
      <div className="space-y-2">
        {payload.content !== undefined && payload.content !== null && (
          <TextBlock label="content" text={typeof payload.content === "string" ? payload.content : JSON.stringify(payload.content, null, 2)} />
        )}
        {payload.thinking && <TextBlock label="thinking" text={String(payload.thinking)} />}
        {payload.tool_calls && <TextBlock label="tool calls" text={JSON.stringify(payload.tool_calls, null, 2)} />}
        {payload.finish_reason && <TextBlock label="finish reason" text={String(payload.finish_reason)} />}
        {payload.error && <TextBlock label="error" text={String(payload.error)} />}
        {payload.type && <TextBlock label="type" text={String(payload.type)} />}
      </div>
    );
  }

  return (
    <pre className="text-[11px] text-text-muted whitespace-pre-wrap break-all max-h-80 overflow-auto font-mono">
      {typeof payload === "string" ? payload : JSON.stringify(payload ?? {}, null, 2)}
    </pre>
  );
}

function CollapsibleSection({ title, children, defaultOpen = false }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className="border border-black/5 dark:border-white/5 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-2.5 bg-black/[0.02] dark:bg-white/[0.02] hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors"
      >
        <span className="font-medium text-xs text-text-main">{title}</span>
        <span className={cn("material-symbols-outlined text-[16px] text-text-muted transition-transform duration-200", isOpen && "rotate-90")}>
          chevron_right
        </span>
      </button>
      {isOpen && (
        <div className="p-3 border-t border-black/5 dark:border-white/5">
          <PayloadView payload={children} />
        </div>
      )}
    </div>
  );
}

// ── Trace detail: span waterfall + payload viewer + scoring + save-as-prompt ──
function TraceDetailDrawer({ traceId, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedSpan, setExpandedSpan] = useState(null);
  const [spanDetail, setSpanDetail] = useState(null);
  const [scoreComment, setScoreComment] = useState("");
  const [savingPrompt, setSavingPrompt] = useState(false);
  const { copied, copy } = useCopyToClipboard(2000);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/traces/${traceId}`);
      if (!res.ok) throw new Error("Failed to load trace");
      setData(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [traceId]);

  useEffect(() => { load(); }, [load]);

  // Auto-open the first span so prompt/response are visible immediately
  // (Langfuse-style: the trace view leads with input/output, not a collapsed list).
  useEffect(() => {
    const firstSpan = data?.spans?.[0];
    if (!firstSpan || expandedSpan) return;
    setExpandedSpan(firstSpan.id);
    setSpanDetail(null);
    fetch(`/api/traces/${traceId}/spans/${firstSpan.id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => d && setSpanDetail(d.detail))
      .catch(() => {});
  }, [data, expandedSpan, traceId]);

  const submitScore = async (score) => {
    try {
      const res = await fetch(`/api/traces/${traceId}/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ score, comment: scoreComment || undefined }),
      });
      if (res.ok) {
        const d = await res.json();
        setData((prev) => ({ ...prev, scores: d.scores }));
        setScoreComment("");
      }
    } catch { /* fail-open */ }
  };

  const removeScore = async (scoreId) => {
    try {
      const res = await fetch(`/api/traces/${traceId}/score?scoreId=${scoreId}`, { method: "DELETE" });
      if (res.ok) {
        const d = await res.json();
        setData((prev) => ({ ...prev, scores: d.scores }));
      }
    } catch { /* fail-open */ }
  };

  const saveAsPrompt = async (span) => {
    setSavingPrompt(true);
    try {
      // spanDetail was loaded when the span was expanded (contains request.messages)
      const messages = spanDetail?.request?.messages;
      const content = messages
        ? messages.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n\n")
        : JSON.stringify(spanDetail?.request || span, null, 2);
      await fetch("/api/traces/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${span.model || "prompt"} @ ${new Date(span.timestamp).toLocaleString()}`,
          content,
          sourceTraceId: traceId,
        }),
      });
    } catch { /* fail-open */ } finally {
      setSavingPrompt(false);
    }
  };

  const trace = data?.trace;
  const spans = data?.spans || [];
  const maxLatency = Math.max(...spans.map((s) => s.latency?.total || 0), 1);

  return (
    <Drawer isOpen onClose={onClose} title={trace ? `Trace · ${trace.requestedModel || "unknown"}` : "Trace"} width="xl">
      {loading && <p className="text-sm text-text-muted p-4">Loading…</p>}
      {error && <p className="text-sm text-red-500 p-4">{error}</p>}
      {trace && (
        <div className="p-4 space-y-4 overflow-y-auto">
          {/* Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-lg bg-surface-2 p-3">
              <p className="text-[11px] text-text-muted">Status</p>
              <StatusBadge status={trace.status} />
            </div>
            <div className="rounded-lg bg-surface-2 p-3">
              <p className="text-[11px] text-text-muted">Latency</p>
              <p className="text-sm font-semibold text-text-main">{formatMs(trace.latencyTotal)}</p>
            </div>
            <div className="rounded-lg bg-surface-2 p-3">
              <p className="text-[11px] text-text-muted">Tokens (in/out)</p>
              <p className="text-sm font-semibold text-text-main">{formatTokens(trace.promptTokens)} / {formatTokens(trace.completionTokens)}</p>
            </div>
            <div className="rounded-lg bg-surface-2 p-3">
              <p className="text-[11px] text-text-muted">Spans / Cost</p>
              <p className="text-sm font-semibold text-text-main">{trace.spans} · {formatCost(trace.cost)}</p>
            </div>
          </div>
          {trace.errorSummary && (
            <p className="text-xs text-red-500 bg-red-500/5 rounded-lg p-2.5">{trace.errorSummary}</p>
          )}
          {trace.sessionId && (
            <p className="text-[11px] text-text-muted break-all">session: {trace.sessionId}</p>
          )}

          {/* Span waterfall */}
          <div>
            <h4 className="text-sm font-semibold text-text-main mb-2">Spans ({spans.length})</h4>
            <div className="space-y-1.5">
              {spans.map((span) => (
                <div key={span.id} className="rounded-lg border border-black/5 dark:border-white/5 overflow-hidden">
                  <button
                    type="button"
                    className="w-full text-left p-2.5 hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors"
                    onClick={async () => {
                      if (expandedSpan === span.id) { setExpandedSpan(null); setSpanDetail(null); return; }
                      setExpandedSpan(span.id);
                      setSpanDetail(null);
                      try {
                        const res = await fetch(`/api/traces/${traceId}/spans/${span.id}`);
                        if (res.ok) setSpanDetail((await res.json()).detail);
                      } catch { /* ignore */ }
                    }}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <StatusBadge status={span.status} />
                      <span className="text-xs font-medium text-text-main">{span.spanName || `${span.provider}/${span.model}`}</span>
                      <span className="text-[11px] text-text-muted">{formatMs(span.latency?.total)}</span>
                      <span className="text-[11px] text-text-muted">{formatTokens((span.tokens?.prompt_tokens || 0) + (span.tokens?.completion_tokens || 0))} tok</span>
                    </div>
                    {/* latency bar relative to slowest span */}
                    <div className="mt-1.5 h-1.5 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
                      <div
                        className={cn("h-full rounded-full", span.status === "success" ? "bg-green-500/60" : "bg-red-500/60")}
                        style={{ width: `${Math.max(4, ((span.latency?.total || 0) / maxLatency) * 100)}%` }}
                      />
                    </div>
                  </button>
                  {expandedSpan === span.id && (
                    <div className="p-3 border-t border-black/5 dark:border-white/5 space-y-2 bg-black/[0.01] dark:bg-white/[0.01]">
                      {!spanDetail && <p className="text-[11px] text-text-muted">Loading span detail…</p>}
                      {spanDetail && (
                        <>
                          <CollapsibleSection title="Prompt / Client Request" defaultOpen>{spanDetail.request}</CollapsibleSection>
                          <CollapsibleSection title="Provider Request">{spanDetail.providerRequest}</CollapsibleSection>
                          <CollapsibleSection title="Provider Response">{spanDetail.providerResponse}</CollapsibleSection>
                          <CollapsibleSection title="Response" defaultOpen>{spanDetail.response}</CollapsibleSection>
                          <div className="flex gap-2 pt-1">
                            <Button size="sm" variant="secondary" icon="save" onClick={() => saveAsPrompt(span)} disabled={savingPrompt}>
                              Save as Prompt
                            </Button>
                            <Button size="sm" variant="ghost" icon={copied ? "check" : "content_copy"} onClick={() => copy(JSON.stringify(spanDetail.request || {}, null, 2))}>
                              Copy request
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {!spans.length && <p className="text-xs text-text-muted">No spans recorded for this trace.</p>}
            </div>
          </div>

          {/* Scoring (Langfuse-style) */}
          <div className="border-t border-black/5 dark:border-white/5 pt-3">
            <h4 className="text-sm font-semibold text-text-main mb-2">Score</h4>
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" variant="secondary" icon="thumb_up" onClick={() => submitScore(1)}>
                Good
              </Button>
              <Button size="sm" variant="secondary" icon="thumb_down" onClick={() => submitScore(-1)}>
                Bad
              </Button>
              <input
                value={scoreComment}
                onChange={(e) => setScoreComment(e.target.value)}
                placeholder="Comment (optional)"
                className={cn(
                  "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
                  "flex-1 min-w-[160px] text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
                )}
              />
            </div>
            {(data?.scores || []).length > 0 && (
              <div className="mt-2 space-y-1">
                {data.scores.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 text-[11px] text-text-muted">
                    <span className="material-symbols-outlined text-[14px]">{s.score === 1 ? "thumb_up" : s.score === -1 ? "thumb_down" : "flag"}</span>
                    <span>{s.comment || (s.score === 1 ? "Good" : s.score === -1 ? "Bad" : "Neutral")}</span>
                    <span>· {new Date(s.createdAt).toLocaleString()}</span>
                    <Button size="sm" variant="ghost" icon="delete" onClick={() => removeScore(s.id)} aria-label="Delete score" />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

// ── Traces list tab ──
function TracesList({ sessionIdFilter, onClearSession }) {
  const [traces, setTraces] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, totalItems: 0, totalPages: 0 });
  const [loading, setLoading] = useState(false);
  const [selectedTraceId, setSelectedTraceId] = useState(null);
  const [filters, setFilters] = useState({ status: "", requestedModel: "", startDate: "", endDate: "" });

  const load = useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pagination.pageSize) });
      if (filters.status) params.set("status", filters.status);
      if (filters.requestedModel) params.set("requestedModel", filters.requestedModel);
      if (filters.startDate) params.set("startDate", filters.startDate);
      if (filters.endDate) params.set("endDate", filters.endDate);
      if (sessionIdFilter) params.set("sessionId", sessionIdFilter);
      const res = await fetch(`/api/traces?${params}`);
      const data = await res.json();
      setTraces(data.traces || []);
      if (data.pagination) setPagination(data.pagination);
    } catch { /* keep previous list */ } finally {
      setLoading(false);
    }
  }, [filters, sessionIdFilter, pagination.pageSize]);

  useEffect(() => { load(1); }, [load]);

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <label htmlFor="trace-status-filter" className="text-sm font-medium text-text-main">Status</label>
          <select
            id="trace-status-filter"
            value={filters.status}
            onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
            className={cn(
              "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
              "w-full min-w-0 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
            )}
            style={{ colorScheme: "auto" }}
          >
            <option value="">All Statuses</option>
            <option value="success">Success</option>
            <option value="error">Error</option>
            <option value="running">Running</option>
          </select>
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <label htmlFor="trace-model-filter" className="text-sm font-medium text-text-main">Model</label>
          <input
            id="trace-model-filter"
            value={filters.requestedModel}
            onChange={(e) => setFilters((f) => ({ ...f, requestedModel: e.target.value }))}
            placeholder="Filter by model…"
            className={cn(
              "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
              "w-full min-w-0 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
            )}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <label htmlFor="trace-start-filter" className="text-sm font-medium text-text-main">Start Date</label>
          <input
            id="trace-start-filter"
            type="datetime-local"
            value={filters.startDate}
            onChange={(e) => setFilters((f) => ({ ...f, startDate: e.target.value }))}
            className={cn(
              "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
              "w-full min-w-0 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
            )}
            style={{ colorScheme: "auto" }}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <label htmlFor="trace-end-filter" className="text-sm font-medium text-text-main">End Date</label>
          <input
            id="trace-end-filter"
            type="datetime-local"
            value={filters.endDate}
            onChange={(e) => setFilters((f) => ({ ...f, endDate: e.target.value }))}
            className={cn(
              "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
              "w-full min-w-0 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
            )}
            style={{ colorScheme: "auto" }}
          />
        </div>

        <div className="flex items-center gap-2">
          {sessionIdFilter && (
            <Button variant="ghost" icon="close" onClick={onClearSession}>
              session: {sessionIdFilter.slice(0, 12)}…
            </Button>
          )}
          <Button variant="secondary" icon="refresh" onClick={() => load(1)}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Table */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-black/5 dark:border-white/5 text-left text-[11px] text-text-muted uppercase">
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Model</th>
                <th className="px-3 py-2">Spans</th>
                <th className="px-3 py-2">Latency</th>
                <th className="px-3 py-2">Tokens</th>
                <th className="px-3 py-2">Cost</th>
                <th className="px-3 py-2">Session</th>
              </tr>
            </thead>
            <tbody>
              {traces.map((t) => (
                <tr
                  key={t.id}
                  className="border-b border-black/[0.04] dark:border-white/[0.04] hover:bg-black/[0.02] dark:hover:bg-white/[0.02] cursor-pointer transition-colors"
                  onClick={() => setSelectedTraceId(t.id)}
                >
                  <td className="px-3 py-2 text-xs text-text-muted whitespace-nowrap">{new Date(t.timestamp).toLocaleString()}</td>
                  <td className="px-3 py-2"><StatusBadge status={t.status} /></td>
                  <td className="px-3 py-2 text-xs font-medium text-text-main">{t.requestedModel || "-"}</td>
                  <td className="px-3 py-2 text-xs text-text-muted whitespace-nowrap">{t.spans} attempt{t.spans === 1 ? "" : "s"}</td>
                  <td className="px-3 py-2 text-xs text-text-muted">{formatMs(t.latencyTotal)}</td>
                  <td className="px-3 py-2 text-xs text-text-muted whitespace-nowrap">{formatTokens(t.promptTokens)} / {formatTokens(t.completionTokens)}</td>
                  <td className="px-3 py-2 text-xs text-text-muted whitespace-nowrap">{formatCost(t.cost)}</td>
                  <td className="px-3 py-2 text-[11px] text-text-muted max-w-[120px] truncate">{t.sessionId ? t.sessionId.slice(0, 10) + "…" : "-"}</td>
                </tr>
              ))}
              {!traces.length && !loading && (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-xs text-text-muted">No traces yet. Send a request through the gateway to see it here.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Pagination
        currentPage={pagination.page}
        pageSize={pagination.pageSize}
        totalItems={pagination.totalItems}
        onPageChange={(p) => load(p)}
      />

      {selectedTraceId && <TraceDetailDrawer traceId={selectedTraceId} onClose={() => setSelectedTraceId(null)} />}
    </div>
  );
}

// ── Sessions tab ──
function SessionsList({ onSelectSession }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/traces/sessions");
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch { /* keep previous */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" variant="secondary" icon="refresh" onClick={load}>
          Refresh
        </Button>
      </div>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-black/5 dark:border-white/5 text-left text-[11px] text-text-muted uppercase">
                <th className="px-3 py-2">Session</th>
                <th className="px-3 py-2">Requests</th>
                <th className="px-3 py-2">Success</th>
                <th className="px-3 py-2">Errors</th>
                <th className="px-3 py-2">Tokens</th>
                <th className="px-3 py-2">Cost</th>
                <th className="px-3 py-2">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr
                  key={s.sessionId}
                  className="border-b border-black/[0.04] dark:border-white/[0.04] hover:bg-black/[0.02] dark:hover:bg-white/[0.02] cursor-pointer transition-colors"
                  onClick={() => onSelectSession(s.sessionId)}
                >
                  <td className="px-3 py-2 text-xs font-mono text-text-main max-w-[220px] truncate">{s.sessionId}</td>
                  <td className="px-3 py-2 text-xs text-text-muted whitespace-nowrap">{s.requests}</td>
                  <td className="px-3 py-2 text-xs text-green-600 dark:text-green-400">{s.successes}</td>
                  <td className="px-3 py-2 text-xs text-red-500">{s.errors}</td>
                  <td className="px-3 py-2 text-xs text-text-muted whitespace-nowrap">{formatTokens(s.promptTokens)} / {formatTokens(s.completionTokens)}</td>
                  <td className="px-3 py-2 text-xs text-text-muted whitespace-nowrap">{formatCost(s.cost)}</td>
                  <td className="px-3 py-2 text-xs text-text-muted whitespace-nowrap">{s.lastSeen ? new Date(s.lastSeen).toLocaleString() : "-"}</td>
                </tr>
              ))}
              {!sessions.length && !loading && (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-xs text-text-muted">No sessions yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ── Prompt library tab ──
function PromptLibrary() {
  const [prompts, setPrompts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [viewing, setViewing] = useState(null);
  const { copied, copy } = useCopyToClipboard(2000);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/traces/prompts");
      const data = await res.json();
      setPrompts(data.prompts || []);
    } catch { /* keep previous */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const remove = async (id) => {
    try {
      await fetch(`/api/traces/prompts/${id}`, { method: "DELETE" });
      setPrompts((p) => p.filter((x) => x.id !== id));
      if (viewing?.id === id) setViewing(null);
    } catch { /* ignore */ }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" variant="secondary" icon="refresh" onClick={load}>
          Refresh
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {prompts.map((p) => (
          <Card key={p.id} className="p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-text-main truncate">{p.name}</p>
                <p className="text-[11px] text-text-muted">{new Date(p.updatedAt).toLocaleString()}{p.sourceTraceId ? " · from trace" : ""}</p>
              </div>
              <div className="flex gap-1 shrink-0">
                <Button size="sm" variant="ghost" icon={copied ? "check" : "content_copy"} onClick={() => copy(p.content)} aria-label="Copy prompt" />
                <Button size="sm" variant="ghost" icon="delete" onClick={() => remove(p.id)} aria-label="Delete prompt" />
              </div>
            </div>
            <button type="button" className="w-full text-left" onClick={() => setViewing(viewing?.id === p.id ? null : p)}>
              <pre className="text-[11px] text-text-muted whitespace-pre-wrap break-all line-clamp-3 font-mono">{p.content.slice(0, 300)}</pre>
            </button>
            {viewing?.id === p.id && (
              <pre className="text-[11px] text-text-muted whitespace-pre-wrap break-all max-h-96 overflow-auto font-mono border-t border-black/5 dark:border-white/5 pt-2">{p.content}</pre>
            )}
          </Card>
        ))}
        {!prompts.length && !loading && (
          <p className="text-xs text-text-muted col-span-2 text-center py-8">No saved prompts. Open a trace span and click &quot;Save as Prompt&quot;.</p>
        )}
      </div>
    </div>
  );
}

const TABS = [
  { value: "traces", label: "Traces" },
  { value: "sessions", label: "Sessions" },
  { value: "prompts", label: "Prompt Library" },
];

export default function TracesClient() {
  const [tab, setTab] = useState("traces");
  const [sessionIdFilter, setSessionIdFilter] = useState(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold text-text-main">Traces</h1>
          <p className="text-xs text-text-muted">Request-level observability: fallback chains, sessions, scoring.</p>
        </div>
        <SegmentedControl options={TABS} value={tab} onChange={setTab} />
      </div>

      {tab === "traces" && (
        <TracesList sessionIdFilter={sessionIdFilter} onClearSession={() => setSessionIdFilter(null)} />
      )}
      {tab === "sessions" && (
        <SessionsList onSelectSession={(sid) => { setSessionIdFilter(sid); setTab("traces"); }} />
      )}
      {tab === "prompts" && <PromptLibrary />}
    </div>
  );
}
