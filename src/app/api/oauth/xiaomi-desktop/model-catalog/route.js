import { NextResponse } from "next/server";
import { readFile, access, constants } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

/**
 * GET /api/oauth/xiaomi-desktop/model-catalog
 * Read the local MiMo Desktop model catalog for dynamic model discovery.
 *
 * Source: %APPDATA%/Xiaomi MiMo/model-catalog.json (Windows)
 *         ~/Library/Application Support/Xiaomi MiMo/model-catalog.json (macOS)
 *
 * Shape: { account: "...", models: [{ id, name, modelType, tags, ... }] }
 */

function getCandidatePaths() {
  const home = homedir();
  const paths = [];

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    paths.push(join(appData, "Xiaomi MiMo", "model-catalog.json"));
  } else if (process.platform === "darwin") {
    paths.push(
      join(home, "Library", "Application Support", "Xiaomi MiMo", "model-catalog.json"),
    );
  } else {
    // Linux — MiMo Desktop may not be available, but try XDG
    paths.push(join(home, ".config", "Xiaomi MiMo", "model-catalog.json"));
  }

  return paths;
}

export async function GET() {
  try {
    const candidates = getCandidatePaths();

    let catalogPath = null;
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.R_OK);
        catalogPath = candidate;
        break;
      } catch {
        // Try next
      }
    }

    if (!catalogPath) {
      return NextResponse.json({
        found: false,
        error: `Model catalog not found. Checked:\n${candidates.join("\n")}\n\nMake sure Xiaomi MiMo Desktop is installed.`,
      });
    }

    const raw = await readFile(catalogPath, "utf-8");
    let catalog;
    try {
      catalog = JSON.parse(raw);
    } catch {
      return NextResponse.json({
        found: false,
        error: "model-catalog.json is not valid JSON.",
      });
    }

    const models = (catalog?.models || []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      modelType: m.modelType || "TEXT",
      tags: m.tags || [],
    }));

    // Separate TEXT models (chat) from media models
    const textModels = models.filter((m) => m.modelType === "TEXT");
    const ttsModels = models.filter((m) => m.modelType === "TTS");
    const asrModels = models.filter((m) => m.modelType === "ASR");
    const imageModels = models.filter((m) => m.modelType === "IMAGE_GENERATION");

    return NextResponse.json({
      found: true,
      account: catalog?.account || null,
      source: catalogPath,
      models,
      textModels,
      ttsModels,
      asrModels,
      imageModels,
      counts: {
        total: models.length,
        text: textModels.length,
        tts: ttsModels.length,
        asr: asrModels.length,
        image: imageModels.length,
      },
    });
  } catch (error) {
    console.log("Xiaomi Desktop model-catalog error:", error);
    return NextResponse.json(
      { found: false, error: error.message },
      { status: 500 },
    );
  }
}
