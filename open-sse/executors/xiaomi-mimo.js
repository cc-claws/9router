import { DefaultExecutor } from "./default.js";
import { getMimoAccountCookie, invalidateMimoAccountCookieCache, MIMO_API_BASE, MIMO_API_UA } from "../shared/mimoAccount.js";

// Desktop-exclusive Preview models. These are served by the account service's
// /api/route proxy, authorized by the Xiaomi account session (NOT the sk- key).
// See shared/mimoAccount.js for the session handshake.
const PREVIEW_MODELS = new Set(["mimo-x-pro-preview", "mimo-x-flash-preview"]);

// Session cookie resolved in execute() (async) and read back by buildHeaders()
// (sync — BaseExecutor.execute does not await it). Carried on the per-request
// credentials object, same as runtimeTransport.
const COOKIE_KEY = "__mimoAccountCookie";

// Upstream calls may hand us either the bare id or a `provider/model` ref.
function bareModel(model) {
  const s = String(model || "");
  const i = s.indexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

const ULTRA_THINKING_DIRECTIVES = {
  high: "Please UltraThinking: conduct a thorough chain-of-thought analysis before taking action or answering. Systematically explore alternative approaches, verify intermediate steps, and address edge cases while strictly adhering to tool invocation schemas if calling tools.",
  xhigh: "Please UltraThinking (Extended): conduct an extensive, multi-step chain-of-thought analysis before taking action or answering. Rigorously challenge all assumptions, stress-test edge cases and failure modes, actively construct counterexamples, and strictly adhere to tool invocation schemas if calling tools.",
};

function injectThinkingDirective(messages, directive) {
  if (!directive || !Array.isArray(messages)) return messages;
  const alreadyInjected = messages.some((m) =>
    typeof m.content === "string" && (m.content.includes("Please UltraThinking") || m.content.includes("[Thinking Directive]"))
  );
  if (alreadyInjected) return messages;

  const copy = messages.map((m) => ({ ...m }));
  const sys = copy.find((m) => m.role === "system");
  if (sys) {
    if (typeof sys.content === "string") {
      sys.content = `${sys.content}\n\n[Thinking Directive]\n${directive}`;
    } else if (Array.isArray(sys.content)) {
      sys.content = [...sys.content, { type: "text", text: `\n\n[Thinking Directive]\n${directive}` }];
    }
  } else {
    copy.unshift({ role: "system", content: directive });
  }
  return copy;
}

export class XiaomiMimoExecutor extends DefaultExecutor {
  constructor() {
    super("xiaomi-mimo");
  }

  static isPreviewModel(model) {
    return PREVIEW_MODELS.has(bareModel(model));
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    // Preview models live on the account-service route, which is not one of the
    // declared transports — resolve it before the default runtimeTransport path.
    if (XiaomiMimoExecutor.isPreviewModel(model)) {
      return `${MIMO_API_BASE}/api/route/chat/completions`;
    }
    // Cloud API models keep default handling, so a Claude-format client reaches
    // the /anthropic/v1/messages transport.
    return super.buildUrl(model, stream, urlIndex, credentials);
  }

  buildHeaders(credentials, stream = true, url, model) {
    if (XiaomiMimoExecutor.isPreviewModel(model) && credentials?.[COOKIE_KEY]) {
      // Preview models authenticate with the account-session cookie, not the key.
      return {
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
        "User-Agent": MIMO_API_UA,
        Cookie: credentials[COOKIE_KEY],
      };
    }
    return super.buildHeaders(credentials, stream, url, model);
  }

  transformRequest(model, body, stream, credentials) {
    // super runs stripUnsupportedParams, which flattens Preview content-part
    // arrays (see the xiaomi-mimo rule in translator/concerns/paramSupport.js).
    const out = super.transformRequest(model, body, stream, credentials);

    // Preview models: bridge thinking effort (from Claude Code /effort or OpenAI
    // reasoning_effort) via system prompt directives and dynamic max_tokens budgets.
    if (XiaomiMimoExecutor.isPreviewModel(model)) {
      const rawEffort = out.reasoning_effort || body?.reasoning_effort || body?.output_config?.effort;
      const effort = typeof rawEffort === "string" ? rawEffort.toLowerCase() : null;

      if (effort === "xhigh" || effort === "max" || effort === "ultra") {
        out.messages = injectThinkingDirective(out.messages, ULTRA_THINKING_DIRECTIVES.xhigh);
        if (!out.max_tokens) out.max_tokens = 65536;
      } else if (effort === "high") {
        out.messages = injectThinkingDirective(out.messages, ULTRA_THINKING_DIRECTIVES.high);
        if (!out.max_tokens) out.max_tokens = 32768;
      } else if (effort === "medium") {
        if (!out.max_tokens) out.max_tokens = 16384;
      } else if (effort === "low") {
        if (!out.max_tokens) out.max_tokens = 8192;
      } else {
        if (!out.max_tokens) out.max_tokens = 4096;
      }

      if (out.thinking == null) out.thinking = { type: "enabled" };
      if (out.temperature == null) out.temperature = 1.0;
      if (out.top_p == null) out.top_p = 0.95;
    }

    return out;
  }

  async execute(args) {
    const { model, credentials, proxyOptions = null } = args;
    if (!XiaomiMimoExecutor.isPreviewModel(model)) return super.execute(args);

    const cookie = await getMimoAccountCookie(credentials?.providerSpecificData, proxyOptions);
    if (!cookie) {
      throw new Error(
        "Xiaomi MiMo account session unavailable. Sign in to MiMo Desktop once so its passToken is present, then retry.",
      );
    }
    credentials[COOKIE_KEY] = cookie;
    const result = await super.execute(args);

    // A cached session can expire early — drop it and retry once with a fresh one.
    if (result.response.status === 401) {
      invalidateMimoAccountCookieCache();
      const fresh = await getMimoAccountCookie(credentials?.providerSpecificData, proxyOptions).catch(() => null);
      if (fresh) {
        credentials[COOKIE_KEY] = fresh;
        return super.execute(args);
      }
    }
    return result;
  }
}

export const __test__ = { PREVIEW_MODELS, bareModel, COOKIE_KEY };

export default XiaomiMimoExecutor;
