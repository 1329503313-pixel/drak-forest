import type { RowDataPacket } from "mysql2";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { getPool } from "./db.js";

const DEFAULT_ADMIN_USER = "admin";
const DEFAULT_ADMIN_PASS = "123456";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Session = { adminId: string; username: string; expiresAt: number };
const sessions = new Map<string, Session>();

type AdminDbRow = RowDataPacket & {
  id: string;
  username: string;
  password_hash: string;
  salt: string;
  created_at: number;
};

function hashPassword(plain: string): { passwordHash: string; salt: string } {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(plain, salt, 64);
  return { passwordHash: derived.toString("hex"), salt };
}

function verifyPassword(plain: string, passwordHash: string, salt: string): boolean {
  const derived = scryptSync(plain, salt, 64);
  const expected = Buffer.from(passwordHash, "hex");
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

function normalizeUsername(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (s.length < 1 || s.length > 32) return null;
  if (!/^[\w\u4e00-\u9fa5.-]+$/.test(s)) return null;
  return s;
}

function pruneSessions(): void {
  const now = Date.now();
  for (const [t, s] of sessions) {
    if (s.expiresAt <= now) sessions.delete(t);
  }
}

export async function ensureDefaultAdmins(): Promise<void> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS c FROM admins");
  const c = Number((rows[0] as { c: number }).c) || 0;
  if (c > 0) return;
  const { passwordHash, salt } = hashPassword(DEFAULT_ADMIN_PASS);
  const id = randomUUID();
  await pool.execute(
    `INSERT INTO admins (id, username, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, DEFAULT_ADMIN_USER, passwordHash, salt, Date.now()]
  );
}

export async function tryLogin(
  usernameRaw: unknown,
  passwordRaw: unknown
): Promise<{ token: string; username: string } | null> {
  const username = normalizeUsername(usernameRaw);
  const password = String(passwordRaw ?? "");
  if (!username || password.length < 1) return null;
  await ensureDefaultAdmins();
  const pool = getPool();
  const [rows] = await pool.query<AdminDbRow[]>(
    "SELECT id, username, password_hash, salt FROM admins WHERE username = ? LIMIT 1",
    [username]
  );
  const admin = rows[0];
  if (!admin || !verifyPassword(password, admin.password_hash, admin.salt)) return null;
  pruneSessions();
  const token = randomBytes(32).toString("hex");
  sessions.set(token, {
    adminId: admin.id,
    username: admin.username,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return { token, username: admin.username };
}

export function logoutSession(token: string | undefined): void {
  if (!token) return;
  sessions.delete(token);
}

export function validateSession(token: string | undefined): { adminId: string; username: string } | null {
  if (!token) return null;
  pruneSessions();
  const s = sessions.get(token);
  if (!s || s.expiresAt <= Date.now()) {
    if (s) sessions.delete(token);
    return null;
  }
  return { adminId: s.adminId, username: s.username };
}

export type AdminPublic = { id: string; username: string; createdAt: number };

export async function listAdminUsers(): Promise<AdminPublic[]> {
  await ensureDefaultAdmins();
  const pool = getPool();
  const [rows] = await pool.query<AdminDbRow[]>(
    "SELECT id, username, created_at FROM admins ORDER BY username ASC"
  );
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    createdAt: Number(r.created_at),
  }));
}

export async function changeAdminPassword(
  adminId: string,
  oldPassword: unknown,
  newPassword: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const oldP = String(oldPassword ?? "");
  const newP = String(newPassword ?? "");
  if (newP.length < 6) return { ok: false, error: "新密码至少 6 位" };
  if (newP.length > 128) return { ok: false, error: "新密码过长" };
  const pool = getPool();
  const [rows] = await pool.query<AdminDbRow[]>(
    "SELECT id, password_hash, salt FROM admins WHERE id = ? LIMIT 1",
    [adminId]
  );
  const admin = rows[0];
  if (!admin) return { ok: false, error: "用户不存在" };
  if (!verifyPassword(oldP, admin.password_hash, admin.salt)) {
    return { ok: false, error: "原密码错误" };
  }
  const { passwordHash, salt } = hashPassword(newP);
  await pool.execute(
    "UPDATE admins SET password_hash = ?, salt = ? WHERE id = ?",
    [passwordHash, salt, adminId]
  );
  return { ok: true };
}

export async function createAdminUser(
  actorAdminId: string,
  usernameRaw: unknown,
  passwordRaw: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  await ensureDefaultAdmins();
  const username = normalizeUsername(usernameRaw);
  const password = String(passwordRaw ?? "");
  if (!username) return { ok: false, error: "用户名 1–32 位，支持字母数字中文._-" };
  if (password.length < 6) return { ok: false, error: "密码至少 6 位" };
  if (password.length > 128) return { ok: false, error: "密码过长" };
  const pool = getPool();
  const [actors] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM admins WHERE id = ? LIMIT 1",
    [actorAdminId]
  );
  if (!actors[0]) {
    return { ok: false, error: "无权操作" };
  }
  const [dup] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM admins WHERE username = ? LIMIT 1",
    [username]
  );
  if (dup[0]) {
    return { ok: false, error: "用户名已存在" };
  }
  const { passwordHash, salt } = hashPassword(password);
  await pool.execute(
    `INSERT INTO admins (id, username, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)`,
    [randomUUID(), username, passwordHash, salt, Date.now()]
  );
  return { ok: true };
}
