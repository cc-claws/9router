/**
 * Xiaomi MiMo Desktop usage — weekly quota from the Xiaomi account session.
 *
 * GET {aistudio_base}/user/usage
 * Auth: Xiaomi account session (NOT the sk- API key)
 * Response: { code: 0, data: { percent: 94, resetDate: "2026-09-16" } }
 *
 * The sk- API key alone cannot access this endpoint. When only an API key is
 * present, we return a graceful message instead of failing.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const USAGE_URL = "https://aistudio.xiaomimimo.com/open-apis/v1/user/usage";

/**
 * @param {string|null|undefined} accessToken - sk- API key
 * @param {object|null} providerSpecificData - may contain engineToken, uid, etc.
 * @param {object|null} proxyOptions
 */
export async function getXiaomiDesktopUsage(accessToken = null, providerSpecificData = null, proxyOptions = null) {
  // The weekly quota endpoint needs the Xiaomi account session, not the sk- key.
  // We try with the sk- key first — if it 401s, we return a clear message.
  const key = accessToken || providerSpecificData?.apiKey;
  if (!key || typeof key !== "string" || !key.trim()) {
    return { message: "Xiaomi MiMo Desktop not connected. Add credentials to view usage." };
  }

  try {
    const response = await proxyAwareFetch(
      USAGE_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key.trim()}`,
          "X-Mimo-Source": "mimocode-cli",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10000),
      },
      proxyOptions,
    );

    if (response.status === 401) {
      return {
        plan: "Xiaomi MiMo Desktop",
        message: "Weekly quota requires Xiaomi account session. API key alone is insufficient.",
      };
    }

    if (!response.ok) {
      return {
        plan: "Xiaomi MiMo Desktop",
        message: `Usage API error (${response.status})`,
      };
    }

    const data = await response.json().catch(() => null);
    if (!data || data.code !== 0 || !data.data) {
      return {
        plan: "Xiaomi MiMo Desktop",
        message: "Usage endpoint returned unexpected response.",
      };
    }

    const { percent, resetDate } = data.data;
    if (typeof percent !== "number" || !Number.isFinite(percent)) {
      return {
        plan: "Xiaomi MiMo Desktop",
        message: "Usage data missing percent field.",
      };
    }

    // percent = remaining percentage (e.g. 94 means 94% remaining)
    const remaining = Math.max(0, Math.min(100, Math.round(percent)));
    const used = 100 - remaining;

    // Parse resetDate — expected format "2026-09-16"
    let resetAt = null;
    if (resetDate && typeof resetDate === "string") {
      const parsed = new Date(`${resetDate}T00:00:00Z`);
      if (!Number.isNaN(parsed.getTime())) {
        resetAt = parsed.toISOString();
      }
    }

    return {
      plan: "Xiaomi MiMo Desktop",
      quotas: {
        Weekly: {
          used,
          total: 100,
          remainingPercentage: remaining,
          resetAt,
          unlimited: false,
        },
      },
    };
  } catch (error) {
    return { message: `Xiaomi MiMo Desktop usage error: ${error.message}` };
  }
}
