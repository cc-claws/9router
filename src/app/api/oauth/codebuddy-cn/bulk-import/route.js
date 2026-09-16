import { NextResponse } from "next/server";
import {
  createProviderConnection,
  getProviderConnections,
  updateProviderConnection,
} from "@/models";

function decodeJwtPayload(token) {
  if (!token || typeof token !== "string" || !token.startsWith("eyJ") || !token.includes(".")) {
    return {};
  }
  try {
    const parts = token.split(".");
    if (parts.length < 2) return {};
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

/**
 * POST /api/oauth/codebuddy-cn/bulk-import
 * Bulk import multiple CodeBuddy CN / WorkBuddy accounts.
 *
 * Body accepts:
 *   - Array: [{...}, {...}]
 *   - Wrapped: { accounts: [{...}, ...] }
 *
 * Each item must contain at least `accessToken`.
 * Sensitive tokens are NEVER echoed back in the response.
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return NextResponse.json(
      { error: `Invalid JSON body: ${err.message}` },
      { status: 400 }
    );
  }

  let accounts;
  if (Array.isArray(body)) {
    accounts = body;
  } else if (body && typeof body === "object" && Array.isArray(body.accounts)) {
    accounts = body.accounts;
  } else if (body && typeof body === "object") {
    accounts = [body];
  } else {
    accounts = null;
  }

  if (!Array.isArray(accounts) || accounts.length === 0) {
    return NextResponse.json(
      { error: "No accounts provided" },
      { status: 400 }
    );
  }

  const results = [];
  let success = 0;
  let failed = 0;

  // Fetch existing connections to allow intelligent update of existing ones
  const existingConnections = await getProviderConnections("codebuddy-cn");

  const existingMap = new Map();
  for (const conn of existingConnections) {
    existingMap.set(conn.id, conn);
    const psd = conn.providerSpecificData || {};
    if (psd.uid) existingMap.set(`uid:${psd.uid}`, conn);
    if (conn.email) existingMap.set(`email:${conn.email}`, conn);

    if (conn.accessToken) {
      const p = decodeJwtPayload(conn.accessToken);
      if (p.sub) existingMap.set(`uid:${p.sub}`, conn);
      if (p.preferred_username) {
        existingMap.set(`phone:${p.preferred_username}`, conn);
        existingMap.set(`email:${p.preferred_username}@workbuddy`, conn);
      }
    }
  }

  // Serial loop to avoid priority race condition
  for (let i = 0; i < accounts.length; i++) {
    const raw = accounts[i];
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Item is not an object");
      }

      const accessToken = raw.accessToken || raw.access_token || raw.auth_raw?.auth?.accessToken;
      if (!accessToken || typeof accessToken !== "string") {
        throw new Error("Missing accessToken");
      }

      const refreshToken =
        raw.refreshToken || raw.refresh_token || raw.auth_raw?.auth?.refreshToken || "";

      const jwtPayload = decodeJwtPayload(accessToken);

      const phoneNumber =
        raw.phoneNumber ||
        raw.auth_raw?.account?.phoneNumber ||
        jwtPayload.preferred_username ||
        "";

      const nickname =
        raw.nickname ||
        raw.name ||
        raw.auth_raw?.account?.nickname ||
        jwtPayload.nickname ||
        "";

      const uid =
        raw.uid ||
        raw.auth_raw?.account?.uid ||
        jwtPayload.sub ||
        `workbuddy-${i + 1}`;

      const email =
        raw.email ||
        (phoneNumber ? `${phoneNumber}@workbuddy` : null);

      let displayName = raw.name;
      if (!displayName) {
        if (nickname && phoneNumber && nickname !== phoneNumber) {
          displayName = `${nickname} (${phoneNumber})`;
        } else if (nickname) {
          displayName = nickname;
        } else if (phoneNumber) {
          displayName = `WorkBuddy (${phoneNumber})`;
        } else {
          displayName = `WorkBuddy Account ${i + 1}`;
        }
      }

      let expiresAt = raw.expiresAt;
      if (!expiresAt) {
        if (jwtPayload.exp) {
          expiresAt = new Date(jwtPayload.exp * 1000).toISOString();
        } else if (raw.expiresIn || raw.expires_in) {
          expiresAt = new Date(Date.now() + (raw.expiresIn || raw.expires_in) * 1000).toISOString();
        } else {
          // Default 60 days
          expiresAt = new Date(Date.now() + 5184000 * 1000).toISOString();
        }
      } else if (typeof expiresAt === "number") {
        expiresAt = new Date(expiresAt).toISOString();
      }

      const providerSpecificData = {
        uid,
        phoneNumber: phoneNumber || null,
        nickname: nickname || null,
        username: phoneNumber || null,
        source: "wb-switch",
      };

      // Check if this matches an existing connection to update
      let targetExisting = null;
      if (raw.existingConnectionId && existingMap.has(raw.existingConnectionId)) {
        targetExisting = existingMap.get(raw.existingConnectionId);
      } else if (uid && existingMap.has(`uid:${uid}`)) {
        targetExisting = existingMap.get(`uid:${uid}`);
      } else if (phoneNumber && existingMap.has(`phone:${phoneNumber}`)) {
        targetExisting = existingMap.get(`phone:${phoneNumber}`);
      } else if (email && existingMap.has(`email:${email}`)) {
        targetExisting = existingMap.get(`email:${email}`);
      }

      let connection;
      if (targetExisting) {
        connection = await updateProviderConnection(targetExisting.id, {
          name: displayName,
          email: email || targetExisting.email,
          accessToken,
          refreshToken: refreshToken || targetExisting.refreshToken,
          expiresAt,
          providerSpecificData: {
            ...(targetExisting.providerSpecificData || {}),
            ...providerSpecificData,
          },
          testStatus: "active",
          isActive: true,
          lastTested: new Date().toISOString(),
        });
      } else {
        connection = await createProviderConnection({
          provider: "codebuddy-cn",
          authType: "oauth",
          name: displayName,
          email,
          accessToken,
          refreshToken,
          expiresAt,
          providerSpecificData,
          testStatus: "active",
          isActive: true,
        });
      }

      results.push({
        status: "fulfilled",
        name: displayName,
        email,
        id: connection?.id,
        updated: !!targetExisting,
      });
      success++;
    } catch (err) {
      results.push({
        status: "rejected",
        error: err.message,
        index: i,
      });
      failed++;
    }
  }

  return NextResponse.json({
    success,
    failed,
    results,
  });
}
