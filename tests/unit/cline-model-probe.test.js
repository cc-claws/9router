// Cline's /models endpoint returns the provider's whole routing catalog
// (~440 entries: `:batch` offline jobs, retired upstreams, models gated behind
// a ClinePass subscription) rather than the account's usable set. Importing it
// verbatim filled the dashboard with models that answer 403/404/500, so the
// dashboard now probes candidates first. These tests pin the probe contract.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { probeClineModels, isBatchModelId } = await import(
  "../../open-sse/services/clinepassModels.js"
);

describe("isBatchModelId", () => {
  it("flags :batch suffixed ids", () => {
    expect(isBatchModelId("openai/gpt-5.4:batch")).toBe(true);
  });

  it("leaves interactive ids alone", () => {
    expect(isBatchModelId("openai/gpt-5.4")).toBe(false);
    expect(isBatchModelId("z-ai/glm-5.2:free")).toBe(false);
    expect(isBatchModelId(null)).toBe(false);
  });
});

describe("probeClineModels", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(obj, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => obj,
    };
  }

  function urlOf(call) {
    return call[0];
  }

  function bodyOf(call) {
    return JSON.parse(call[1].body);
  }

  it("keeps models that return choices and reports the rest", async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const { model } = JSON.parse(init.body);
      if (model === "anthropic/claude-sonnet-4.6") {
        return jsonResponse({ data: { choices: [{ message: { content: "1" } }] } });
      }
      return jsonResponse({ error: "empty response content", success: false }, 500);
    });

    const result = await probeClineModels(
      { accessToken: "workos:token" },
      ["anthropic/claude-sonnet-4.6", "google/gemini-2.5-pro"]
    );

    expect(result.accessible).toEqual(["anthropic/claude-sonnet-4.6"]);
    expect(result.inaccessible).toEqual([{ id: "google/gemini-2.5-pro", status: 500, reason: undefined }]);
  });

  // Cline answers 200 with an error envelope when a catalog entry's upstream is
  // gone, so a bare status check would keep dead models.
  it("treats a 200 without choices as inaccessible", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: {} }));

    const result = await probeClineModels({ accessToken: "workos:token" }, ["ghost/model"]);

    expect(result.accessible).toEqual([]);
    expect(result.inaccessible).toEqual([{ id: "ghost/model", status: undefined, reason: "no choices returned" }]);
  });

  it("accepts a bare (un-enveloped) choices body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: "hi" } }] }));

    const result = await probeClineModels({ accessToken: "workos:token" }, ["openai/gpt-4o"]);

    expect(result.accessible).toEqual(["openai/gpt-4o"]);
  });

  it("skips :batch models without issuing a request", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: "hi" } }] }));

    const result = await probeClineModels(
      { accessToken: "workos:token" },
      ["openai/gpt-5.4:batch", "openai/gpt-5.4"]
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock.mock.calls[0]).model).toBe("openai/gpt-5.4");
    expect(result.accessible).toEqual(["openai/gpt-5.4"]);
  });

  it("returns empty without a token or candidates", async () => {
    expect(await probeClineModels({}, ["openai/gpt-4o"])).toEqual({ accessible: [], inaccessible: [] });
    expect(await probeClineModels({ accessToken: "workos:token" }, [])).toEqual({ accessible: [], inaccessible: [] });
    expect(await probeClineModels({ accessToken: "workos:token" }, null)).toEqual({ accessible: [], inaccessible: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a rejected request as inaccessible instead of throwing", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));

    const result = await probeClineModels({ accessToken: "workos:token" }, ["openai/gpt-4o"]);

    expect(result.accessible).toEqual([]);
    expect(result.inaccessible[0].id).toBe("openai/gpt-4o");
    expect(result.inaccessible[0].reason).toBe("network error");
  });

  // Regression guard: the probe must reuse buildClineHeaders, which adds the
  // `workos:` prefix a bare WorkOS JWT needs and leaves `clp_` API keys alone.
  // A hand-rolled `Bearer ${token}` makes Cline answer 401 ("re-auth").
  it("sends WorkOS tokens through the cline auth header builder", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: "hi" } }] }));

    await probeClineModels({ accessToken: "eyJhbGciOiJSUzI1NiJ9.payload.sig" }, ["openai/gpt-4o"]);

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer workos:eyJhbGciOiJSUzI1NiJ9.payload.sig");
    expect(headers["X-CLIENT-TYPE"]).toBe("9router");
    expect(urlOf(fetchMock.mock.calls[0])).toBe("https://api.cline.bot/api/v1/chat/completions");
  });

  it("does not prefix a ClinePass API key with workos:", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: "hi" } }] }));

    await probeClineModels({ apiKey: "clp_abc123" }, ["cline-pass/glm-5.2"]);

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer clp_abc123");
  });

  it("honours the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    fetchMock.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return jsonResponse({ choices: [{ message: { content: "hi" } }] });
    });

    const candidates = Array.from({ length: 12 }, (_, i) => `vendor/model-${i}`);
    const result = await probeClineModels({ accessToken: "workos:token" }, candidates, { concurrency: 3 });

    expect(peak).toBeLessThanOrEqual(3);
    expect(result.accessible).toHaveLength(12);
  });
});
