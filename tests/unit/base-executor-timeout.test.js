// Locks BaseExecutor.execute header-timeout selection by stream mode.
//
// Regression: non-stream upstreams only send response headers after the whole body
// is generated, so reusing the streaming connect budget (60s) aborted long-thinking
// non-stream requests mid-generation (surfaced as a misleading "fetch connect timeout",
// then amplified by 502 retries into a ~249s failure).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const {
  FETCH_CONNECT_TIMEOUT_MS,
  NONSTREAM_RESPONSE_TIMEOUT_MS,
} = await import("../../open-sse/config/runtimeConfig.js");

const creds = { apiKey: "k" };

// Hang until the executor's AbortSignal fires, then reject with that signal's reason —
// matching what real fetch does, so base.js's isConnectTimeout branch behaves correctly.
function hangUntilAborted(_url, opts) {
  return new Promise((_resolve, reject) => {
    const signal = opts?.signal;
    if (!signal) return;
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function makeExec(config = {}) {
  // attempts: 0 keeps a header timeout from entering the 502 retry loop, so each
  // assertion observes a single timeout instead of a retry cascade.
  return new BaseExecutor("test", {
    baseUrl: "https://x/api",
    retry: { 502: { attempts: 0 } },
    ...config,
  });
}

// Resolves once execute() settles; exposes that state without awaiting the promise,
// so the test can assert "still running" at intermediate timer marks.
function track(promise) {
  const state = { settled: false, error: null };
  promise.then(
    () => { state.settled = true; },
    (error) => { state.settled = true; state.error = error; },
  );
  return state;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(hangUntilAborted);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BaseExecutor.execute — header timeout budget by stream mode", () => {
  it("non-stream survives past the streaming connect budget", async () => {
    const state = track(makeExec().execute({ model: "m", body: {}, stream: false, credentials: creds }));

    await vi.advanceTimersByTimeAsync(FETCH_CONNECT_TIMEOUT_MS + 1000);
    expect(state.settled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("non-stream aborts at the non-stream response budget", async () => {
    const state = track(makeExec().execute({ model: "m", body: {}, stream: false, credentials: creds }));

    await vi.advanceTimersByTimeAsync(NONSTREAM_RESPONSE_TIMEOUT_MS + 1000);
    expect(state.settled).toBe(true);
    expect(state.error?.message).toBe("non-stream response timeout");
  });

  it("stream still aborts at the streaming connect budget", async () => {
    const state = track(makeExec().execute({ model: "m", body: {}, stream: true, credentials: creds }));

    await vi.advanceTimersByTimeAsync(FETCH_CONNECT_TIMEOUT_MS + 1000);
    expect(state.settled).toBe(true);
    expect(state.error?.message).toBe("fetch connect timeout");
  });

  it("stream is not held to the longer non-stream budget", async () => {
    const state = track(makeExec().execute({ model: "m", body: {}, stream: true, credentials: creds }));

    await vi.advanceTimersByTimeAsync(FETCH_CONNECT_TIMEOUT_MS + 1000);
    expect(state.settled).toBe(true);
    // Guard against the budgets being swapped: stream must not keep waiting until
    // NONSTREAM_RESPONSE_TIMEOUT_MS.
    expect(NONSTREAM_RESPONSE_TIMEOUT_MS).toBeGreaterThan(FETCH_CONNECT_TIMEOUT_MS);
  });

  it("explicit config.timeoutMs overrides the non-stream budget", async () => {
    const state = track(makeExec({ timeoutMs: 5000 }).execute({ model: "m", body: {}, stream: false, credentials: creds }));

    await vi.advanceTimersByTimeAsync(5001);
    expect(state.settled).toBe(true);
    expect(state.error?.message).toBe("non-stream response timeout");
  });

  it("explicit config.timeoutMs overrides the stream budget", async () => {
    const state = track(makeExec({ timeoutMs: 5000 }).execute({ model: "m", body: {}, stream: true, credentials: creds }));

    await vi.advanceTimersByTimeAsync(5001);
    expect(state.settled).toBe(true);
    expect(state.error?.message).toBe("fetch connect timeout");
  });
});
