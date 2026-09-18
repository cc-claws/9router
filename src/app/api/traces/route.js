import { NextResponse } from "next/server";
import { getTraces } from "@/lib/usageDb";

/**
 * GET /api/traces
 * Trace list (metadata only — no message bodies).
 * Query: page, pageSize (1-100), status, sessionId, requestedModel, startDate, endDate
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const pageRaw = parseInt(searchParams.get("page"));
    const page = Number.isNaN(pageRaw) ? 1 : pageRaw;
    const pageSizeRaw = parseInt(searchParams.get("pageSize"));
    const pageSize = Number.isNaN(pageSizeRaw) ? 20 : pageSizeRaw;

    if (page < 1) return NextResponse.json({ error: "Page must be >= 1" }, { status: 400 });
    if (pageSize < 1 || pageSize > 100) return NextResponse.json({ error: "PageSize must be between 1 and 100" }, { status: 400 });

    const filter = { page, pageSize };
    for (const key of ["status", "sessionId", "requestedModel", "startDate", "endDate"]) {
      const v = searchParams.get(key);
      if (v) filter[key] = v;
    }

    const result = await getTraces(filter);
    return NextResponse.json(result);
  } catch (error) {
    console.error("[API] Failed to get traces:", error);
    return NextResponse.json({ error: "Failed to fetch traces" }, { status: 500 });
  }
}
