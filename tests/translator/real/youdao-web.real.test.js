// Live smoke test for the youdao-web provider (anonymous luna-ai channel).
//   RUN_REAL=1 npx vitest run translator/real/youdao-web.real.test.js
//
// No credentials needed — the provider uses the public ai-translate-llm channel,
// but the upstream is a live third-party service so the run is opt-in (RUN_REAL).
import { describe, it, expect } from "vitest";
import { getExecutor } from "open-sse/executors/index.js";

const RUN_REAL = process.env.RUN_REAL === "1";
const log = { info() {}, warn() {}, error() {}, debug() {} };
const creds = { accessToken: "public", providerSpecificData: {} };

async function sseText(resp) {
  const text = await resp.text();
  let content = "";
  let reasoning = "";
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const d = line.slice(5).trim();
    if (d === "[DONE]") continue;
    let j;
    try { j = JSON.parse(d); } catch { continue; }
    content += j.choices?.[0]?.delta?.content || "";
    reasoning += j.choices?.[0]?.delta?.reasoning_content || "";
  }
  return { content, reasoning };
}

describe.skipIf(!RUN_REAL)("youdao-web — real", () => {
  const ex = getExecutor("youdao-web");

  it("streams a translation", async () => {
    const { response } = await ex.execute({
      model: "deepseek_r1",
      body: { messages: [{ role: "user", content: "Translate to English: 你好世界" }] },
      stream: true, credentials: creds, log,
    });
    expect(response.status).toBe(200);
    const { content } = await sseText(response);
    expect(content.length).toBeGreaterThan(0);
  }, 60000);

  it("returns a non-streaming completion", async () => {
    const { response } = await ex.execute({
      model: "deepseek_r1",
      body: { messages: [{ role: "user", content: "What is 2+2?" }] },
      stream: false, credentials: creds, log,
    });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.choices[0].message.content.length).toBeGreaterThan(0);
  }, 60000);

  it("keeps multi-turn context via id reuse", async () => {
    const c = { accessToken: "public", providerSpecificData: {} };
    const call = async (messages) => {
      const { response } = await ex.execute({ model: "deepseek_r1", body: { messages }, stream: false, credentials: c, log });
      return (await response.json()).choices[0].message.content;
    };
    const r1 = await call([{ role: "user", content: "My name is Alice." }]);
    const r2 = await call([
      { role: "user", content: "My name is Alice." },
      { role: "assistant", content: r1 },
      { role: "user", content: "What is my name?" },
    ]);
    expect(r2.toLowerCase()).toContain("alice");
  }, 90000);
});
