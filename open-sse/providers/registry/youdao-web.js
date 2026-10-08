export default {
  id: "youdao-web",
  alias: "yd",
  aliases: [
    "youdao",
    "youdao-ai",
  ],
  uiAlias: "yd",
  display: {
    name: "Youdao AI (fanyi.youdao.com)",
    icon: "translate",
    color: "#E93030",
    textIcon: "YD",
    website: "https://fanyi.youdao.com",
  },
  category: "free",
  noAuth: true,
  authHint: "No credentials needed — the public ai-translate-llm channel is used.",
  transport: {
    baseUrl: "https://luna-ai.youdao.com/translate_llm/v3/chat",
    format: "youdao-web",
    noAuth: true,
    quirks: {
      // The upstream is a translation assistant wearing a chat hat. A long
      // coding-agent system prompt (Claude Code's is ~40-50k chars) makes it
      // "remember" it is a plain assistant and refuse to call tools, so agentic
      // runs stall. Trim the injected system prompt to a short prefix — the
      // client's own turns carry the real task anyway.
      maxSystemPromptChars: 600,
    },
  },
  models: [
    { id: "deepseek_r1", name: "Youdao DeepSeek R1 (chat + translate)" },
    { id: "refine_key_point", name: "Youdao 重点提炼 (key-point extract)" },
  ],
  passthroughModels: true,
};
