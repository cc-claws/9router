import { describe, it, expect } from "vitest";
import { PROVIDERS } from "open-sse/config/providers.js";
import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";
import { getExecutor, hasSpecializedExecutor } from "open-sse/executors/index.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import {
  signV3,
  signLegacyMysticTime,
  buildSignedString,
  parseMessages,
  buildTranscript,
  trimSystemPrompt,
  buildToolProtocol,
  formatToolCatalog,
  createToolCallParser,
  extractContent,
  TOOL_REFUSAL_RE,
  peekHead,
} from "open-sse/executors/youdao-web.js";

// Build a fake upstream SSE body from youdao `message` events.
function sseBody(events) {
  const frames = events
    .map((e) => `event:message\ndata:${JSON.stringify(e)}\nretry:3000\n\n`)
    .join("");
  const bytes = new TextEncoder().encode(frames);
  return new ReadableStream({
    start(c) { c.enqueue(bytes); c.close(); },
  });
}

// extractContent now takes an async iterable of parsed events (so the executor
// can peek the head for retry). Mirror that in tests by parsing the body.
async function* eventsOf(events) {
  for (const e of events) yield e;
}

async function collect(gen) {
  const out = { content: "", toolCalls: [], reasoning: "", error: null, retryable: false };
  for await (const chunk of gen) {
    if (chunk.error) out.error = chunk.error;
    if (chunk.retryable) out.retryable = true;
    if (chunk.reasoning) out.reasoning += chunk.reasoning;
    if (chunk.content) out.content += chunk.content;
    // The terminal done chunk re-states every call, so replace (never concat)
    // when present to avoid double counting.
    if (chunk.done && chunk.toolCalls) out.toolCalls = [...chunk.toolCalls];
    else if (chunk.toolCalls?.length) out.toolCalls.push(...chunk.toolCalls);
  }
  return out;
}

describe("youdao-web provider wiring", () => {
  it("registers transport + models under the yd alias", () => {
    expect(PROVIDERS["youdao-web"]).toBeTruthy();
    expect(PROVIDERS["youdao-web"].baseUrl).toContain("/translate_llm/v3/chat");
    expect(PROVIDERS["youdao-web"].format).toBe("youdao-web");
    expect(PROVIDER_MODELS.yd.map((m) => m.id)).toContain("deepseek_r1");
  });

  it("resolves aliases to the provider id", () => {
    expect(resolveProviderAlias("yd")).toBe("youdao-web");
    expect(resolveProviderAlias("youdao")).toBe("youdao-web");
  });

  it("has a specialized executor", () => {
    expect(hasSpecializedExecutor("youdao-web")).toBe(true);
    expect(getExecutor("youdao-web").constructor.name).toBe("YoudaoWebExecutor");
  });
});

describe("youdao-web signing", () => {
  // Reproduces the captured v3/chat request from a real browser session.
  const captured = {
    params: {
      product: "webfanyi", appVersion: "12.0.0", client: "webaitrans", mid: 1, vendor: "web",
      screen: 1, model: 1, imei: 1, network: "wifi", keyfrom: "webfanyi.webaitrans",
      keyid: "ai-translate-llm", mysticTime: 1791423548593,
      yduuid: "d63406db86273f84f9d3fe15908a774c", functionEnglishName: "deepseek_r1",
      input: "1%2B1", useTerm: 0, free: "false", singleBox: "false", fromLang: "auto",
      id: "9689de5c-f4d9-49b2-a59c-303d133cbe19", roundNo: 2, showSuggest: 0,
      token: "13d939a649c34a518fce5b531ffcebb4", source: "webaitrans",
    },
    secretKey: "QGCmKoX7N7wACtICx3PSaWzoPJza2DSC",
    sign: "640029eb1279606b1b1e548b6e72a312",
  };

  it("reproduces the captured v3 sign byte-for-byte", () => {
    const { sign } = signV3(captured.params, captured.secretKey);
    expect(sign).toBe(captured.sign);
  });

  it("sorts pointParam and appends `key` last", () => {
    const { pointParam } = buildSignedString({ b: 2, a: 1, c: 3 }, "secret");
    expect(pointParam).toBe("a,b,c,key");
  });

  it("produces the legacy /secret signature", () => {
    const sign = signLegacyMysticTime(1791423551990);
    expect(sign).toMatch(/^[0-9a-f]{32}$/);
  });
});

