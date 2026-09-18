import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";

// Isolate DB to a temp dir BEFORE any db import resolves paths
const TMP = path.join(os.tmpdir(), `9router-trace-test-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });
process.env.DATA_DIR = TMP;

let db;
let traceRepo;

beforeAll(async () => {
  db = await import("../../src/lib/db/index.js");
  traceRepo = await import("../../src/lib/db/repos/traceRepo.js");
  await db.initDb();
  // Observability is opt-in (settings default false) — enable for the test DB
  await db.updateSettings({ enableObservability: true });
}, 30000);

describe("traceRepo smoke", () => {
  it("creates a trace, spans, aggregates, scores, prompts", async () => {
    const id = await db.createTrace({
      requestedModel: "combo-fast",
      sessionId: "sess-abc",
      endpoint: "/v1/chat/completions",
      status: "running",
    });
    expect(id).toBeTruthy();

    await db.saveRequestDetail({
      provider: "openai", model: "gpt-5", status: "error",
      latency: { ttft: 0, total: 320 },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      response: { error: "HTTP 401" },
      traceId: id, spanIndex: 0, spanName: "attempt 1: openai/gpt-5 @ acc-1",
    });
    await db.saveRequestDetail({
      provider: "anthropic", model: "claude-sonnet-5", status: "success",
      latency: { ttft: 480, total: 1200 },
      tokens: { prompt_tokens: 1200, completion_tokens: 350 },
      response: { content: "hi" },
      traceId: id, spanIndex: 1, spanName: "attempt 2: anthropic/claude-sonnet-5 @ acc-2",
    });

    // saveRequestDetail buffers; force flush by waiting past interval or batch
    await new Promise((r) => setTimeout(r, 5500));
    await traceRepo.refreshTraceAggregates(id);
    await db.finalizeTrace(id, { status: "success" });

    const trace = await db.getTraceById(id);
    expect(trace).toBeTruthy();
    expect(trace.status).toBe("success");
    expect(trace.spans).toBe(2);
    expect(trace.latencyTotal).toBe(1200);
    expect(trace.promptTokens).toBe(1200);
    expect(trace.completionTokens).toBe(350);

    const spans = await db.getTraceSpans(id);
    expect(spans.length).toBe(2);
    expect(spans[0].spanIndex).toBe(0);
    expect(spans[1].spanIndex).toBe(1);

    const { traces } = await db.getTraces({});
    expect(traces.length).toBeGreaterThanOrEqual(1);

    const sessions = await db.getSessions({});
    expect(sessions.length).toBe(1);
    expect(sessions[0].sessionId).toBe("sess-abc");
    expect(sessions[0].requests).toBe(1);

    await db.addTraceScore({ traceId: id, score: 1, comment: "nice fallback" });
    expect((await db.getTraceScores(id)).length).toBe(1);

    await db.savePrompt({ name: "test prompt", content: "hello world", sourceTraceId: id });
    expect((await db.getPrompts()).length).toBe(1);
  }, 30000);
});
