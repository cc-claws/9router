import { NextResponse } from "next/server";
import { getSessions } from "@/lib/usageDb";

/**
 * GET /api/traces/sessions
 * Sessions aggregated from traces (requests / successes / tokens / cost / time range).
 * Query: startDate, endDate, limit
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const filter = {};
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const limitRaw = parseInt(searchParams.get("limit"));
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;
    if (!Number.isNaN(limitRaw) && limitRaw > 0) filter.limit = Math.min(limitRaw, 500);

    const sessions = await getSessions(filter);
    return NextResponse.json({ sessions });
  } catch (error) {
    console.error("[API] Failed to get sessions:", error);
    return NextResponse.json({ error: "Failed to fetch sessions" }, { status: 500 });
  }
}
