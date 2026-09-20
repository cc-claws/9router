import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const dbDir = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "9router",
  "db"
);
const dbPath = path.join(dbDir, "data.sqlite");
const backupPath = path.join(dbDir, `data.sqlite.bak_${Date.now()}`);

console.log("Database path:", dbPath);

if (!fs.existsSync(dbPath)) {
  console.error("Database file does not exist:", dbPath);
  process.exit(1);
}

// 1. 安全备份
fs.copyFileSync(dbPath, backupPath);
console.log("✅ Backup created successfully at:", backupPath);

// 2. 连接并查询
const db = new DatabaseSync(dbPath);

const beforeRows = db
  .prepare(
    "SELECT key FROM kv WHERE scope = 'customModels' AND (key LIKE 'cl|%' OR key LIKE 'cline|%')"
  )
  .all();

console.log(`Found ${beforeRows.length} customModels for cl/cline before cleanup.`);

if (beforeRows.length > 0) {
  // 3. 执行删除
  const result = db
    .prepare(
      "DELETE FROM kv WHERE scope = 'customModels' AND (key LIKE 'cl|%' OR key LIKE 'cline|%')"
    )
    .run();
  console.log(`✅ Deleted ${result.changes} invalid/unreachable customModels entries.`);
}

// 4. 验证清理后状态
const afterRows = db
  .prepare(
    "SELECT key FROM kv WHERE scope = 'customModels' AND (key LIKE 'cl|%' OR key LIKE 'cline|%')"
  )
  .all();

console.log(`Remaining customModels for cl/cline: ${afterRows.length}`);
console.log("🎉 Cleanup complete!");
