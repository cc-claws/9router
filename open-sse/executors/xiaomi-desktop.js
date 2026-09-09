import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { resolveEngineUrl, mintEngineToken } from "../shared/mimoEngine.js";

// Desktop-exclusive models served by the local MiMo Desktop engine
const ENGINE_MODELS = new Set([
  "mimo-x-pro-preview",
  "mimo-x-flash-preview",
  "xiaomi/mimo-x-pro-preview",
  "xiaomi/mimo-x-flash-preview",
]);

// Upstream model ID mapping (registry id → engine model id)
const ENGINE_MODEL_MAP = {
  "mimo-x-pro-preview": "xiaomi/mimo-x-pro-preview",
  "mimo-x-flash-preview": "xiaomi/mimo-x-flash-preview",
};

// In-process cache: avoids re-minting on every request when connection lacks the token
let cachedEngineToken = null;
let cachedEngineTokenAt = 0;
const ENGINE_TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // 6h — well under the 7d max_age

/**
 * Resolve engine token: connection → process cache → auto-mint.
 * If forceRefresh, skip connection token and mint fresh.
 */
async function resolveEngineToken(credentials, log, forceRefresh = false) {
  // 1. Connection-stored token (preferred — persists across restarts)
  if (!forceRefresh) {
    const fromConn = credentials?.providerSpecificData?.engineToken;
    if (fromConn) return fromConn;
  }

  // 2. Process cache (avoids re-minting every request)
  if (!forceRefresh && cachedEngineToken && Date.now() - cachedEngineTokenAt < ENGINE_TOKEN_TTL_MS) {
    return cachedEngineToken;
  }

  // 3. Auto-mint a fresh token
  try {
    const token = await mintEngineToken();
    cachedEngineToken = token;
    cachedEngineTokenAt = Date.now();
    log?.info?.("AUTH", `Engine token ${forceRefresh ? "re-minted" : "minted"} for xiaomi-desktop`);
    return token;
  } catch (err) {
    log?.error?.("AUTH", `Engine token mint failed: ${err.message}`);
    return null;
  }
}

export class XiaomiDesktopExecutor extends BaseExecutor {
  constructor() {
    super("xiaomi-desktop", PROVIDERS["xiaomi-desktop"]);
  }

  /**
   * Returns true if this model should be routed to the local engine.
   */
  static isEngineModel(model) {
    return ENGINE_MODELS.has(model);
  }

  buildUrl(model) {
    if (XiaomiDesktopExecutor.isEngineModel(model)) {
      const engineBase = resolveEngineUrl();
      if (!engineBase) {
        throw new Error(
          "MiMo Desktop engine not found. Make sure Xiaomi MiMo Desktop is running.",
        );
      }
      return `${engineBase}/v1/chat/completions`;
    }
    // Cloud API for stable models
    return PROVIDERS["xiaomi-desktop"]?.baseUrl
      || "https://api.xiaomimimo.com/v1/chat/completions";
  }

  async buildHeaders(credentials, stream = true, model, log) {
    const base = {
      "Content-Type": "application/json",
      "X-Mimo-Source": "mimocode-cli",
      Accept: stream ? "text/event-stream" : "application/json",
    };

    if (model && XiaomiDesktopExecutor.isEngineModel(model)) {
      const engineToken = await resolveEngineToken(credentials, log);
      if (!engineToken) {
        throw new Error(
          "Engine token not found. Reconnect xiaomi-desktop to mint a local engine token.",
        );
      }
      base["Authorization"] = `Bearer ${engineToken}`;
    } else {
      const key = credentials?.apiKey || credentials?.accessToken;
      if (key) base["Authorization"] = `Bearer ${key}`;
    }

    return base;
  }

  transformRequest(model, body) {
    let out = body;

    // Engine expects provider/model format
    if (model && ENGINE_MODEL_MAP[model] && out?.model === model) {
      out = { ...out, model: ENGINE_MODEL_MAP[model] };
    }

    // X-Preview models: enable thinking at max level with optimized params
    if (XiaomiDesktopExecutor.isEngineModel(model)) {
      out = {
        ...out,
        thinking: { type: "enabled" },
        temperature: 1.0,
        top_p: 0.95,
      };
      if (!out.max_tokens || out.max_tokens < 4096) {
        out.max_tokens = 4096;
      }
    }

    return out;
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const url = this.buildUrl(model);
    const transformedBody = this.transformRequest(model, body);
    const headers = await this.buildHeaders(credentials, stream, model, log);
    const bodyStr = JSON.stringify(transformedBody);

    const target = XiaomiDesktopExecutor.isEngineModel(model) ? "engine" : "cloud";
    log?.debug?.("FETCH", `XIAOMI-DESKTOP[${target}] → ${url} | model=${model} | msgs=${transformedBody?.messages?.length ?? 0}`);

    let response = await proxyAwareFetch(
      url,
      { method: "POST", headers, body: bodyStr, signal },
      proxyOptions,
    );

    // Engine 401: stale token — re-mint and retry once
    if (response.status === 401 && XiaomiDesktopExecutor.isEngineModel(model)) {
      log?.info?.("AUTH", "Engine 401 — re-minting token and retrying");
      const freshToken = await resolveEngineToken(credentials, log, true);
      if (freshToken) {
        headers["Authorization"] = `Bearer ${freshToken}`;
        response = await proxyAwareFetch(
          url,
          { method: "POST", headers, body: bodyStr, signal },
          proxyOptions,
        );
      }
    }

    return { response, url, headers, transformedBody };
  }
}

export default XiaomiDesktopExecutor;
