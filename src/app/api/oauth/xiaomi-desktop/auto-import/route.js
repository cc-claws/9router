import { NextResponse } from "next/server";
import { readFile, access, constants } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

/**
 * GET /api/oauth/xiaomi-desktop/auto-import
 * Auto-detect Xiaomi MiMo Desktop credentials from local auth.json.
 *
 * Sources (in priority order):
 *   1. ~/.local/share/mimocode/auth.json  → xiaomi field
 *   2. %APPDATA%/Xiaomi MiMo/...          → (future: Desktop keychain)
 *
 * auth.json shape:
 * {
 *   "xiaomi": {
 *     "type": "api",
 *     "key": "sk-xxxx",
 *     "metadata": { "uid": "...", "base_url": "https://api.xiaomimimo.com/v1" }
 *   }
 * }
 */

function getCandidatePaths() {
  const home = homedir();
  const paths = [];

  // MiMoCode / MiMo Desktop shared data dir (cross-platform XDG)
  paths.push(join(home, ".local", "share", "mimocode", "auth.json"));

  // Windows: also check USERPROFILE-based XDG
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    // Desktop's own storage (may have separate credentials in the future)
    paths.push(join(appData, "Xiaomi MiMo", "auth.json"));
  }

  // macOS
  if (process.platform === "darwin") {
    paths.push(
      join(home, "Library", "Application Support", "mimocode", "auth.json"),
    );
  }

  return paths;
}

/**
 * GET /api/oauth/xiaomi-desktop/auto-import
 */
export async function GET() {
  try {
    const candidates = getCandidatePaths();

    let authPath = null;
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.R_OK);
        authPath = candidate;
        break;
      } catch {
        // Try next candidate
      }
    }

    if (!authPath) {
      return NextResponse.json({
        found: false,
        error: `MiMo Desktop auth file not found. Checked:\n${candidates.join("\n")}\n\nMake sure Xiaomi MiMo Desktop is installed and you are signed in.`,
      });
    }

    const raw = await readFile(authPath, "utf-8");
    let auth;
    try {
      auth = JSON.parse(raw);
    } catch {
      return NextResponse.json({
        found: false,
        error: "auth.json is not valid JSON. Please sign in to MiMo Desktop again.",
      });
    }

    const xiaomi = auth?.xiaomi;
    if (!xiaomi || !xiaomi.key) {
      return NextResponse.json({
        found: false,
        error: "No Xiaomi credentials found in auth.json. Please sign in to MiMo Desktop.",
      });
    }

    // Validate key format
    const key = String(xiaomi.key).trim();
    if (!key.startsWith("sk-")) {
      return NextResponse.json({
        found: false,
        error: "Xiaomi key does not appear to be a valid API key (expected sk- prefix).",
      });
    }

    const metadata = xiaomi.metadata || {};
    const uid = metadata.uid || null;
    const baseUrl = metadata.base_url || "https://api.xiaomimimo.com/v1";

    // Mint a local engine token for Desktop-exclusive models (mimo-x-pro-preview etc.)
    let engineToken = null;
    let engineUrl = null;
    try {
      const { mintEngineToken, resolveEngineUrl } = await import("@/lib/oauth/providers/xiaomi-desktop-engine");
      engineUrl = resolveEngineUrl();
      if (engineUrl) {
        engineToken = await mintEngineToken();
      }
    } catch (e) {
      console.log("[xiaomi-desktop] engine token mint failed (non-fatal):", e.message);
    }

    return NextResponse.json({
      found: true,
      apiKey: key,
      uid,
      baseUrl,
      source: authPath,
      engineToken,
      engineUrl,
    });
  } catch (error) {
    console.log("Xiaomi Desktop auto-import error:", error);
    return NextResponse.json(
      { found: false, error: error.message },
      { status: 500 },
    );
  }
}
