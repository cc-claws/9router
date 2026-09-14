import { describe, it, expect, vi, beforeEach } from "vitest";
import { XiaomiMimoExecutor, __test__ } from "../../open-sse/executors/xiaomi-mimo.js";
import { getExecutor } from "../../open-sse/executors/index.js";

const { bareModel, COOKIE_KEY } = __test__;

const OPENAI_T = { runtimeTransport: { format: "openai", baseUrl: "https://api.xiaomimimo.com/v1/chat/completions" } };
const CLAUDE_T = { runtimeTransport: { format: "claude", baseUrl: "https://api.xiaomimimo.com/anthropic/v1/messages" } };

describe("xiaomi-mimo executor", () => {
  let ex;
  beforeEach(() => {
    ex = new XiaomiMimoExecutor();
  });

  it("is registered for xiaomi-mimo", () => {
    expect(getExecutor("xiaomi-mimo")).toBeInstanceOf(XiaomiMimoExecutor);
  });

  it("routes Preview models to the account-service route regardless of transport", () => {
    const expected = "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions";
    expect(ex.buildUrl("mimo-x-pro-preview", true, 0, OPENAI_T)).toBe(expected);
    expect(ex.buildUrl("mimo-x-pro-preview", true, 0, CLAUDE_T)).toBe(expected);
    // body.model arrives as `xiaomi/<id>` via upstreamModelId
    expect(ex.buildUrl("xiaomi/mimo-x-flash-preview", true, 0, OPENAI_T)).toBe(expected);
  });

  it("keeps the sourceFormat-matched endpoint for cloud models", () => {
    // Regression: a Claude client must reach /anthropic/v1/messages, not /v1/chat/completions.
    expect(ex.buildUrl("mimo-v2.5-pro", true, 0, CLAUDE_T)).toBe(CLAUDE_T.runtimeTransport.baseUrl);
    expect(ex.buildUrl("mimo-v2.5-pro", true, 0, OPENAI_T)).toBe(OPENAI_T.runtimeTransport.baseUrl);
  });

  it("authenticates Preview calls with the account cookie", () => {
    const headers = ex.buildHeaders({ [COOKIE_KEY]: "serviceToken=abc", accessToken: "sk-x" }, true, "u", "mimo-x-pro-preview");
    expect(headers.Cookie).toBe("serviceToken=abc");
    expect(headers.Authorization).toBeUndefined();
  });

  it("authenticates cloud calls with the bearer key", () => {
    const headers = ex.buildHeaders({ accessToken: "sk-x" }, true, "u", "mimo-v2.5-pro");
    expect(headers.Authorization).toBe("Bearer sk-x");
    expect(headers.Cookie).toBeUndefined();
  });

  it("fails fast when a Preview call has no account session", async () => {
    await expect(
      ex.execute({ model: "mimo-x-pro-preview", body: {}, stream: true, credentials: {}, log: null }),
    ).rejects.toThrow(/account session unavailable/);
  });

  it("preserves content-part arrays for multimodal inputs", () => {
    const parts = [{ type: "image_url", image_url: { url: "data:image/png;base64,xyz" } }, { type: "text", text: "hi" }];
    const out = ex.transformRequest(
      "mimo-x-pro-preview",
      { messages: [{ role: "user", content: parts }] },
      true,
      {},
    );
    expect(out.messages[0].content).toEqual(parts);
  });

  it("applies Preview defaults without overriding explicit values", () => {
    const body = { messages: [{ role: "user", content: "hi" }], temperature: 0.2 };
    const out = ex.transformRequest("mimo-x-pro-preview", body, true, {});
    expect(out.temperature).toBe(0.2);       // caller's value kept
    expect(out.top_p).toBe(0.95);            // default filled in
    expect(out.max_tokens).toBe(4096);
  });

  it("leaves cloud bodies free of Preview defaults", () => {
    const out = ex.transformRequest("mimo-v2.5-pro", { messages: [{ role: "user", content: "hi" }] }, true, {});
    expect(out.thinking).toBeUndefined();
    expect(out.max_tokens).toBeUndefined();
  });

  it("strips a provider/model prefix when testing preview ids", () => {
    expect(bareModel("xiaomi/mimo-x-pro-preview")).toBe("mimo-x-pro-preview");
    expect(bareModel("mimo-x-pro-preview")).toBe("mimo-x-pro-preview");
  });

  it("bridges high effort to deep thinking directive and expanded max_tokens", () => {
    const body = {
      messages: [{ role: "system", content: "You are an agent." }, { role: "user", content: "solve" }],
      reasoning_effort: "high"
    };
    const out = ex.transformRequest("mimo-x-pro-preview", body, true, {});
    expect(out.max_tokens).toBe(32768);
    expect(out.messages[0].content).toContain("[Thinking Directive]");
    expect(out.messages[0].content).toContain("Please UltraThinking:");
  });

  it("bridges xhigh effort to extended thinking directive and 64k tokens", () => {
    const body = {
      messages: [{ role: "user", content: "complex task" }],
      reasoning_effort: "xhigh"
    };
    const out = ex.transformRequest("mimo-x-pro-preview", body, true, {});
    expect(out.max_tokens).toBe(65536);
    expect(out.messages[0].content).toContain("Please UltraThinking (Extended)");
  });

  it("bridges low effort without extra prompt and allocates moderate budget", () => {
    const body = {
      messages: [{ role: "user", content: "quick answer" }],
      reasoning_effort: "low"
    };
    const out = ex.transformRequest("mimo-x-flash-preview", body, true, {});
    expect(out.max_tokens).toBe(8192);
    expect(out.messages.some(m => typeof m.content === "string" && m.content.includes("Please UltraThinking"))).toBe(false);
  });

  it("bridges medium effort with expanded budget but no prompt injection", () => {
    const body = {
      messages: [{ role: "user", content: "explain" }],
      reasoning_effort: "medium"
    };
    const out = ex.transformRequest("mimo-x-pro-preview", body, true, {});
    expect(out.max_tokens).toBe(16384);
    expect(out.messages.length).toBe(1);
    expect(out.messages[0].role).toBe("user");
  });

  it("bridges none effort without prompt injection", () => {
    const body = {
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "none"
    };
    const out = ex.transformRequest("mimo-x-pro-preview", body, true, {});
    expect(out.max_tokens).toBe(4096);
    expect(out.messages.length).toBe(1);
    expect(out.messages[0].role).toBe("user");
  });
});
