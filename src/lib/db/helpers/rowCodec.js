import zlib from "node:zlib";
import { stringifyJson, parseJson } from "./jsonCol.js";

// Stored-payload codec for `requestDetails.data`.
//
// Full request/response bodies are kept verbatim (Traces are a debugging tool),
// and agent traffic runs ~1.6 MB per request — times two bodies, times thousands
// of rows. JSON request text gzips roughly 8-12x, so we compress large rows.
//
// Format: "GZ1:" + base64(gzip(json)). Base64 costs ~33% over a raw BLOB but
// keeps the value a plain TEXT string, which every driver in the adapter chain
// (bun:sqlite / better-sqlite3 / node:sqlite / sql.js) binds and reads back
// without BLOB-handling differences, and needs no schema change.
//
// Small rows are left as-is: for a few hundred bytes the base64 envelope can
// outweigh what gzip saves, so we keep whichever encoding is actually smaller.

const MAGIC = "GZ1:";
// Below this, compression is not worth attempting.
const MIN_COMPRESS_BYTES = 2 * 1024;

export function encodeRow(value) {
  const json = stringifyJson(value);
  if (typeof json !== "string" || json.length < MIN_COMPRESS_BYTES) return json;
  try {
    const packed = MAGIC + zlib.gzipSync(Buffer.from(json, "utf8")).toString("base64");
    return packed.length < json.length ? packed : json;
  } catch {
    return json;
  }
}

export function decodeRow(raw) {
  if (typeof raw !== "string" || !raw.startsWith(MAGIC)) return parseJson(raw, {});
  try {
    const gz = Buffer.from(raw.slice(MAGIC.length), "base64");
    return parseJson(zlib.gunzipSync(gz).toString("utf8"), {});
  } catch (e) {
    console.error("[rowCodec] failed to decompress row:", e?.message || e);
    return {};
  }
}

export const __test__ = { MAGIC, MIN_COMPRESS_BYTES };
