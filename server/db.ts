import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";

let pool: mysql.Pool | null = null;

export function getPool(): mysql.Pool {
  if (!pool) {
    throw new Error("数据库未初始化，请先调用 initDb()");
  }
  return pool;
}

function poolConfig(): mysql.PoolOptions {
  return {
    host: process.env.MYSQL_HOST ?? "127.0.0.1",
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "",
    database: process.env.MYSQL_DATABASE ?? "dark_forest",
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT ?? 10),
    maxIdle: Number(process.env.MYSQL_MAX_IDLE ?? 10),
    idleTimeout: 60000,
    enableKeepAlive: true,
    timezone: "Z",
  };
}

async function migrateLegacyJsonFiles(p: mysql.Pool): Promise<void> {
  const dataDir = path.join(process.cwd(), "server-data");
  const storeFile = path.join(dataDir, "match-store.json");
  const adminsFile = path.join(dataDir, "admins.json");

  if (fs.existsSync(storeFile)) {
    try {
      const raw = fs.readFileSync(storeFile, "utf-8");
      const j = JSON.parse(raw) as {
        accounts?: Record<string, { nickname: string; avatar: string; updatedAt: number }>;
        matches?: unknown[];
      };
      const accounts = j.accounts && typeof j.accounts === "object" ? j.accounts : {};
      for (const [id, row] of Object.entries(accounts)) {
        await p.execute(
          `INSERT IGNORE INTO accounts (game_account_id, nickname, avatar, updated_at)
           VALUES (?, ?, ?, ?)`,
          [id, row.nickname, row.avatar, row.updatedAt]
        );
      }
      const matches = Array.isArray(j.matches) ? j.matches : [];
      for (const m of matches) {
        const obj = m as Record<string, unknown>;
        const matchId = String(obj.matchId ?? "");
        if (!matchId) continue;
        const endedAt = Number(obj.endedAt) || 0;
        await p.execute(
          `INSERT IGNORE INTO matches (match_id, ended_at, payload) VALUES (?, ?, ?)`,
          [matchId, endedAt, JSON.stringify(m)]
        );
      }
      console.log("[db] 已从 server-data/match-store.json 导入历史数据（若无新行则已存在）");
    } catch (e) {
      console.warn("[db] 导入 match-store.json 失败:", e);
    }
  }

  if (fs.existsSync(adminsFile)) {
    try {
      const raw = fs.readFileSync(adminsFile, "utf-8");
      const j = JSON.parse(raw) as { version?: number; admins?: Array<Record<string, unknown>> };
      if (j.version === 1 && Array.isArray(j.admins)) {
        for (const a of j.admins) {
          const id = String(a.id ?? "");
          const username = String(a.username ?? "");
          const passwordHash = String(a.passwordHash ?? "");
          const salt = String(a.salt ?? "");
          const createdAt = Number(a.createdAt) || 0;
          if (!id || !username) continue;
          await p.execute(
            `INSERT IGNORE INTO admins (id, username, password_hash, salt, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            [id, username, passwordHash, salt, createdAt]
          );
        }
        console.log("[db] 已从 server-data/admins.json 导入管理员（若无新行则已存在）");
      }
    } catch (e) {
      console.warn("[db] 导入 admins.json 失败:", e);
    }
  }
}

export async function initDb(): Promise<mysql.Pool> {
  if (pool) return pool;
  pool = mysql.createPool(poolConfig());
  const p = pool;

  await p.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      game_account_id VARCHAR(64) NOT NULL PRIMARY KEY,
      nickname VARCHAR(64) NOT NULL,
      avatar MEDIUMTEXT NOT NULL,
      updated_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS matches (
      match_id VARCHAR(128) NOT NULL PRIMARY KEY,
      ended_at BIGINT NOT NULL,
      payload JSON NOT NULL,
      INDEX idx_matches_ended_at (ended_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      username VARCHAR(64) NOT NULL,
      password_hash VARCHAR(256) NOT NULL,
      salt VARCHAR(128) NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE KEY uk_admins_username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await migrateLegacyJsonFiles(p);
  return p;
}

export async function closeDb(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
