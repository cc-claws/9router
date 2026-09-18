import { NextResponse } from "next/server";
import { getPrompts, savePrompt } from "@/lib/usageDb";

/**
 * GET /api/traces/prompts — list saved prompts
 * POST /api/traces/prompts  { name, content, sourceTraceId? }
 */
export async function GET() {
  try {
    const prompts = await getPrompts();
    return NextResponse.json({ prompts });
  } catch (error) {
    console.error("[API] Failed to get prompts:", error);
    return NextResponse.json({ error: "Failed to fetch prompts" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const name = body?.name?.trim();
    const content = body?.content;
    if (!name || typeof content !== "string" || !content.trim()) {
      return NextResponse.json({ error: "name and content are required" }, { status: 400 });
    }
    const id = await savePrompt({ name, content, sourceTraceId: body?.sourceTraceId || null });
    return NextResponse.json({ id });
  } catch (error) {
    console.error("[API] Failed to save prompt:", error);
    return NextResponse.json({ error: "Failed to save prompt" }, { status: 500 });
  }
}
