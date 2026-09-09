import { CLAUDE_API_HEADERS } from "../shared.js";

export default {
  id: "xiaomi-desktop",
  priority: 280,
  alias: "xiaomi-desktop",
  aliases: ["mimo-desktop", "xmd"],
  uiAlias: "xmd",
  display: {
    name: "Xiaomi MiMo Desktop",
    icon: "smart_toy",
    color: "#FF6900",
    textIcon: "XD",
    website: "https://mimo.xiaomi.com",
    notice: {
      text: "Sign in with your Xiaomi account to use MiMo-X-Pro-Preview and other Desktop models with weekly quota tracking.",
      signupUrl: "https://mimo.xiaomimimo.com/desktop/invite/",
    },
  },
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth", "apikey"],
  serviceKinds: ["llm", "tts"],
  transport: {
    baseUrl: "https://api.xiaomimimo.com/v1/chat/completions",
    validateUrl: "https://api.xiaomimimo.com/v1/models",
    headers: {
      "X-Mimo-Source": "mimocode-cli",
    },
  },
  // Multi-endpoint: pick the transport matching client sourceFormat to skip translation.
  transports: [
    {
      format: "openai",
      baseUrl: "https://api.xiaomimimo.com/v1/chat/completions",
      headers: { "X-Mimo-Source": "mimocode-cli" },
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
    {
      format: "claude",
      baseUrl: "https://api.xiaomimimo.com/anthropic/v1/messages",
      headers: { ...CLAUDE_API_HEADERS, "X-Mimo-Source": "mimocode-cli" },
      auth: { combined: true, header: "x-api-key", scheme: "raw" },
    },
  ],
  models: [
    // Desktop-exclusive models — served via local MiMo Desktop engine (127.0.0.1:4096)
    // Engine only accepts OpenAI format — restrict supportedFormats to force openai transport
    { id: "mimo-x-pro-preview", name: "MiMo-X-Pro-Preview", upstreamModelId: "xiaomi/mimo-x-pro-preview", supportedFormats: ["openai"] },
    { id: "mimo-x-flash-preview", name: "MiMo-X-Flash-Preview", upstreamModelId: "xiaomi/mimo-x-flash-preview", supportedFormats: ["openai"] },
    // Cloud API models (api.xiaomimimo.com/v1)
    { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro" },
    { id: "mimo-v2.5", name: "MiMo V2.5" },
    { id: "mimo-v2-omni", name: "MiMo V2 Omni" },
    { id: "mimo-v2-flash", name: "MiMo V2 Flash" },
    { id: "mimo-v2.5-tts", name: "MiMo V2.5 TTS", kind: "tts" },
  ],
  ttsConfig: {
    baseUrl: "https://api.xiaomimimo.com/v1/chat/completions",
    authType: "apikey",
    authHeader: "bearer",
    format: "xiaomi-mimo-tts",
  },
  // Quota tracking: weekly usage from the Xiaomi account session.
  // Requires the account-session token obtained via OAuth / Desktop import.
  // When only an API key is present, usage tracking falls back to request counting.
  usage: {
    url: "https://aistudio.xiaomimimo.com/open-apis/v1/user/usage",
    type: "xiaomi-weekly",
  },
  features: {
    usage: true,
    usageApikey: true,
  },
  // Custom OAuth — non-standard ECDH encrypted-callback flow.
  // Handled by the xiaomi-desktop OAuth service, not the generic PKCE pipeline.
  oauth: {
    custom: true,
    authorizeUrl: "https://platform.xiaomimimo.com/authorize",
    // The callback carries ?u=<ECDH-encrypted payload> instead of ?code=.
    // Decryption yields { uid, sk, url }.
    callbackParam: "u",
    kn: "mimocode",
  },
};
