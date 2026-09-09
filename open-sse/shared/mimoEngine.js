import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";

/**
 * MiMo Desktop engine helpers — resolve the local engine URL and mint llm-server tokens.
 *
 * The engine runs on a random loopback port that changes per Desktop session.
 * It advertises itself at <data>/mimocode/llm-server/<sha1>/server-<pid>-<port>.json.
 * The /v1 endpoints accept minted Bearer tokens (SHA-256 hash stored in tokens.json).
 */

function getLlmServerDir() {
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(home, "AppData", "Roaming", "Xiaomi MiMo", "mimocode", "llm-server");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Xiaomi MiMo", "mimocode", "llm-server");
  }
  return path.join(home, ".config", "Xiaomi MiMo", "mimocode", "llm-server");
}

/**
 * Resolve the current engine base URL (e.g. http://127.0.0.1:4096).
 * Returns null if no live engine is found.
 */
export function resolveEngineUrl() {
  try {
    const llmServerDir = getLlmServerDir();
    if (!fs.existsSync(llmServerDir)) return null;

    let newest = null;
    let newestMtime = 0;
    for (const sub of fs.readdirSync(llmServerDir)) {
      const subDir = path.join(llmServerDir, sub);
      try {
        if (!fs.statSync(subDir).isDirectory()) continue;
      } catch { continue; }
      for (const f of fs.readdirSync(subDir)) {
        if (!f.startsWith("server-") || !f.endsWith(".json")) continue;
        const fp = path.join(subDir, sub === f ? f : path.join(sub, f));
        // Fix: full path
        const fullPath = path.join(subDir, f);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > newestMtime) {
            newestMtime = stat.mtimeMs;
            newest = fullPath;
          }
        } catch { /* skip */ }
      }
    }
    if (!newest) return null;

    const raw = fs.readFileSync(newest, "utf8");
    const info = JSON.parse(raw);
    if (info?.url) return String(info.url).replace(/\/+$/, "");
    if (info?.port) return `http://127.0.0.1:${info.port}`;
    return null;
  } catch {
    return null;
  }
}

/**
 * Find the tokens.json path for the current engine directory.
 */
function getTokensFilePath() {
  const llmServerDir = getLlmServerDir();
  if (!fs.existsSync(llmServerDir)) return null;

  // Find the most recently modified tokens.json
  let newest = null;
  let newestMtime = 0;
  for (const sub of fs.readdirSync(llmServerDir)) {
    const tokensPath = path.join(llmServerDir, sub, "tokens.json");
    try {
      const stat = fs.statSync(tokensPath);
      if (stat.mtimeMs > newestMtime) {
        newestMtime = stat.mtimeMs;
        newest = tokensPath;
      }
    } catch { /* skip */ }
  }
  return newest;
}

/**
 * Mint a new llm-server token for Desktop-exclusive chat models.
 * Writes the SHA-256 hash to tokens.json and returns the plaintext token.
 *
 * @param {string[]} [models] - Model IDs to grant. Defaults to X-Preview models.
 * @returns {Promise<string>} The plaintext Bearer token.
 */
export async function mintEngineToken(models) {
  const defaultModels = [
    "xiaomi/mimo-x-pro-preview",
    "xiaomi/mimo-x-flash-preview",
  ];
  const modelList = models && models.length > 0 ? models : defaultModels;

  const tokensFile = getTokensFilePath();
  if (!tokensFile) {
    throw new Error("MiMo Desktop llm-server directory not found. Is Desktop running?");
  }

  // Generate token (base64url of 32 random bytes — same as mimo llm-server issue)
  const token = crypto.randomBytes(32).toString("base64url");
  const hash = crypto.createHash("sha256").update(token).digest("hex");

  // Read existing store (handle BOM)
  let raw = fs.readFileSync(tokensFile, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const store = JSON.parse(raw);
  if (!Array.isArray(store.tokens)) store.tokens = [];

  // Remove previous 9router tokens (idempotent)
  store.tokens = store.tokens.filter(
    (t) => t.label !== "9router-xiaomi-desktop",
  );

  store.tokens.push({
    id: `llmk_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    hash,
    label: "9router-xiaomi-desktop",
    models: modelList,
    created: Date.now(),
    idle_ms: 86400000,       // 24h idle expiry
    max_age_ms: 604800000,   // 7d max age
  });

  fs.writeFileSync(tokensFile, JSON.stringify(store, null, 2), "utf8");
  return token;
}
