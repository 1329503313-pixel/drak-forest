import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

const DATA_DIR = path.join(process.cwd(), "server-data");
const ADMINS_FILE = path.join(DATA_DIR, "admins.json");

const DEFAULT_ADMIN_USER = "admin";
const DEFAULT_ADMIN_PASS = "123456";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type AdminRecord = {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  createdAt: number;
};

type AdminsFile = { version: 1; admins: AdminRecord[] };

type Session = { adminId: string; username: string; expiresAt: number };
const sessions = new Map<string, Session>();

function readFile(): AdminsFile {
  try {
    const raw = fs.readFileSync(ADMINS_FILE, "utf-8");
    const j = JSON.parse(raw) as AdminsFile;
    if (j.version !== 1 || !Array.isArray(j.admins)) return { version: 1, admins: [] };
    return j;
  } catch {
    return { version: 1, admins: [] };
  }
}

function writeFile(data: AdminsFile): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ADMINS_FILE, JSON.stringify(data, null, 0), "utf-8");
}

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

export function ensureDefaultAdmins(): void {
  const data = readFile();
  if (data.admins.length > 0) return;
  const { passwordHash, salt } = hashPassword(DEFAULT_ADMIN_PASS);
  data.admins.push({
    id: randomUUID(),
    username: DEFAULT_ADMIN_USER,
    passwordHash,
    salt,
    createdAt: Date.now(),
  });
  writeFile(data);
}

export function tryLogin(usernameRaw: unknown, passwordRaw: unknown): { token: string; username: string } | null {
  const username = normalizeUsername(usernameRaw);
  const password = String(passwordRaw ?? "");
  if (!username || password.length < 1) return null;
  ensureDefaultAdmins();
  const data = readFile();
  const admin = data.admins.find((a) => a.username === username);
  if (!admin || !verifyPassword(password, admin.passwordHash, admin.salt)) return null;
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

export function listAdminUsers(): AdminPublic[] {
  ensureDefaultAdmins();
  return readFile().admins
    .map((a) => ({ id: a.id, username: a.username, createdAt: a.createdAt }))
    .sort((a, b) => a.username.localeCompare(b.username, "zh-CN"));
}

export function changeAdminPassword(
  adminId: string,
  oldPassword: unknown,
  newPassword: unknown
): { ok: true } | { ok: false; error: string } {
  const oldP = String(oldPassword ?? "");
  const newP = String(newPassword ?? "");
  if (newP.length < 6) return { ok: false, error: "新密码至少 6 位" };
  if (newP.length > 128) return { ok: false, error: "新密码过长" };
  const data = readFile();
  const admin = data.admins.find((a) => a.id === adminId);
  if (!admin) return { ok: false, error: "用户不存在" };
  if (!verifyPassword(oldP, admin.passwordHash, admin.salt)) {
    return { ok: false, error: "原密码错误" };
  }
  const { passwordHash, salt } = hashPassword(newP);
  admin.passwordHash = passwordHash;
  admin.salt = salt;
  writeFile(data);
  return { ok: true };
}

export function createAdminUser(
  actorAdminId: string,
  usernameRaw: unknown,
  passwordRaw: unknown
): { ok: true } | { ok: false; error: string } {
  ensureDefaultAdmins();
  const username = normalizeUsername(usernameRaw);
  const password = String(passwordRaw ?? "");
  if (!username) return { ok: false, error: "用户名 1–32 位，支持字母数字中文._-" };
  if (password.length < 6) return { ok: false, error: "密码至少 6 位" };
  if (password.length > 128) return { ok: false, error: "密码过长" };
  const data = readFile();
  if (!data.admins.some((a) => a.id === actorAdminId)) {
    return { ok: false, error: "无权操作" };
  }
  if (data.admins.some((a) => a.username === username)) {
    return { ok: false, error: "用户名已存在" };
  }
  const { passwordHash, salt } = hashPassword(password);
  data.admins.push({
    id: randomUUID(),
    username,
    passwordHash,
    salt,
    createdAt: Date.now(),
  });
  writeFile(data);
  return { ok: true };
}