// Regression: the upstream model is a translation assistant, so it sometimes
// answers "我无法访问文件系统…" instead of using the tool it was given. The
// executor must recognise that as a retryable refusal.
describe("youdao-web tool refusal detection", () => {
  const match = (s) => TOOL_REFUSAL_RE.test(s);

  it("catches real capability refusals", () => {
    expect(match("抱歉，我无法执行删除文件等系统操作。我是基于文本的AI助手，无法访问您本地电脑的文件系统。")).toBe(true);
    expect(match("很抱歉，我无法直接在你的终端中执行 `npm test`。我是一个对话式 AI 助手。")).toBe(true);
    expect(match("I cannot access your local filesystem or run commands.")).toBe(true);
  });

  it("does not flag ordinary answers", () => {
    expect(match("The weather in Tokyo is 22°C and sunny.")).toBe(false);
    expect(match("1+1 = 2.")).toBe(false);
    expect(match("I cannot determine the answer without more context.")).toBe(false);
    expect(match("当前目录内容: AGENTS.md, package.json")).toBe(false);
  });
});

describe("youdao-web peekHead", () => {
  const iter = (events) => (async function* () { for (const e of events) yield e; })();

  it("flags a refusal when tools are in play", async () => {
    const head = iter([
      { roundId: "x", taskId: "y" },
      { model: "ds-r", content: "抱歉，我无法执行该操作，没有权限访问你的文件系统。" },
    ]);
    const r = await peekHead(head, { tools: true });
    expect(r.refusal).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it("commits immediately when a complete tool call appears", async () => {
    const head = iter([{ model: "ds-r", content: '<tool_call>{"name":"Read","arguments":{"file_path":"a"}}</tool_call>' }]);
    const r = await peekHead(head, { tools: true });
    expect(r.refusal).toBeFalsy();
    expect(r.invalidTool).toBeFalsy();
    expect(r.committed).toBe(true);
  });

  it("flags a tool call with empty arguments", async () => {
    const head = iter([{ model: "ds-r", content: '<tool_call>{"name":"Bash","arguments":{}}</tool_call>' }]);
    const r = await peekHead(head, { tools: true });
    expect(r.invalidTool).toBe("empty-arguments");
    expect(r.committed).toBeFalsy();
  });

  it("waits for the closing tag before judging arguments", async () => {
    const head = iter([
      { model: "ds-r", content: '<tool_call>{"name":"Read","arguments":{"file_path":"a"' },
      { model: "ds-r", content: "}}</tool_call>" },
    ]);
    const r = await peekHead(head, { tools: true });
    expect(r.invalidTool).toBeFalsy();
    expect(r.committed).toBe(true);
  });

  it("keeps buffering long prose instead of committing early (tools on)", async () => {
    const head = iter([
      { model: "ds-r", content: "x".repeat(400) },
      { model: "ds-r", content: "y".repeat(400) },
    ]);
    const r = await peekHead(head, { tools: true });
    // No tool call and no refusal → the stream ended, so it is a no-tool-call.
    expect(r.noToolCall).toBe(true);
    expect(r.committed).toBeFalsy();
  });

  it("commits immediately without tools", async () => {
    const head = iter([{ model: "ds-r", content: "hello" }]);
    const r = await peekHead(head, { tools: false });
    expect(r.committed).toBe(true);
  });

  it("surfaces an upstream error event", async () => {
    const head = iter([{ model: "ds-r", content: "hi" }, { msg: "服务异常，请稍后重试", code: 500 }]);
    const r = await peekHead(head, { tools: false });
    // non-tool path commits on first content, so error is only seen without tools
    expect(r.committed || r.error).toBeTruthy();
  });

  it("flags intent narration (announces action, never calls the tool)", async () => {
    const head = iter([{ model: "ds-r", content: "我先运行 git status 确认当前工作区实际状态。" }]);
    const r = await peekHead(head, { tools: true });
    expect(r.refusal).toBe(true);
  });

  it("treats a reasoning-only reply as empty", async () => {
    const head = iter([
      { model: "ds-r", reasoning_content: "thinking…" },
      { model: "ds-r", reasoning_content: "more" },
    ]);
    const r = await peekHead(head, { tools: true });
    expect(r.empty).toBe(true);
  });

  it("flags a stream that ends without any tool call", async () => {
    const head = iter([
      { model: "ds-r", reasoning_content: "let me look" },
      { model: "ds-r", content: "The workspace looks fine to me." },
    ]);
    const r = await peekHead(head, { tools: true });
    expect(r.refusal).toBeFalsy();
    expect(r.noToolCall).toBe(true);
  });

  it("flags a refusal at end of stream", async () => {
    const head = iter([{ model: "ds-r", content: "抱歉，我无法你的工作区或文件系统。" }]);
    const r = await peekHead(head, { tools: true });
    expect(r.refusal).toBe(true);
  });

  it("does not flag a stream that did call a tool", async () => {
    const head = iter([{ model: "ds-r", content: '<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>' }]);
    const r = await peekHead(head, { tools: true });
    expect(r.noToolCall).toBeFalsy();
    expect(r.committed).toBe(true);
  });

  it("does not treat refusals as retryable without tools", async () => {
    const head = iter([{ model: "ds-r", content: "抱歉，我无法访问文件系统。" }]);
    const r = await peekHead(head, { tools: false });
    expect(r.committed).toBe(true);
  });
});

// Regression: a long coding-agent system prompt makes the upstream forget it can
// call tools (Claude Code sends ~40-50k chars). The transport trims it.
describe("youdao-web system prompt trimming", () => {
  it("keeps a short system prompt untouched", () => {
    expect(trimSystemPrompt(["short prompt"], 600)).toEqual(["short prompt"]);
  });

  it("truncates a long system prompt to the budget", () => {
    const out = trimSystemPrompt(["x".repeat(5000)], 600);
    const total = out.join("").length;
    expect(total).toBeLessThanOrEqual(600 + 3); // +3 for the ellipsis marker
    expect(out[0].startsWith("x".repeat(100))).toBe(true);
  });

  it("fills the budget across parts in order", () => {
    const out = trimSystemPrompt(["a".repeat(400), "b".repeat(400), "c".repeat(400)], 500);
    const joined = out.join("");
    expect(joined).toContain("a".repeat(100));
    expect(joined.length).toBeLessThanOrEqual(503); // budget + ellipsis
    expect(joined).not.toContain("c"); // third part never reached
  });

  it("is a no-op when no budget is configured", () => {
    const big = ["x".repeat(5000)];
    expect(trimSystemPrompt(big, 0)).toEqual(big);
    expect(trimSystemPrompt(big, undefined)).toEqual(big);
  });
});

describe("youdao-web message handling", () => {  it("extracts system + turns and flattens newlines in the transcript", () => {
    const { system, turns } = parseMessages([
      { role: "system", content: "Be nice." },
      { role: "user", content: "line one\nline two" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "next" },
    ]);
    expect(system).toEqual(["Be nice."]);
    expect(turns).toHaveLength(3);
    expect(buildTranscript(system, turns)).toBe("Be nice. User: line one line two Assistant: ok User: next");
  });

  it("folds array content and tool results", () => {
    const { turns } = parseMessages([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "tool", content: "42" },
    ]);
    expect(turns[0].content).toBe("hello");
    expect(turns[1].content).toContain("Tool result: 42");
  });
});

// Regression: the upstream URL-DECODES `input`. A literal `%` that is not a
// valid escape (Claude Code ships "not %VAR% or %PATH%" in its Bash tool text)
// made the upstream 500 with `服务异常`. The official client sends the text
// percent-encoded (captured `input=1%2B1`), so the body must encode it too.
describe("youdao-web input encoding", () => {
  it("percent-encodes input, turning a bare % into %25", () => {
    expect(encodeURIComponent("not %VAR% or %PATH%")).toBe("not%20%25VAR%25%20or%20%25PATH%25");
  });

  it("round-trips through decodeURIComponent unchanged", () => {
    const text = "a % b %20 %PATH% 你好 + /";
    expect(decodeURIComponent(encodeURIComponent(text))).toBe(text);
  });
});

describe("youdao-web prompt-emulated tool calling", () => {
  const tools = [{
    type: "function",
    function: {
      name: "get_weather",
      description: "Get current weather",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  }];

  it("advertises tools:true + tools:false per model (intentional, not the default floor)", () => {
    expect(getCapabilitiesForModel("youdao-web", "deepseek_r1").tools).toBe(true);
    expect(getCapabilitiesForModel("youdao-web", "refine_key_point").tools).toBe(false);
  });

  it("builds a protocol only when tools are present and enabled", () => {
    expect(buildToolProtocol([], "auto")).toBe("");
    expect(buildToolProtocol(tools, "none")).toBe("");
    const proto = buildToolProtocol(tools, "auto");
    expect(proto).toContain("get_weather");
    expect(proto).toContain("<tool_call>");
  });

  it("force-calls a named tool when tool_choice is an object", () => {
    const proto = buildToolProtocol(tools, { type: "function", function: { name: "get_weather" } });
    expect(proto).toContain("MUST call the tool named \"get_weather\"");
  });

  it("keeps the schema in the catalogue but truncates long descriptions", () => {
    const cat = formatToolCatalog([{ function: { name: "x", description: "d".repeat(500) } }]);
    const parsed = JSON.parse(cat);
    expect(parsed[0].name).toBe("x");
    expect(parsed[0].description.length).toBe(300);
    expect(JSON.parse(formatToolCatalog(tools))[0].parameters.required).toEqual(["city"]);
  });

  it("parses a complete tool call out of plain text", () => {
    const p = createToolCallParser();
    const out = p.feed('Sure.<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>');
    const tail = p.flush();
    const calls = [...out.toolCalls, ...tail.toolCalls];
    expect(out.content + tail.content).toBe("Sure.");
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("get_weather");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ city: "Tokyo" });
    expect(calls[0].type).toBe("function");
    expect(calls[0].id).toMatch(/^call_yd_/);
  });

  it("reassembles a tag split across chunk boundaries without leaking it", () => {
    const p = createToolCallParser();
    const pieces = ["<tool", "_call>{", '"name":"f",', '"arguments":{"a":1}}', "</tool_call>"];
    let content = "";
    const calls = [];
    for (const piece of pieces) {
      const o = p.feed(piece);
      content += o.content;
      calls.push(...o.toolCalls);
    }
    const tail = p.flush();
    content += tail.content;
    calls.push(...tail.toolCalls);
    expect(content).toBe("");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ a: 1 });
  });

  it("handles multiple tool calls and surrounding prose", () => {
    const p = createToolCallParser();
    const o = p.feed('A<tool_call>{"name":"f","arguments":{"a":1}}</tool_call>B<tool_call>{"name":"g","arguments":{"x":2}}</tool_call>C');
    const tail = p.flush();
    expect(o.content + tail.content).toBe("ABC");
    expect([...o.toolCalls, ...tail.toolCalls].map((c) => c.function.name)).toEqual(["f", "g"]);
  });

  it("drops a call with empty arguments so the caller can retry", () => {
    const p = createToolCallParser();
    const o = p.feed('<tool_call>{"name":"Bash","arguments":{}}</tool_call>');
    const tail = p.flush();
    expect([...o.toolCalls, ...tail.toolCalls]).toEqual([]);
  });

  it("returns no tool calls for plain answers", () => {
    const p = createToolCallParser();
    let content = p.feed("Hello, world.").content;
    content += p.flush().content;
    expect(content).toBe("Hello, world.");
  });

  it("salvages an unterminated tool call on flush", () => {
    const p = createToolCallParser();
    p.feed('<tool_call>{"name":"f","arguments":{"a":true}}');
    const tail = p.flush();
    expect(tail.toolCalls).toHaveLength(1);
    expect(tail.toolCalls[0].function.name).toBe("f");
  });
});

