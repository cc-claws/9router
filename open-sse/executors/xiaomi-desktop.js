import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { getMimoAccountCookie, invalidateMimoAccountCookieCache, MIMO_API_BASE, MIMO_API_UA } from "../shared/mimoAccount.js";

// Desktop-exclusive Preview models. These are served by the account service's
// /api/route proxy, authorized by the Xiaomi account session (NOT a local engine,
// and NOT the sk- key). See shared/mimoAccount.js for the session handshake.
const PREVIEW_MODELS = new Set(["mimo-x-pro-preview", "mimo-x-flash-preview"]);

// Upstream calls may hand us either the bare id or a `provider/model` ref.
function bareModel(model) {
  const s = String(model || "");
  const i = s.indexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

export class XiaomiDesktopExecutor extends BaseExecutor {
  constructor() {
    super("xiaomi-desktop", PROVIDERS["xiaomi-desktop"]);
  }

  static isPreviewModel(model) {
    return PREVIEW_MODELS.has(bareModel(model));
  }

  buildUrl(model) {
    if (XiaomiDesktopExecutor.isPreviewModel(model)) {
      return `${MIMO_API_BASE}/api/route/chat/completions`;
    }
    // Stable models go straight to the public OpenAI-compatible cloud API.
    return PROVIDERS["xiaomi-desktop"]?.baseUrl
      || "https://api.xiaomimimo.com/v1/chat/completions";
  }

  async buildHeaders(credentials, stream = true, model, log, proxyOptions = null) {
    const base = {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
    };

    if (model && XiaomiDesktopExecutor.isPreviewModel(model)) {
      const cookie = await getMimoAccountCookie(credentials?.providerSpecificData, proxyOptions);
      if (!cookie) {
        throw new Error(
          "Xiaomi MiMo account session unavailable. Sign in to MiMo Desktop once so its passToken is present, then retry.",
        );
      }
      base["User-Agent"] = MIMO_API_UA;
      base["Cookie"] = cookie;
    } else {
      const key = credentials?.apiKey || credentials?.accessToken;
      if (key) base["Authorization"] = `Bearer ${key}`;
    }

    return base;
  }

  transformRequest(model, body) {
    let out = body;

    // Preview models: the account-service route requires `provider/model` form
    // (e.g. xiaomi/mimo-x-flash-preview). Thinking/params get defaults only —
    // never override what the caller set explicitly.
    if (XiaomiDesktopExecutor.isPreviewModel(model)) {
      out = { ...out, model: `xiaomi/${bareModel(model)}` };
      if (out.thinking == null) out.thinking = { type: "enabled" };
      if (out.temperature == null) out.temperature = 1.0;
      if (out.top_p == null) out.top_p = 0.95;
      if (!out.max_tokens) out.max_tokens = 4096;
    }

    return out;
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const url = this.buildUrl(model);
    const transformedBody = this.transformRequest(model, body);
    let headers = await this.buildHeaders(credentials, stream, model, log, proxyOptions);
    const bodyStr = JSON.stringify(transformedBody);
    const isPreview = XiaomiDesktopExecutor.isPreviewModel(model);

    log?.debug?.("FETCH", `XIAOMI-DESKTOP[${isPreview ? "account-route" : "cloud"}] → ${url} | model=${model} | msgs=${transformedBody?.messages?.length ?? 0}`);

    let response = await proxyAwareFetch(
      url,
      { method: "POST", headers, body: bodyStr, signal },
      proxyOptions,
    );

    // A cached session can expire early — drop it and retry once with a fresh one.
    if (response.status === 401 && isPreview) {
      log?.info?.("AUTH", "xiaomi-desktop 401 — refreshing account session and retrying");
      invalidateMimoAccountCookieCache();
      headers = await this.buildHeaders(credentials, stream, model, log, proxyOptions);
      response = await proxyAwareFetch(
        url,
        { method: "POST", headers, body: bodyStr, signal },
        proxyOptions,
      );
    }

    return { response, url, headers, transformedBody };
  }
}

export default XiaomiDesktopExecutor;
