import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";
import { probeClineModels } from "open-sse/services/clinepassModels.js";

/**
 * POST /api/providers/[id]/models/probe
 *
 * Cline's /models endpoint returns its whole routing catalog rather than the
 * account's usable set, so the dashboard probes candidates here (server-side,
 * where the credentials live) and only imports the ones that answer.
 * Auth is covered by the /api/providers prefix in src/dashboardGuard.js.
 */
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    if (!connection.accessToken && !connection.apiKey) {
      return NextResponse.json({ error: "No valid token found" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const result = await probeClineModels(
      { accessToken: connection.accessToken, apiKey: connection.apiKey },
      body?.models
    );

    return NextResponse.json(result);
  } catch (error) {
    console.log("Error probing Cline models:", error);
    return NextResponse.json({ error: "Failed to probe models" }, { status: 500 });
  }
}
