import { NextResponse } from "next/server";
import { getProviderConnections } from "@/models";

/**
 * GET /api/oauth/xiaomi-desktop/usage
 * Fetch weekly quota usage from the Xiaomi platform.
 *
 * The Desktop's "Usage & billing" page calls:
 *   GET {aistudio_base}/user/usage
 *   → { code: 0, data: { percent: 94, resetDate: "2026-09-16" } }
 *
 * Auth: Xiaomi account session (NOT the sk- API key).
 * When only an API key is available, returns a degraded response.
 */

const AIUDIO_BASE = "https://aistudio.xiaomimimo.com/open-apis/v1";

export async function GET() {
  try {
    const connections = await getProviderConnections();
    const conn = connections.find(
      (c) => c.provider === "xiaomi-desktop" && c.testStatus !== "disabled",
    );

    if (!conn) {
      return NextResponse.json({
        ok: false,
        error: "No active xiaomi-desktop connection found",
        usage: null,
      });
    }

    const token = conn.accessToken || conn.apiKey;
    if (!token) {
      return NextResponse.json({
        ok: false,
        error: "No credentials available",
        usage: null,
      });
    }

    // Try the aistudio usage endpoint with the account session token.
    // The sk- API key alone may not work for this endpoint — it needs the
    // Xiaomi account session. We try both auth header styles.
    const headers = {
      Authorization: `Bearer ${token}`,
      "X-Mimo-Source": "mimocode-cli",
      Accept: "application/json",
    };

    try {
      const resp = await fetch(`${AIUDIO_BASE}/user/usage`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10000),
      });

      if (resp.status === 401) {
        // sk- key doesn't have access to the usage endpoint.
        // This is expected — the usage endpoint needs the account session.
        return NextResponse.json({
          ok: false,
          error: "auth-required",
          message:
            "Weekly quota requires Xiaomi account session. API key alone is insufficient. Use the OAuth flow or Desktop auto-import.",
          usage: null,
          degraded: true,
        });
      }

      if (!resp.ok) {
        return NextResponse.json({
          ok: false,
          error: `usage http ${resp.status}`,
          usage: null,
        });
      }

      const data = await resp.json();
      if (!data || data.code !== 0 || !data.data) {
        return NextResponse.json({
          ok: false,
          error: "no-data",
          message: "Usage endpoint returned unexpected shape",
          usage: null,
        });
      }

      const { percent, resetDate } = data.data;
      if (typeof percent !== "number" || !Number.isFinite(percent)) {
        return NextResponse.json({
          ok: false,
          error: "invalid-percent",
          usage: null,
        });
      }

      return NextResponse.json({
        ok: true,
        usage: {
          percent,
          resetDate: resetDate || null,
          period: "week",
          // Derive used/total for 9Router's quota tracker display
          used: 100 - percent,
          total: 100,
          unit: "percent",
        },
      });
    } catch (fetchErr) {
      return NextResponse.json({
        ok: false,
        error: fetchErr.message || "fetch failed",
        usage: null,
      });
    }
  } catch (error) {
    console.log("Xiaomi Desktop usage error:", error);
    return NextResponse.json(
      { ok: false, error: error.message, usage: null },
      { status: 500 },
    );
  }
}
