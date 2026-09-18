import { describe, it, expect } from "vitest";
import { encodeRow, decodeRow, __test__ } from "../../src/lib/db/helpers/rowCodec.js";

describe("rowCodec", () => {
  it("round-trips a large payload and actually shrinks it", () => {
    // Repetitive JSON like a real system prompt — compresses well.
    const big = {
      request: { messages: [{ role: "system", content: "z".repeat(200_000) }] },
      providerRequest: { messages: [{ role: "system", content: "z".repeat(200_000) }] },
      latency: { total: 1234 },
      tokens: { prompt_tokens: 5, completion_tokens: 6 },
    };
    const encoded = encodeRow(big);
    const rawSize = JSON.stringify(big).length;

    expect(encoded.startsWith(__test__.MAGIC)).toBe(true);
    expect(encoded.length).toBeLessThan(rawSize / 5);

    const decoded = decodeRow(encoded);
    expect(decoded.latency.total).toBe(1234);
    expect(decoded.request.messages[0].content.length).toBe(200_000);
    expect(decoded.providerRequest.messages[0].content).toBe("z".repeat(200_000));
  });

  it("leaves small rows uncompressed and still decodes them", () => {
    const small = { status: "success", latency: { total: 12 } };
    const encoded = encodeRow(small);
    expect(encoded.startsWith(__test__.MAGIC)).toBe(false);
    expect(decodedSafe(encoded)).toEqual(small);
  });

  it("does not compress when base64 would not pay off", () => {
    // ~3KB of incompressible random-ish data: gzip + base64 can exceed the original.
    let seed = 1;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return String.fromCharCode(33 + (seed % 90)); };
    const noisy = { blob: Array.from({ length: 3000 }, rnd).join("") };
    const encoded = encodeRow(noisy);
    if (encoded.startsWith(__test__.MAGIC)) {
      expect(encoded.length).toBeLessThan(JSON.stringify(noisy).length);
    }
    expect(decodedSafe(encoded).blob).toBe(noisy.blob);
  });

  it("reads legacy uncompressed rows unchanged", () => {
    const legacy = JSON.stringify({ provider: "openai", status: "success" });
    expect(decodedSafe(legacy)).toEqual({ provider: "openai", status: "success" });
  });

  it("returns {} for corrupt compressed data instead of throwing", () => {
    expect(decodeRow(__test__.MAGIC + "!!!not-base64-gzip!!!")).toEqual({});
  });
});

function decodedSafe(raw) {
  return decodeRow(raw);
}
