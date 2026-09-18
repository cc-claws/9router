import { NextResponse } from "next/server";
import { addTraceScore, deleteTraceScore, getTraceScores } from "@/lib/usageDb";

/**
 * POST /api/traces/[id]/score  { score: 1|-1, comment? }
 * DELETE /api/traces/[id]/score?scoreId=<n>
 */
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const score = body?.score;
    if (score !== 1 && score !== -1 && score !== 0) {
      return NextResponse.json({ error: "score must be 1 (thumbs up), -1 (thumbs down) or 0 (neutral)" }, { status: 400 });
    }
    await addTraceScore({ traceId: id, score, comment: body?.comment || null });
    return NextResponse.json({ scores: await getTraceScores(id) });
  } catch (error) {
    console.error("[API] Failed to add trace score:", error);
    return NextResponse.json({ error: "Failed to add score" }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const scoreId = parseInt(searchParams.get("scoreId"));
    if (Number.isNaN(scoreId)) {
      return NextResponse.json({ error: "scoreId is required" }, { status: 400 });
    }
    await deleteTraceScore(scoreId);
    return NextResponse.json({ scores: await getTraceScores(id) });
  } catch (error) {
    console.error("[API] Failed to delete trace score:", error);
    return NextResponse.json({ error: "Failed to delete score" }, { status: 500 });
  }
}
