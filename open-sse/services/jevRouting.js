/**
 * Jev Semantic Smart Routing
 *
 * Evaluates user prompt semantics against combo candidates using TypeSafe Jev
 * via OpenRouter's /api/v1/alpha/decisions endpoint, and reorders candidates so the
 * best suited model is tried first.
 *
 * Fail-open: any error, timeout, or missing key returns null and leaves candidates untouched.
 */

import { extractTextContent } from "../translator/formats/gemini.js";
import { getPricingForModel } from "../providers/pricing.js";

const DEFAULT_JEV_URL = process.env.JEV_BASE_URL
  ? (process.env.JEV_BASE_URL.includes("/decisions")
      ? process.env.JEV_BASE_URL
      : `${process.env.JEV_BASE_URL.replace(/\/+$/, "")}/alpha/decisions`)
  : "https://openrouter.ai/api/v1/alpha/decisions";

const DEFAULT_TIMEOUT_MS = 800;
const MAX_STATE_CHARS = 3000;
export const MIN_FIT_THRESHOLD = 0.15; // Minimum fit score to qualify for cheapest policy

/**
 * Extract prompt text across OpenAI, Claude, Gemini, and Responses formats.
 *
 * @param {object} body
 * @returns {string}
 */
export function extractPromptText(body) {
  if (!body || typeof body !== "object") return "";

  const extractFromArr = (arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return "";
    // Prioritize the latest user message
    const userMessages = arr.filter((m) => m?.role === "user" || m?.role === "human");
    if (userMessages.length > 0) {
      const lastUser = userMessages[userMessages.length - 1];
      const text = typeof lastUser.content === "string"
        ? lastUser.content
        : extractTextContent(lastUser.content, "\n");
      if (text && text.trim()) return text.trim();
    }
    // Fallback: join all messages
    return arr
      .map((m) => {
        const c = m?.content;
        return typeof c === "string" ? c : extractTextContent(c, " ");
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  };

  if (Array.isArray(body.messages)) return extractFromArr(body.messages);
  if (Array.isArray(body.input)) return extractFromArr(body.input);
  if (Array.isArray(body.contents)) {
    const userParts = body.contents
      .filter((c) => c?.role === "user")
      .flatMap((c) => c?.parts || []);
    return userParts.map((p) => p?.text || "").filter(Boolean).join("\n").trim();
  }

  return "";
}

/**
 * Generate semantic capability description for a candidate model (pure capability, NO pricing).
 *
 * @param {string} modelStr
 * @returns {string}
 */
export function getModelSemanticCriteria(modelStr) {
  const m = String(modelStr || "").toLowerCase();
  if (m.includes("claude") || m.includes("anthropic")) {
    return "Anthropic Claude model: nuanced writing, complex reasoning, deep code refactoring, and structured analysis.";
  }
  if (m.includes("gpt-5") || m.includes("gpt-4") || m.includes("openai") || m.includes("o1") || m.includes("o3") || m.includes("o4") || m.includes("codex")) {
    return "OpenAI model: strong general intelligence, instruction following, logic, and coding.";
  }
  if (m.includes("deepseek")) {
    return "DeepSeek model: fast, cost-efficient, strong at mathematics, algorithms, coding, and general reasoning.";
  }
  if (m.includes("gemini") || m.includes("google")) {
    return "Google Gemini model: multimodal understanding, fast reasoning, factual recall, and broad knowledge.";
  }
  if (m.includes("qwen")) {
    return "Qwen model: excellent multilingual understanding, coding, and structured reasoning.";
  }
  if (m.includes("kimi") || m.includes("moonshot")) {
    return "Kimi model: long-context comprehension, document analysis, and conversational intelligence.";
  }
  if (m.includes("glm") || m.includes("zhipu")) {
    return "GLM model: strong bilingual reasoning, Chinese context, and coding.";
  }
  if (m.includes("minimax")) {
    return "MiniMax model: natural prose, conversational creativity, and context retention.";
  }
  if (m.includes("grok")) {
    return "Grok model: concise, fast, and technical understanding.";
  }
  return `General AI model (${modelStr}) for answering queries and completing tasks.`;
}

/**
 * Calculate effective cost metric for model comparison.
 * Unknown pricing treated as Infinity so cheapest policy prefers models with known low prices.
 *
 * @param {string} modelStr
 * @returns {number}
 */
export function getModelCost(modelStr) {
  const slash = typeof modelStr === "string" ? modelStr.indexOf("/") : -1;
  const provider = slash > 0 ? modelStr.slice(0, slash) : "";
  const model = slash > 0 ? modelStr.slice(slash + 1) : modelStr;
  const pricing = getPricingForModel(provider, model);
  if (!pricing) return Number.POSITIVE_INFINITY;
  return (pricing.input || 0) + (pricing.output || 0);
}

/**
 * Reorder candidates based on Jev fit probabilities and route policy.
 *
 * @param {string[]} candidates
 * @param {Record<string, number>} probabilities
 * @param {string} defaultChoice
 * @param {string} [routePolicy="quality"]
 * @returns {string[]}
 */
export function sortCandidatesByPolicy(candidates, probabilities = {}, defaultChoice = null, routePolicy = "quality") {
  if (!Array.isArray(candidates) || candidates.length <= 1) return candidates;

  const candidateSet = new Set(candidates);
  const probs = probabilities || {};

  // Head selection
  let head = null;

  if (routePolicy === "cheapest") {
    // Candidates meeting the minimum fit threshold
    const qualified = candidates.filter((c) => (probs[c] || 0) >= MIN_FIT_THRESHOLD);
    if (qualified.length > 0) {
      // Sort by cost ascending, then by fit descending
      const sortedByCost = [...qualified].sort((a, b) => {
        const costDiff = getModelCost(a) - getModelCost(b);
        if (costDiff !== 0) return costDiff;
        return (probs[b] || 0) - (probs[a] || 0);
      });
      head = sortedByCost[0];
    }
  }

  // Quality policy or fallback if no qualified candidates in cheapest
  if (!head) {
    let maxProb = -1;
    for (const c of candidates) {
      const p = probs[c] ?? -1;
      if (p > maxProb) {
        maxProb = p;
        head = c;
      }
    }
    // If probabilities were empty or tie-0, use defaultChoice if valid
    if ((!head || maxProb <= 0) && defaultChoice && candidateSet.has(defaultChoice)) {
      head = defaultChoice;
    }
    if (!head) head = candidates[0];
  }

  // Tail: all other candidates sorted by fit descending (ties preserve original relative order)
  const remaining = candidates.filter((c) => c !== head);
  remaining.sort((a, b) => {
    const diff = (probs[b] || 0) - (probs[a] || 0);
    if (diff !== 0) return diff;
    return candidates.indexOf(a) - candidates.indexOf(b);
  });

  return [head, ...remaining];
}

/**
 * Call Jev to resolve the optimal candidate order for a combo request.
 *
 * @param {object} params
 * @param {object} params.body - Request body
 * @param {string[]} params.candidates - Candidate models
 * @param {object} [params.settings] - jevRouting settings: { enabled, timeoutMs, minConfidence }
 * @param {string} [params.apiKey] - OpenRouter API key
 * @param {string} [params.routePolicy="quality"] - "quality" | "cheapest"
 * @param {object} [params.log] - Logger
 * @param {Function} [params.fetchFn] - Custom fetch (for testing)
 * @returns {Promise<{ models: string[], selected: string, confidence: number, probabilities: Record<string, number> }|null>}
 */
export async function resolveJevRoute({
  body,
  candidates,
  settings = {},
  apiKey = null,
  routePolicy = "quality",
  log = null,
  fetchFn = fetch,
}) {
  if (!settings?.enabled) return null;
  if (!apiKey) {
    log?.debug?.("JEV", "Skipped: no OpenRouter API key available");
    return null;
  }
  if (!Array.isArray(candidates) || candidates.length <= 1) return null;

  const promptText = extractPromptText(body);
  if (!promptText) {
    log?.debug?.("JEV", "Skipped: empty prompt text");
    return null;
  }

  const truncatedState = promptText.length > MAX_STATE_CHARS
    ? `${promptText.slice(0, MAX_STATE_CHARS)}...`
    : promptText;

  const criteria = {};
  for (const c of candidates) {
    criteria[c] = getModelSemanticCriteria(c);
  }

  const payload = {
    model: "typesafe/jev-1.13",
    state: truncatedState,
    questions: {
      route: {
        type: "choice",
        instructions: "Which model is best suited to handle this request?",
        criteria,
      },
    },
  };

  const timeoutMs = Number(settings.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const minConfidence = Number(settings.minConfidence) || 0;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const t0 = Date.now();
  try {
    const res = await fetchFn(DEFAULT_JEV_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      log?.warn?.("JEV", `Upstream returned ${res.status}: ${errText.slice(0, 150)}`);
      return null;
    }

    const data = await res.json();
    const routeAnswer = data?.answers?.route;
    if (!routeAnswer) {
      log?.warn?.("JEV", "Malformed response: missing answers.route");
      return null;
    }

    const confidence = Number(routeAnswer.confidence) || 0;
    if (confidence < minConfidence) {
      log?.info?.("JEV", `Skipped: confidence ${confidence} < minConfidence ${minConfidence}`);
      return null;
    }

    const probabilities = routeAnswer.probabilities || {};
    const rawChoice = routeAnswer.choice;
    const reordered = sortCandidatesByPolicy(candidates, probabilities, rawChoice, routePolicy);
    const selected = reordered[0];
    const elapsedMs = Date.now() - t0;

    log?.info?.(
      "JEV",
      `route=${selected} confidence=${confidence.toFixed(2)} policy=${routePolicy} (${elapsedMs}ms)`
    );

    return {
      models: reordered,
      selected,
      confidence,
      probabilities,
    };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === "AbortError" || ctrl.signal.aborted;
    if (isTimeout) {
      log?.warn?.("JEV", `Timeout after ${timeoutMs}ms (fail-open)`);
    } else {
      log?.warn?.("JEV", `Error: ${err.message || String(err)} (fail-open)`);
    }
    return null;
  }
}
