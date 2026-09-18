import { NextResponse } from "next/server";
import { getRequestDetailById } from "@/lib/usageDb";

/**
 * GET /api/traces/[id]/spans/[spanId]
 * Full span payload (request/providerRequest/providerResponse/response).
 * Stored data is already sanitized (headers stripped) and truncated by
 * requestDetailsRepo — same privacy boundary as the rest of observability.
 */
export async function GET(request, { params }) {
  try {
    const { spanId } = await params;
    const detail = await getRequestDetailById(spanId);
    if (!detail) return NextResponse.json({ error: "Span not found" }, { status: 404 });
    return NextResponse.json({ detail });
  } catch (error) {
    console.error("[API] Failed to get span detail:", error);
    return NextResponse.json({ error: "Failed to fetch span detail" }, { status: 500 });
  }
}
