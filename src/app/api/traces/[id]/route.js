import { NextResponse } from "next/server";
import { getTraceById, getTraceSpans, getTraceScores } from "@/lib/usageDb";

/**
 * GET /api/traces/[id]
 * One trace + its spans + scores. Span payloads (request/response) are the
 * sanitized/truncated records persisted by requestDetailsRepo — the full detail
 * lives here only (list API returns metadata only), matching the privacy
 * boundary of /api/usage/request-details.
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const trace = await getTraceById(id);
    if (!trace) return NextResponse.json({ error: "Trace not found" }, { status: 404 });

    const spans = await getTraceSpans(id);
    const scores = await getTraceScores(id);
    return NextResponse.json({ trace, spans, scores });
  } catch (error) {
    console.error("[API] Failed to get trace:", error);
    return NextResponse.json({ error: "Failed to fetch trace" }, { status: 500 });
  }
}
