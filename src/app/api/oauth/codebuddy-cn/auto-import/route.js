import { NextResponse } from "next/server";
import { readFile, access, constants } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { getProviderConnections } from "@/models";

function getCandidatePaths() {
  const home = homedir();
  const paths = [
    join(home, ".wb-switch", "accounts.json"),
    join(home, ".workbuddy", "accounts.json"),
  ];

  if (process.env.USERPROFILE && process.env.USERPROFILE !== home) {
    paths.unshift(join(process.env.USERPROFILE, ".wb-switch", "accounts.json"));
  }

  return paths;
}

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
 * GET /api/oauth/codebuddy-cn/auto-import
 * Auto-detect local WorkBuddy / wb-switch accounts.
 */
export async function GET() {
  try {
    const candidatePaths = getCandidatePaths();
    let foundPath = null;
    let rawContent = null;

    for (const candidate of candidatePaths) {
      try {
        await access(candidate, constants.R_OK);
        rawContent = await readFile(candidate, "utf8");
        foundPath = candidate;
        break;
      } catch {
        // continue trying next candidate
      }
    }

    if (!foundPath || !rawContent) {
      return NextResponse.json({
        found: false,
        candidatePaths,
        accounts: [],
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawContent);
    } catch (err) {
      return NextResponse.json({
        found: false,
        error: `Failed to parse ${foundPath}: ${err.message}`,
        candidatePaths,
        accounts: [],
      });
    }

    const rawAccounts = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.accounts)
        ? parsed.accounts
        : [];

    // Fetch existing connections to flag already-imported accounts
    const existingConnections = await getProviderConnections("codebuddy-cn");

    const existingIdentifiers = new Map();
    for (const conn of existingConnections) {
      const psd = conn.providerSpecificData || {};
      if (psd.uid) existingIdentifiers.set(psd.uid, conn.id);
      if (conn.email) existingIdentifiers.set(conn.email, conn.id);

      // Also decode token JWT if available
      if (conn.accessToken) {
        const payload = decodeJwtPayload(conn.accessToken);
        if (payload.sub) existingIdentifiers.set(payload.sub, conn.id);
        if (payload.preferred_username) existingIdentifiers.set(payload.preferred_username, conn.id);
      }
    }

    const accounts = rawAccounts.map((item, index) => {
      const accessToken = item.access_token || item.auth_raw?.auth?.accessToken || "";
      const refreshToken = item.refresh_token || item.auth_raw?.auth?.refreshToken || "";
      const jwtPayload = decodeJwtPayload(accessToken);

      const nickname =
        item.nickname ||
        item.auth_raw?.account?.nickname ||
        jwtPayload.nickname ||
        "";
      const phoneNumber =
        item.auth_raw?.account?.phoneNumber ||
        jwtPayload.preferred_username ||
        "";
      const uid =
        item.uid ||
        item.auth_raw?.account?.uid ||
        jwtPayload.sub ||
        `account-${index + 1}`;

      const expiresAt =
        item.expiresAt ||
        item.auth_raw?.auth?.expiresAt ||
        (jwtPayload.exp ? jwtPayload.exp * 1000 : null);

      const existingId =
        existingIdentifiers.get(uid) ||
        (phoneNumber ? existingIdentifiers.get(phoneNumber) : null) ||
        (phoneNumber ? existingIdentifiers.get(`${phoneNumber}@workbuddy`) : null);

      return {
        index,
        nickname: nickname || phoneNumber || `WorkBuddy ${index + 1}`,
        phoneNumber: phoneNumber || null,
        uid,
        email: item.email || (phoneNumber ? `${phoneNumber}@workbuddy` : null),
        expiresAt,
        accessToken,
        refreshToken,
        isImported: !!existingId,
        existingConnectionId: existingId || null,
      };
    });

    return NextResponse.json({
      found: true,
      path: foundPath,
      accounts,
    });
  } catch (error) {
    return NextResponse.json(
      { found: false, error: error.message },
      { status: 500 }
    );
  }
}
