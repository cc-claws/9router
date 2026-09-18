import { NextResponse } from "next/server";
import { getPromptById, deletePrompt } from "@/lib/usageDb";

/** GET /api/traces/prompts/[id] — single prompt. DELETE removes it. */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const prompt = await getPromptById(id);
    if (!prompt) return NextResponse.json({ error: "Prompt not found" }, { status: 404 });
    return NextResponse.json({ prompt });
  } catch (error) {
    console.error("[API] Failed to get prompt:", error);
    return NextResponse.json({ error: "Failed to fetch prompt" }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    await deletePrompt(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[API] Failed to delete prompt:", error);
    return NextResponse.json({ error: "Failed to delete prompt" }, { status: 500 });
  }
}
