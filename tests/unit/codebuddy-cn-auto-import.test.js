import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";

// Isolate DB to a temp directory
const TMP = path.join(os.tmpdir(), `9router-cb-test-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });
process.env.DATA_DIR = TMP;

let autoImportGet;
let bulkImportPost;
let db;

beforeAll(async () => {
  db = await import("@/lib/db/index.js");
  await db.initDb();

  const autoImportModule = await import("../../src/app/api/oauth/codebuddy-cn/auto-import/route.js");
  autoImportGet = autoImportModule.GET;

  const bulkImportModule = await import("../../src/app/api/oauth/codebuddy-cn/bulk-import/route.js");
  bulkImportPost = bulkImportModule.POST;
});

describe("CodeBuddy CN (WorkBuddy) auto-import & bulk-import", () => {
  it("GET auto-import detects local accounts from ~/.wb-switch/accounts.json if present", async () => {
    const res = await autoImportGet();
    const data = await res.json();

    // If ~/.wb-switch/accounts.json exists on this machine, found should be true
    const wbPath = path.join(os.homedir(), ".wb-switch", "accounts.json");
    if (fs.existsSync(wbPath)) {
      expect(data.found).toBe(true);
      expect(Array.isArray(data.accounts)).toBe(true);
      expect(data.accounts.length).toBeGreaterThanOrEqual(1);

      const first = data.accounts[0];
      expect(first).toHaveProperty("accessToken");
      expect(first).toHaveProperty("uid");
      expect(first).toHaveProperty("nickname");
    } else {
      expect(data.found).toBe(false);
    }
  });

  it("POST bulk-import imports accounts into providerConnections without priority race", async () => {
    const fakeAccounts = [
      {
        nickname: "Test User 1",
        phoneNumber: "13800000001",
        uid: "test-uid-001",
        access_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVpZC0wMDEiLCJwcmVmZXJyZWRfdXNlcm5hbWUiOiIxMzgwMDAwMDAwMSIsIm5pY2tuYW1lIjoiVGVzdCBVc2VyIDEifQ.fake",
        refresh_token: "fake-refresh-1",
      },
      {
        nickname: "Test User 2",
        phoneNumber: "13800000002",
        uid: "test-uid-002",
        access_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVpZC0wMDIiLCJwcmVmZXJyZWRfdXNlcm5hbWUiOiIxMzgwMDAwMDAwMiIsIm5pY2tuYW1lIjoiVGVzdCBVc2VyIDIifQ.fake",
        refresh_token: "fake-refresh-2",
      },
    ];

    const req = new Request("http://localhost/api/oauth/codebuddy-cn/bulk-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accounts: fakeAccounts }),
    });

    const res = await bulkImportPost(req);
    const data = await res.json();

    expect(data.success).toBe(2);
    expect(data.failed).toBe(0);
    expect(data.results.length).toBe(2);

    const conns = await db.getProviderConnections("codebuddy-cn");
    expect(conns.length).toBe(2);

    // Verify priorities are 1 and 2
    const priorities = conns.map((c) => c.priority);
    expect(priorities).toContain(1);
    expect(priorities).toContain(2);
  });

  it("POST bulk-import updates existing account when UID or phone matches instead of duplicate", async () => {
    const updateAccount = [
      {
        nickname: "Test User 1 Updated",
        phoneNumber: "13800000001",
        uid: "test-uid-001",
        access_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVpZC0wMDEiLCJwcmVmZXJyZWRfdXNlcm5hbWUiOiIxMzgwMDAwMDAwMSIsIm5pY2tuYW1lIjoiVGVzdCBVc2VyIDEgVXBkYXRlZCJ9.fake2",
        refresh_token: "fake-refresh-1-updated",
      },
    ];

    const req = new Request("http://localhost/api/oauth/codebuddy-cn/bulk-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accounts: updateAccount }),
    });

    const res = await bulkImportPost(req);
    const data = await res.json();

    expect(data.success).toBe(1);
    expect(data.results[0].updated).toBe(true);

    const conns = await db.getProviderConnections("codebuddy-cn");
    expect(conns.length).toBe(2); // Still 2 accounts, not 3

    const conn1 = conns.find((c) => c.providerSpecificData?.uid === "test-uid-001");
    expect(conn1.name).toContain("Test User 1 Updated");
  });
});
