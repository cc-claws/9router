import { describe, it, expect, vi } from "vitest";
import {
  extractPromptText,
  getModelCost,
  sortCandidatesByPolicy,
  resolveJevRoute,
  MIN_FIT_THRESHOLD,
} from "../../open-sse/services/jevRouting.js";

describe("jevRouting", () => {
  describe("extractPromptText", () => {
    it("extracts latest user message from OpenAI messages format", () => {
      const body = {
        messages: [
          { role: "system", content: "You are a helpful assistant" },
          { role: "user", content: "First question" },
          { role: "assistant", content: "First answer" },
          { role: "user", content: "How to fix a leak?" },
        ],
      };
      expect(extractPromptText(body)).toBe("How to fix a leak?");
    });

    it("extracts text from content blocks array", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Refactor this function" },
              { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
            ],
          },
        ],
      };
      expect(extractPromptText(body)).toBe("Refactor this function");
    });

    it("extracts from Gemini contents format", () => {
      const body = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Explain quantum mechanics" }],
          },
        ],
      };
      expect(extractPromptText(body)).toBe("Explain quantum mechanics");
    });

    it("extracts from Responses input format", () => {
      const body = {
        input: [
          {
            role: "user",
            content: [{ type: "text", text: "Analyze this crash report" }],
          },
        ],
      };
      expect(extractPromptText(body)).toBe("Analyze this crash report");
    });

    it("returns empty string on empty or missing body", () => {
      expect(extractPromptText(null)).toBe("");
      expect(extractPromptText({})).toBe("");
      expect(extractPromptText({ messages: [] })).toBe("");
    });
  });

  describe("getModelCost", () => {
    it("recognizes DeepSeek as cheaper than Claude Opus", () => {
      const deepseekCost = getModelCost("deepseek/deepseek-chat");
      const claudeCost = getModelCost("anthropic/claude-opus-4.6");
      expect(deepseekCost).toBeLessThan(claudeCost);
    });

    it("returns Infinity for unknown models", () => {
      expect(getModelCost("completely-unknown-provider/unknown-model-xyz")).toBe(Number.POSITIVE_INFINITY);
    });
  });

  describe("sortCandidatesByPolicy", () => {
    const candidates = [
      "deepseek/deepseek-chat",
      "openai/gpt-5",
      "anthropic/claude-sonnet-4.6",
    ];

    it("quality policy picks highest probability model as head and sorts tail by fit descending", () => {
      const probabilities = {
        "deepseek/deepseek-chat": 0.10,
        "openai/gpt-5": 0.30,
        "anthropic/claude-sonnet-4.6": 0.60,
      };

      const result = sortCandidatesByPolicy(candidates, probabilities, "anthropic/claude-sonnet-4.6", "quality");
      expect(result).toEqual([
        "anthropic/claude-sonnet-4.6",
        "openai/gpt-5",
        "deepseek/deepseek-chat",
      ]);
    });

    it("cheapest policy picks cheapest among fit >= 0.15", () => {
      const probabilities = {
        "deepseek/deepseek-chat": 0.20, // cost ~$0.42, fit >= 0.15
        "openai/gpt-5": 0.30,          // cost ~$11.25, fit >= 0.15
        "anthropic/claude-sonnet-4.6": 0.50, // cost ~$18.00, fit >= 0.15
      };

      // In cheapest policy, deepseek is chosen because its fit >= 0.15 and it has the lowest cost
      const result = sortCandidatesByPolicy(candidates, probabilities, "anthropic/claude-sonnet-4.6", "cheapest");
      expect(result[0]).toBe("deepseek/deepseek-chat");
      // Tail is still sorted by fit descending
      expect(result.slice(1)).toEqual([
        "anthropic/claude-sonnet-4.6",
        "openai/gpt-5",
      ]);
    });

    it("cheapest policy ignores models below MIN_FIT_THRESHOLD (0.15)", () => {
      const probabilities = {
        "deepseek/deepseek-chat": 0.05, // cheap, but fit < 0.15 -> excluded
        "openai/gpt-5": 0.25,          // cost ~$11.25, fit >= 0.15 -> chosen
        "anthropic/claude-sonnet-4.6": 0.70, // cost ~$18.00, fit >= 0.15
      };

      const result = sortCandidatesByPolicy(candidates, probabilities, "anthropic/claude-sonnet-4.6", "cheapest");
      expect(result[0]).toBe("openai/gpt-5");
      // Tail sorted by fit descending
      expect(result.slice(1)).toEqual([
        "anthropic/claude-sonnet-4.6",
        "deepseek/deepseek-chat",
      ]);
    });

    it("cheapest policy falls back to highest fit if all candidates are below MIN_FIT_THRESHOLD", () => {
      const probabilities = {
        "deepseek/deepseek-chat": 0.05,
        "openai/gpt-5": 0.08,
        "anthropic/claude-sonnet-4.6": 0.12,
      };

      const result = sortCandidatesByPolicy(candidates, probabilities, "anthropic/claude-sonnet-4.6", "cheapest");
      expect(result[0]).toBe("anthropic/claude-sonnet-4.6");
    });
  });

  describe("resolveJevRoute", () => {
    const candidates = [
      "deepseek/deepseek-chat",
      "openai/gpt-5",
      "anthropic/claude-sonnet-4.6",
    ];
    const body = {
      messages: [{ role: "user", content: "Need help refactoring complex code" }],
    };

    it("returns null when settings.enabled is false (default)", async () => {
      const result = await resolveJevRoute({
        body,
        candidates,
        settings: { enabled: false },
        apiKey: "sk-mock",
      });
      expect(result).toBeNull();
    });

    it("returns null when apiKey is missing", async () => {
      const result = await resolveJevRoute({
        body,
        candidates,
        settings: { enabled: true },
        apiKey: null,
      });
      expect(result).toBeNull();
    });

    it("returns null when candidates has 1 or fewer items", async () => {
      const result = await resolveJevRoute({
        body,
        candidates: ["single-model"],
        settings: { enabled: true },
        apiKey: "sk-mock",
      });
      expect(result).toBeNull();
    });

    it("successfully calls Jev and reorders candidates", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          model: "typesafe/jev-1.13-20260917",
          answers: {
            route: {
              type: "choice",
              choice: "anthropic/claude-sonnet-4.6",
              probabilities: {
                "deepseek/deepseek-chat": 0.10,
                "openai/gpt-5": 0.20,
                "anthropic/claude-sonnet-4.6": 0.70,
              },
              confidence: 0.85,
            },
          },
        }),
      });

      const result = await resolveJevRoute({
        body,
        candidates,
        settings: { enabled: true, timeoutMs: 800, minConfidence: 0.5 },
        apiKey: "sk-test-key",
        routePolicy: "quality",
        fetchFn: mockFetch,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/alpha/decisions");
      expect(init.headers.Authorization).toBe("Bearer sk-test-key");

      const sentBody = JSON.parse(init.body);
      expect(sentBody.model).toBe("typesafe/jev-1.13");
      expect(sentBody.state).toBe("Need help refactoring complex code");
      expect(sentBody.questions.route.criteria).toHaveProperty("deepseek/deepseek-chat");

      expect(result).not.toBeNull();
      expect(result.selected).toBe("anthropic/claude-sonnet-4.6");
      expect(result.confidence).toBe(0.85);
      expect(result.models).toEqual([
        "anthropic/claude-sonnet-4.6",
        "openai/gpt-5",
        "deepseek/deepseek-chat",
      ]);
    });

    it("fails open and returns null when confidence is below minConfidence", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          answers: {
            route: {
              choice: "openai/gpt-5",
              probabilities: { "openai/gpt-5": 0.5 },
              confidence: 0.3, // below minConfidence 0.6
            },
          },
        }),
      });

      const result = await resolveJevRoute({
        body,
        candidates,
        settings: { enabled: true, minConfidence: 0.6 },
        apiKey: "sk-test-key",
        fetchFn: mockFetch,
      });

      expect(result).toBeNull();
    });

    it("fails open and returns null on HTTP error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

      const result = await resolveJevRoute({
        body,
        candidates,
        settings: { enabled: true },
        apiKey: "sk-test-key",
        fetchFn: mockFetch,
      });

      expect(result).toBeNull();
    });

    it("fails open and returns null on network exception or timeout", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Network connection dropped"));

      const result = await resolveJevRoute({
        body,
        candidates,
        settings: { enabled: true },
        apiKey: "sk-test-key",
        fetchFn: mockFetch,
      });

      expect(result).toBeNull();
    });
  });
});