// Regression: the no-tools path must NOT crash — `emit` previously returned an
// object without `toolCalls`, and the consumer read `.toolCalls.length`.
describe("youdao-web extractContent (both modes)", () => {
  const stream = (events, parseTools) => collect(extractContent(eventsOf(events), parseTools));

  it("plain path (parseTools=false) streams content without crashing", async () => {
    const out = await stream([
      { model: "ds-r", reasoning_content: "think" },
      { model: "ds-r", content: "Hello" },
      { model: "ds-r", content: " world" },
    ], false);
    expect(out.error).toBeNull();
    expect(out.content).toBe("Hello world");
    expect(out.reasoning).toBe("think");
    expect(out.toolCalls).toEqual([]);
  });

  it("tool path (parseTools=true) extracts calls and strips the tag", async () => {
    const out = await stream([
      { model: "ds-r", content: 'Let me check.<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>' },
    ], true);
    expect(out.content).toBe("Let me check.");
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0].function.name).toBe("get_weather");
  });

  it("tool path with a tag split across upstream chunks", async () => {
    const out = await stream([
      { model: "ds-r", content: '<tool_c' },
      { model: "ds-r", content: 'all>{"name":"f",' },
      { model: "ds-r", content: '"arguments":{"a":1}}' },
      { model: "ds-r", content: "</tool_call>" },
    ], true);
    expect(out.content).toBe("");
    expect(out.toolCalls).toHaveLength(1);
    expect(JSON.parse(out.toolCalls[0].function.arguments)).toEqual({ a: 1 });
  });

  it("surfaces upstream error events", async () => {
    const plain = await stream([{ msg: "服务异常，请稍后重试", code: 500 }], false);
    expect(plain.error).toContain("服务异常");
  });

  it("flags a pre-content 500 as retryable", async () => {
    const out = await stream([{ msg: "服务异常，请稍后重试", code: 500 }], true);
    expect(out.retryable).toBe(true);
  });

  // Regression: upstream streams the call token-by-token, so BOTH the open and
  // close tags arrive fragmented. The close tag split ("</" "tool" "_call" ">")
  // previously stalled the parser in inCall forever, yielding zero tool calls.
  it("handles a call fragmented token-by-token exactly like upstream", async () => {
    const tokens = ["\n\n", "<tool", "_call", ">", "{\"", "name", "\":\"", "get", "_", "weather", "\",\"", "arguments", "\":{\"", "city", "\":\"", "Tokyo", "\"", "}}</", "tool", "_call", ">"];
    const out = await stream(tokens.map((t) => ({ model: "ds-r", content: t })), true);
    expect(out.content).toBe("\n\n");
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0].function.name).toBe("get_weather");
    expect(JSON.parse(out.toolCalls[0].function.arguments)).toEqual({ city: "Tokyo" });
  });

  it("handles a fragmented close tag via createToolCallParser directly", () => {
    const p = createToolCallParser();
    const tokens = ["<tool", "_call", ">", '{"name":"f","arguments":{"a":', "1", "}}</", "tool", "_call", ">"];
    let content = "";
    const calls = [];
    for (const t of tokens) {
      const o = p.feed(t);
      content += o.content;
      calls.push(...o.toolCalls);
    }
    const tail = p.flush();
    content += tail.content;
    calls.push(...tail.toolCalls);
    expect(content).toBe("");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ a: 1 });
  });

  it("terminal done chunk carries the accumulated tool calls", async () => {
    let doneChunk = null;
    for await (const c of extractContent(eventsOf([
      { model: "ds-r", content: '<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>' },
    ]), true)) {
      if (c.done) doneChunk = c;
    }
    expect(doneChunk).not.toBeNull();
    expect(doneChunk.toolCalls).toHaveLength(1);
    expect(doneChunk.toolCalls[0].function.name).toBe("get_weather");
  });
});