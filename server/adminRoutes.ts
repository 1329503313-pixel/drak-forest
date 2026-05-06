import { Router, type Express, type NextFunction, type Request, type Response } from "express";
import {
  changeAdminPassword,
  createAdminUser,
  listAdminUsers,
  logoutSession,
  tryLogin,
  validateSession,
} from "./adminAuthStore.js";
import {
  deleteAccountById,
  deleteMatchById,
  getMatchByIdAdmin,
  listAllAccounts,
  listAllMatchesAdmin,
  listLeaderboard,
} from "./matchPersistence.js";

export type AdminLiveHandlers = {
  getRoomsSnapshot: () => unknown[];
  getGamesSnapshot: () => unknown[];
  getAdminGameState: (code: string) => unknown | null;
  dissolveRoomByCode: (code: string) => boolean;
  forceEndGame: (code: string) => boolean;
};

function readBearerToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const q = typeof req.query.token === "string" ? req.query.token.trim() : "";
  return q || undefined;
}

function adminSessionAuth(req: Request, res: Response, next: NextFunction): void {
  const token = readBearerToken(req);
  const session = validateSession(token);
  if (!session) {
    res.status(401).json({ error: "未登录或会话已过期" });
    return;
  }
  (req as Request & { adminSession: { adminId: string; username: string } }).adminSession = session;
  next();
}

export function mountAdminApi(app: Express, live: AdminLiveHandlers): void {
  const router = Router();

  router.get("/status", (_req, res) => {
    res.json({
      ok: true,
      auth: "account",
      hint: "使用管理员账号密码登录；首次无数据时自动创建 admin / 123456；数据存 MySQL",
    });
  });

  router.post("/login", async (req, res) => {
    const body = req.body as { username?: string; password?: string };
    const r = await tryLogin(body?.username, body?.password);
    if (!r) {
      res.status(401).json({ error: "用户名或密码错误" });
      return;
    }
    res.json(r);
  });

  router.post("/logout", adminSessionAuth, (req, res) => {
    const token = readBearerToken(req);
    logoutSession(token);
    res.json({ ok: true });
  });

  router.get("/me", adminSessionAuth, (req, res) => {
    const s = (req as Request & { adminSession: { adminId: string; username: string } }).adminSession;
    res.json({ username: s.username, id: s.adminId });
  });

  router.post("/change-password", adminSessionAuth, async (req, res) => {
    try {
      const s = (req as Request & { adminSession: { adminId: string; username: string } }).adminSession;
      const body = req.body as { oldPassword?: string; newPassword?: string };
      const r = await changeAdminPassword(s.adminId, body?.oldPassword, body?.newPassword);
      if (!r.ok) {
        res.status(400).json({ error: r.error });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      console.error("[admin] change-password", e);
      res.status(500).json({ error: e instanceof Error ? e.message : "服务器错误" });
    }
  });

  router.get("/admins", adminSessionAuth, async (_req, res) => {
    res.json({ admins: await listAdminUsers() });
  });

  router.post("/admins", adminSessionAuth, async (req, res) => {
    try {
      const s = (req as Request & { adminSession: { adminId: string; username: string } }).adminSession;
      const body = req.body as { username?: string; password?: string };
      const r = await createAdminUser(s.adminId, body?.username, body?.password);
      if (!r.ok) {
        res.status(400).json({ error: r.error });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      console.error("[admin] create admin", e);
      res.status(500).json({ error: e instanceof Error ? e.message : "服务器错误" });
    }
  });

  router.use(adminSessionAuth);

  router.get("/overview", async (_req, res) => {
    const roomList = live.getRoomsSnapshot();
    const gameList = live.getGamesSnapshot();
    const accounts = await listAllAccounts();
    const matches = await listAllMatchesAdmin();
    res.json({
      roomCount: roomList.length,
      activeGameCount: gameList.length,
      accountCount: accounts.length,
      finishedMatchCount: matches.length,
    });
  });

  router.get("/game-accounts", async (_req, res) => {
    res.json({ users: await listAllAccounts() });
  });

  router.delete("/game-accounts/:id", async (req, res) => {
    const ok = await deleteAccountById(decodeURIComponent(req.params.id));
    if (!ok) {
      res.status(404).json({ error: "账号不存在或格式无效" });
      return;
    }
    res.json({ ok: true });
  });

  router.get("/rooms", (_req, res) => {
    res.json({ rooms: live.getRoomsSnapshot() });
  });

  router.post("/rooms/:code/dissolve", (req, res) => {
    const code = String(req.params.code ?? "").replace(/\D/g, "").slice(0, 4);
    if (code.length !== 4) {
      res.status(400).json({ error: "无效房间号" });
      return;
    }
    const ok = live.dissolveRoomByCode(code);
    if (!ok) {
      res.status(404).json({ error: "房间不存在" });
      return;
    }
    res.json({ ok: true });
  });

  router.get("/games", (_req, res) => {
    res.json({ games: live.getGamesSnapshot() });
  });

  router.get("/games/:code/state", (req, res) => {
    const code = String(req.params.code ?? "").replace(/\D/g, "").slice(0, 4);
    if (code.length !== 4) {
      res.status(400).json({ error: "无效房间号" });
      return;
    }
    const state = live.getAdminGameState(code);
    if (!state) {
      res.status(404).json({ error: "无进行中的对局" });
      return;
    }
    res.json(state);
  });

  router.post("/games/:code/force-end", (req, res) => {
    const code = String(req.params.code ?? "").replace(/\D/g, "").slice(0, 4);
    if (code.length !== 4) {
      res.status(400).json({ error: "无效房间号" });
      return;
    }
    const ok = live.forceEndGame(code);
    if (!ok) {
      res.status(400).json({ error: "无进行中的对局" });
      return;
    }
    res.json({ ok: true });
  });

  router.get("/matches", async (_req, res) => {
    res.json({ matches: await listAllMatchesAdmin() });
  });

  router.get("/matches/:matchId", async (req, res) => {
    const m = await getMatchByIdAdmin(req.params.matchId);
    if (!m) {
      res.status(404).json({ error: "对局不存在" });
      return;
    }
    res.json(m);
  });

  router.delete("/matches/:matchId", async (req, res) => {
    const ok = await deleteMatchById(req.params.matchId);
    if (!ok) {
      res.status(404).json({ error: "对局不存在" });
      return;
    }
    res.json({ ok: true });
  });

  router.get("/leaderboard", async (_req, res) => {
    res.json({ leaderboard: await listLeaderboard() });
  });

  app.use("/api/admin", router);
}
