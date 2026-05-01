import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  applyGameAction,
  appendReplayLog,
  buildGamePayload,
  chooseBotAction,
  createGameFromRoom,
  currentPlayerId,
  eliminatePlayerFromGame,
  isBotSocketId,
  rebindPlayerSocket,
  runPendingBeastTurn,
  timeoutCurrentTurn,
  type GameAction,
  type BotDifficulty,
} from "./game/engine.js";
import type { GameSession } from "./game/gameTypes.js";
import {
  getAccount,
  listLeaderboard,
  listMatchesForAccount,
  getMatchDetailForAccount,
  normalizeGameAccountId,
  recordFinishedMatchIfNeeded,
  upsertAccount,
} from "./matchPersistence.js";
import { mapSizeLabel, normalizeGridSize, type AllowedGridSize } from "./mapConfig.js";
import { matchModeConfig, normalizeMatchMode, type MatchMode } from "./matchModes.js";
import { botAvatarDataUrl } from "./botAvatar.js";

const MIN_PLAYERS_TO_START = 2;
/** 大厅观战席固定数量 */
const SPECTATOR_BENCH_SLOTS = 4;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "../dist");

type PlayerPublic = {
  socketId: string;
  gameAccountId: string;
  nickname: string;
  avatar: string;
  slotIndex: number;
};

type SpectatorEntry = {
  nickname: string;
  avatar: string;
  watching: boolean;
  gameAccountId: string;
  /** 大厅观战席索引 0..SPECTATOR_BENCH_SLOTS-1；未分配时表示等待填入空席 */
  spectatorSlot?: number;
};

type SpectatorPublic = {
  socketId: string;
  gameAccountId: string;
  nickname: string;
  avatar: string;
};

type Room = {
  code: string;
  players: Map<string, PlayerPublic>;
  hostId: string;
  /** 开局使用的地图边长（未开局时房主可改） */
  gridSize: AllowedGridSize;
  matchMode: MatchMode;
  /** 电脑玩家 socketId -> 难度 */
  botDifficulties?: Map<string, BotDifficulty>;
  /** 中途加入的观战者（含未点「观战」的等待者） */
  spectators?: Map<string, SpectatorEntry>;
};

const rooms = new Map<string, Room>();
const games = new Map<string, GameSession>();

function roomAvatarMap(room: Room): Map<string, string> {
  const m = new Map<string, string>();
  for (const [id, p] of room.players) m.set(id, p.avatar);
  return m;
}

function watchingSpectatorCount(room: Room): number {
  if (!room.spectators) return 0;
  let n = 0;
  for (const sp of room.spectators.values()) {
    if (sp.watching) n++;
  }
  return n;
}

function broadcastGameState(roomCode: string) {
  const g = games.get(roomCode);
  if (!g) return;
  recordFinishedMatchIfNeeded(g);
  const room = rooms.get(roomCode);
  if (!room) return;
  const av = roomAvatarMap(room);
  const ws = watchingSpectatorCount(room);
  const baseOpts = { roomAvatarBySocket: av, watchingSpectatorCount: ws };
  for (const sid of room.players.keys()) {
    if (isBotSocketId(sid)) continue;
    if (g.retiredToLobby?.has(sid)) continue;
    if (!g.players.has(sid)) {
      io.to(sid).emit("game:invalid", { message: "你已不在当前对局中，已返回房间" });
      io.to(sid).emit("room:state", roomPayload(room));
      continue;
    }
    io.to(sid).emit("game:state", buildGamePayload(g, sid, baseOpts));
  }
  if (room.spectators) {
    for (const [sid, sp] of room.spectators) {
      if (sp.watching) {
        io.to(sid).emit(
          "game:state",
          buildGamePayload(g, sid, { ...baseOpts, spectatorMode: true })
        );
      }
    }
  }
  if (g.phase === "ended") {
    clearTurnTimer(roomCode);
    games.delete(roomCode);
    if (room.spectators) {
      for (const sp of room.spectators.values()) {
        sp.watching = false;
      }
    }
    broadcastRoom(room);
  }
}

/** 随机指定一名人类对战席玩家为房主（不含电脑）；若无人类则返回 null */
function pickRandomHumanHost(room: Room, exclude?: string): string | null {
  const humans = [...room.players.keys()].filter((id) => id !== exclude && !isBotSocketId(id));
  if (humans.length === 0) return null;
  return humans[Math.floor(Math.random() * humans.length)]!;
}

/** 房间内已无真人可接任房主：解散并通知所有仍在连接的人类客户端 */
function dissolveRoom(room: Room): void {
  const code = room.code;
  clearTurnTimer(code);
  games.delete(code);

  const humanIds: string[] = [];
  for (const sid of room.players.keys()) {
    if (!isBotSocketId(sid)) humanIds.push(sid);
  }
  if (room.spectators) {
    for (const sid of room.spectators.keys()) {
      humanIds.push(sid);
    }
  }

  rooms.delete(code);

  const message = "房间内仅剩电脑，无人可接任房主，房间已解散";
  for (const sid of humanIds) {
    io.to(sid).emit("room:dissolved", { message });
    io.to(sid).emit("room:left");
    socketRoom.delete(sid);
    io.sockets.sockets.get(sid)?.leave(code);
  }
}

function broadcastRoom(room: Room) {
  const payload = roomPayload(room);
  for (const sid of room.players.keys()) {
    if (isBotSocketId(sid)) continue;
    io.to(sid).emit("room:state", payload);
  }
  if (room.spectators) {
    for (const sid of room.spectators.keys()) {
      io.to(sid).emit("room:state", payload);
    }
  }
}

function spectatorSlotsPayload(room: Room): (SpectatorPublic | null)[] {
  const slots: (SpectatorPublic | null)[] = Array.from({ length: SPECTATOR_BENCH_SLOTS }, () => null);
  if (!room.spectators) return slots;
  for (const [sid, sp] of room.spectators) {
    if (
      typeof sp.spectatorSlot === "number" &&
      sp.spectatorSlot >= 0 &&
      sp.spectatorSlot < SPECTATOR_BENCH_SLOTS
    ) {
      slots[sp.spectatorSlot] = {
        socketId: sid,
        gameAccountId: sp.gameAccountId,
        nickname: sp.nickname,
        avatar: sp.avatar,
      };
    }
  }
  return slots;
}

function roomPayload(room: Room) {
  ensureSpectatorSlots(room);
  const cfg = matchModeConfig(room.matchMode);
  return {
    code: room.code,
    hostId: room.hostId,
    maxSlots: cfg.maxSlots,
    matchMode: cfg.mode,
    matchModeLabel: cfg.label,
    teamSize: cfg.teamSize,
    rowSize: cfg.rowSize,
    players: [...room.players.values()].map((p) => ({
      socketId: p.socketId,
      gameAccountId: p.gameAccountId,
      nickname: p.nickname,
      avatar: p.avatar,
      slotIndex: p.slotIndex,
      isBot: isBotSocketId(p.socketId),
      botDifficulty: isBotSocketId(p.socketId)
        ? room.botDifficulties?.get(p.socketId)
        : undefined,
    })),
    spectatorSlots: spectatorSlotsPayload(room),
    gameInProgress: games.has(room.code),
    gridSize: room.gridSize,
    mapSizeLabel: mapSizeLabel(room.gridSize),
  };
}

function removePlayerFromRoom(socketId: string, room: Room): Room | null {
  const wasHost = room.hostId === socketId;
  room.players.delete(socketId);
  room.botDifficulties?.delete(socketId);
  if (room.players.size === 0 && (room.spectators?.size ?? 0) === 0 && !games.has(room.code)) {
    rooms.delete(room.code);
    return null;
  }
  if (wasHost) {
    const nextHuman = pickRandomHumanHost(room);
    if (nextHuman) {
      room.hostId = nextHuman;
    } else if ([...room.players.keys()].every(isBotSocketId)) {
      dissolveRoom(room);
      return null;
    }
  }
  return room;
}

function firstFreeSlot(room: Room): number {
  const cfg = matchModeConfig(room.matchMode);
  const used = new Set([...room.players.values()].map((p) => p.slotIndex));
  for (let i = 0; i < cfg.maxSlots; i++) {
    if (!used.has(i)) return i;
  }
  return -1;
}

function validateRoomCanStart(room: Room): string | null {
  const cfg = matchModeConfig(room.matchMode);
  if (room.players.size < MIN_PLAYERS_TO_START) {
    return `对战席至少需要${MIN_PLAYERS_TO_START}名玩家才能开始`;
  }
  if (cfg.mode === "solo") return null;

  const teamCounts = new Map<number, number>();
  for (const p of room.players.values()) {
    const teamId = Math.floor(p.slotIndex / cfg.teamSize);
    teamCounts.set(teamId, (teamCounts.get(teamId) ?? 0) + 1);
  }
  if (teamCounts.size < 2) return "组队模式至少需要两支队伍才能开始";
  for (const count of teamCounts.values()) {
    if (count !== cfg.teamSize) return "组队模式中，每支已入座队伍必须坐满才能开始";
  }
  return null;
}

function firstFreeSpectatorSlot(room: Room): number {
  const used = new Set<number>();
  if (room.spectators) {
    for (const sp of room.spectators.values()) {
      if (typeof sp.spectatorSlot === "number" && sp.spectatorSlot >= 0 && sp.spectatorSlot < SPECTATOR_BENCH_SLOTS) {
        used.add(sp.spectatorSlot);
      }
    }
  }
  for (let i = 0; i < SPECTATOR_BENCH_SLOTS; i++) {
    if (!used.has(i)) return i;
  }
  return -1;
}

/** 为尚无观战席索引的观战者分配空席（仅非对局进行中时） */
function ensureSpectatorSlots(room: Room): void {
  if (games.has(room.code) || !room.spectators) return;
  for (let i = 0; i < SPECTATOR_BENCH_SLOTS; i++) {
    for (const sp of room.spectators.values()) {
      if (typeof sp.spectatorSlot === "number" && sp.spectatorSlot >= 0) continue;
      const free = firstFreeSpectatorSlot(room);
      if (free >= 0) sp.spectatorSlot = free;
    }
  }
}

/** 玩家离开对战席进入观战席某格（目标格须为空） */
function moveBattlePlayerToEmptyBench(room: Room, pid: string, benchSlot: number): string | null {
  const me = room.players.get(pid);
  if (!me) return "未在座";
  const taken = [...(room.spectators?.values() ?? [])].some(
    (sp) => sp.spectatorSlot === benchSlot
  );
  if (taken) return "该观战席已被占用";
  if (!room.spectators) room.spectators = new Map();
  room.players.delete(pid);
  room.spectators.set(pid, {
    nickname: me.nickname,
    avatar: me.avatar,
    watching: false,
    gameAccountId: me.gameAccountId,
    spectatorSlot: benchSlot,
  });
  return null;
}

/** 对战席玩家与某一观战席上的观战者互换位置 */
function swapBattlePlayerWithBenchSpectator(room: Room, pid: string, benchSlot: number): string | null {
  const me = room.players.get(pid);
  if (!me) return "未在座";
  const occEntry = [...(room.spectators?.entries() ?? [])].find(([, sp]) => sp.spectatorSlot === benchSlot);
  if (!occEntry) return "该观战席为空";
  const [occSid, occSp] = occEntry;
  room.players.delete(pid);
  room.spectators!.delete(occSid);
  room.players.set(occSid, {
    socketId: occSid,
    gameAccountId: occSp.gameAccountId,
    nickname: occSp.nickname,
    avatar: occSp.avatar,
    slotIndex: me.slotIndex,
  });
  room.spectators!.set(pid, {
    nickname: me.nickname,
    avatar: me.avatar,
    gameAccountId: me.gameAccountId,
    watching: false,
    spectatorSlot: benchSlot,
  });
  return null;
}

function spectatorMovesToEmptyBenchSlot(room: Room, sid: string, benchSlot: number): string | null {
  const sp = room.spectators?.get(sid);
  if (!sp) return "未在观战席";
  const takenByOther = [...(room.spectators?.entries() ?? [])].some(
    ([otherSid, o]) => otherSid !== sid && o.spectatorSlot === benchSlot
  );
  if (takenByOther) return "该观战席已被占用";
  sp.spectatorSlot = benchSlot;
  return null;
}

function swapSpectatorsOnBench(room: Room, sid: string, benchSlot: number): string | null {
  const me = room.spectators?.get(sid);
  if (!me || typeof me.spectatorSlot !== "number") return "未在观战席";
  const occEntry = [...room.spectators!.entries()].find(
    ([other, sp]) => other !== sid && sp.spectatorSlot === benchSlot
  );
  if (!occEntry) return spectatorMovesToEmptyBenchSlot(room, sid, benchSlot);
  const [occSid, occSp] = occEntry;
  const a = me.spectatorSlot;
  me.spectatorSlot = benchSlot;
  occSp.spectatorSlot = a;
  return null;
}

function spectatorTakesBattleSlot(
  room: Room,
  sid: string,
  targetBattleSlot: number,
  cb: (err: string | null) => void
): void {
  const sp = room.spectators?.get(sid);
  if (!sp) {
    cb("不在观战席");
    return;
  }
  if (typeof sp.spectatorSlot !== "number") {
    cb("观战席未就绪");
    return;
  }
  const cfg = matchModeConfig(room.matchMode);
  if (!Number.isFinite(targetBattleSlot) || targetBattleSlot < 0 || targetBattleSlot >= cfg.maxSlots) {
    cb("席位无效");
    return;
  }
  const gameAccountId = sp.gameAccountId;
  const nickname = sp.nickname;
  const avatar = sp.avatar;
  const specSlot = sp.spectatorSlot;
  const occupant = [...room.players.values()].find((p) => p.slotIndex === targetBattleSlot);
  if (occupant && occupant.socketId === room.hostId && sid !== room.hostId) {
    cb("无法与房主换位");
    return;
  }
  if (!occupant) {
    room.spectators!.delete(sid);
    room.players.set(sid, {
      socketId: sid,
      gameAccountId,
      nickname,
      avatar,
      slotIndex: targetBattleSlot,
    });
    cb(null);
    return;
  }
  room.spectators!.delete(sid);
  room.players.delete(occupant.socketId);
  room.players.set(sid, {
    socketId: sid,
    gameAccountId,
    nickname,
    avatar,
    slotIndex: targetBattleSlot,
  });
  room.spectators!.set(occupant.socketId, {
    nickname: occupant.nickname,
    avatar: occupant.avatar,
    watching: false,
    gameAccountId: occupant.gameAccountId,
    spectatorSlot: specSlot,
  });
  cb(null);
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));

app.post("/api/account/register", (req, res) => {
  const body = req.body as { gameAccountId?: string; nickname?: string; avatar?: string };
  const r = upsertAccount(
    String(body?.gameAccountId ?? ""),
    String(body?.nickname ?? ""),
    typeof body?.avatar === "string" ? body.avatar : ""
  );
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json({ ok: true });
});

app.get("/api/account/:id", (req, res) => {
  const id = normalizeGameAccountId(decodeURIComponent(req.params.id));
  if (!id) {
    res.status(400).json({ error: "无效账号" });
    return;
  }
  const row = getAccount(id);
  if (!row) {
    res.status(404).json({ error: "账号不存在" });
    return;
  }
  res.json({ gameAccountId: id, nickname: row.nickname, avatar: row.avatar, updatedAt: row.updatedAt });
});

app.get("/api/matches", (req, res) => {
  const account = normalizeGameAccountId(String(req.query.account ?? ""));
  if (!account) {
    res.status(400).json({ error: "缺少或无效的 account 参数" });
    return;
  }
  res.json({ matches: listMatchesForAccount(account) });
});

app.get("/api/leaderboard", (_req, res) => {
  res.json({ leaderboard: listLeaderboard() });
});

app.get("/api/match/:matchId", (req, res) => {
  const account = normalizeGameAccountId(String(req.query.account ?? ""));
  if (!account) {
    res.status(400).json({ error: "缺少或无效的 account 参数" });
    return;
  }
  const detail = getMatchDetailForAccount(req.params.matchId, account);
  if (!detail) {
    res.status(404).json({ error: "未找到对局或无权查看" });
    return;
  }
  res.json(detail);
});

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true },
});

const socketRoom = new Map<string, string>();
const turnTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearTurnTimer(roomCode: string): void {
  const t = turnTimers.get(roomCode);
  if (t) clearTimeout(t);
  turnTimers.delete(roomCode);
}

function runBeastIfPending(roomCode: string): void {
  const g = games.get(roomCode);
  if (!g?.beastTurnPending) return;
  setTimeout(() => {
    const current = games.get(roomCode);
    if (!current?.beastTurnPending) return;
    const beastMove = runPendingBeastTurn(current);
    if (beastMove) {
      io.to(roomCode).emit("game:beastMove", beastMove);
    }
    broadcastGameState(roomCode);
    scheduleTurnTimer(roomCode);
  }, 900);
}

function executeBotTurn(roomCode: string): void {
  const g = games.get(roomCode);
  const room = rooms.get(roomCode);
  if (!g || !room || g.phase !== "playing" || g.beastTurnPending) return;
  const id = currentPlayerId(g);
  if (!isBotSocketId(id)) return;
  const diff = g.players.get(id)?.botDifficulty ?? room.botDifficulties?.get(id) ?? "medium";
  let guard = 0;
  while (guard++ < 50) {
    if (g.phase !== "playing") break;
    if (currentPlayerId(g) !== id) break;
    const pl = g.players.get(id);
    if (!pl || pl.hp <= 0) break;
    let action: GameAction;
    try {
      action = chooseBotAction(g, id, diff);
    } catch {
      action = { kind: "endTurn" };
    }
    const res = applyGameAction(g, id, action);
    if (!res.ok) {
      applyGameAction(g, id, { kind: "endTurn" });
      break;
    }
    if (action.kind === "endTurn" || action.kind === "rest") break;
  }
  broadcastGameState(roomCode);
  const g2 = games.get(roomCode);
  if (!g2 || g2.phase !== "playing") return;
  if (g2.beastTurnPending) runBeastIfPending(roomCode);
  else scheduleTurnTimer(roomCode);
}

function scheduleTurnTimer(roomCode: string): void {
  clearTurnTimer(roomCode);
  const g = games.get(roomCode);
  if (!g || g.phase !== "playing" || g.beastTurnPending || !g.turnDeadlineAt) return;
  const actorId = currentPlayerId(g);
  if (isBotSocketId(actorId)) {
    turnTimers.set(
      roomCode,
      setTimeout(() => {
        executeBotTurn(roomCode);
      }, 400)
    );
    return;
  }
  const seq = g.turnTimerSeq;
  const delay = Math.max(0, g.turnDeadlineAt - Date.now());
  turnTimers.set(
    roomCode,
    setTimeout(() => {
      const current = games.get(roomCode);
      if (!current) return;
      const timedOut = timeoutCurrentTurn(current, seq);
      if (!timedOut.ok) return;
      broadcastGameState(roomCode);
      if (current.beastTurnPending) runBeastIfPending(roomCode);
      else scheduleTurnTimer(roomCode);
    }, delay)
  );
}

io.on("connection", (socket) => {
  socket.on(
    "room:create",
    (
      data: { nickname: string; avatar: string; gameAccountId: string; gridSize?: number; code?: string; matchMode?: string },
      cb: (err: string | null, state?: ReturnType<typeof roomPayload>) => void
    ) => {
      const gid = normalizeGameAccountId(data?.gameAccountId ?? "");
      if (!gid) {
        cb("请先登录游戏账号");
        return;
      }
      if (!getAccount(gid)) {
        cb("游戏账号无效，请先在首页完成账号登记");
        return;
      }
      const nickname = String(data?.nickname ?? "").trim() || "猎人";
      const avatar = typeof data?.avatar === "string" ? data.avatar : "";
      const gridSize: AllowedGridSize = normalizeGridSize(data?.gridSize) ?? 15;
      const matchMode = normalizeMatchMode(data?.matchMode);
      const code = String(data?.code ?? "").replace(/\D/g, "").slice(0, 4);
      if (code.length !== 4) {
        cb("请输入4位房间号");
        return;
      }
      if (rooms.has(code)) {
        cb("该房间号已被占用，创建失败，请更换号码或加入已有房间");
        return;
      }
      const player: PlayerPublic = {
        socketId: socket.id,
        gameAccountId: gid,
        nickname,
        avatar,
        slotIndex: 0,
      };
      const room: Room = {
        code,
        players: new Map([[socket.id, player]]),
        hostId: socket.id,
        gridSize,
        matchMode,
      };
      rooms.set(code, room);
      socket.join(code);
      socketRoom.set(socket.id, code);
      cb(null, roomPayload(room));
    }
  );

  socket.on(
    "room:join",
    (
      data: { code: string; nickname: string; avatar: string; gameAccountId: string },
      cb: (err: string | null, state?: ReturnType<typeof roomPayload>) => void
    ) => {
      const gid = normalizeGameAccountId(data?.gameAccountId ?? "");
      if (!gid) {
        cb("请先登录游戏账号");
        return;
      }
      if (!getAccount(gid)) {
        cb("游戏账号无效，请先在首页完成账号登记");
        return;
      }
      const raw = String(data?.code ?? "").replace(/\D/g, "").slice(0, 4);
      if (raw.length !== 4) {
        cb("请输入4位房间号");
        return;
      }
      const room = rooms.get(raw);
      if (!room) {
        cb("房间不存在或已关闭");
        return;
      }
      if (games.has(raw)) {
        const nickname = String(data?.nickname ?? "").trim() || "猎人";
        const avatar = typeof data?.avatar === "string" ? data.avatar : "";
        if (!room.spectators) room.spectators = new Map();
        const specSeat = firstFreeSpectatorSlot(room);
        room.spectators.set(socket.id, {
          nickname,
          avatar,
          watching: false,
          gameAccountId: gid,
          spectatorSlot: specSeat >= 0 ? specSeat : undefined,
        });
        socket.join(raw);
        socketRoom.set(socket.id, raw);
        broadcastRoom(room);
        cb(null, { ...roomPayload(room), waitingToSpectate: true } as ReturnType<typeof roomPayload> & {
          waitingToSpectate: boolean;
        });
        return;
      }
      const free = firstFreeSlot(room);
      if (free < 0) {
        cb("房间已满");
        return;
      }
      const nickname = String(data?.nickname ?? "").trim() || "猎人";
      const avatar = typeof data?.avatar === "string" ? data.avatar : "";
      const player: PlayerPublic = {
        socketId: socket.id,
        gameAccountId: gid,
        nickname,
        avatar,
        slotIndex: free,
      };
      room.players.set(socket.id, player);
      socket.join(raw);
      socketRoom.set(socket.id, raw);
      broadcastRoom(room);
      cb(null, roomPayload(room));
    }
  );

  socket.on("room:leave", () => {
    const code = socketRoom.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (room?.spectators?.has(socket.id)) {
      room.spectators!.delete(socket.id);
      socket.leave(code);
      socketRoom.delete(socket.id);
      socket.emit("room:left");
      broadcastRoom(room);
      return;
    }
    const g = games.get(code);
    if (g) {
      const left = eliminatePlayerFromGame(g, socket.id, { deathCause: "退出游戏" });
      if (left) io.to(code).emit("game:playerLeft", { nickname: left.nickname });
      broadcastGameState(code);
    }
    if (!room) {
      socketRoom.delete(socket.id);
      return;
    }
    const updated = removePlayerFromRoom(socket.id, room);
    socket.leave(code);
    socketRoom.delete(socket.id);
    socket.emit("room:left");
    if (updated) broadcastRoom(updated);
  });

  socket.on(
    "spectate:enter",
    (cb?: (err: string | null) => void) => {
      const code = socketRoom.get(socket.id);
      const room = code ? rooms.get(code) : undefined;
      const sp = room?.spectators?.get(socket.id);
      if (!code || !room || !sp) {
        cb?.("无法观战");
        return;
      }
      sp.watching = true;
      broadcastGameState(code);
      cb?.(null);
    }
  );

  socket.on(
    "game:activeForAccount",
    (data: { gameAccountId?: string }, cb?: (err: string | null, payload?: { roomCode: string; resumeToken: string }) => void) => {
      const gid = normalizeGameAccountId(data?.gameAccountId ?? "");
      if (!gid) {
        cb?.("请先登录游戏账号");
        return;
      }
      for (const [roomCode, g] of games) {
        if (g.phase !== "playing") continue;
        const player = [...g.players.values()].find((p) => p.gameAccountId === gid && p.hp > 0);
        if (player) {
          cb?.(null, { roomCode, resumeToken: player.resumeToken });
          return;
        }
      }
      cb?.(null);
    }
  );

  socket.on(
    "game:resume",
    (
      data: { roomCode: string; resumeToken: string },
      cb?: (err: string | null) => void
    ) => {
      const code = String(data?.roomCode ?? "").replace(/\D/g, "").slice(0, 4);
      const token = String(data?.resumeToken ?? "");
      if (code.length !== 4 || !token) {
        cb?.("参数无效");
        return;
      }
      const g = games.get(code);
      const room = rooms.get(code);
      if (!g || g.phase !== "playing" || !room) {
        cb?.("对局不存在或已结束");
        return;
      }
      const pl = [...g.players.values()].find((p) => p.resumeToken === token);
      if (!pl || pl.hp <= 0) {
        cb?.("无效或已失效的重连凭证");
        return;
      }
      const oldSid = pl.socketId;
      if (oldSid !== socket.id) {
        io.to(oldSid).emit("game:invalid", { message: "该账号已在新的连接重新加入游戏" });
        io.sockets.sockets.get(oldSid)?.leave(code);
        socketRoom.delete(oldSid);
      }
      rebindPlayerSocket(g, oldSid, socket.id);
      room.players.delete(oldSid);
      room.players.set(socket.id, {
        socketId: socket.id,
        gameAccountId: pl.gameAccountId,
        nickname: pl.nickname,
        avatar: pl.avatar,
        slotIndex: pl.slotIndex,
      });
      socket.join(code);
      socketRoom.set(socket.id, code);
      appendReplayLog(g, pl.socketId, `玩家「${pl.nickname}」已重连`);
      broadcastGameState(code);
      broadcastRoom(room);
      cb?.(null);
    }
  );

  socket.on(
    "room:syncProfile",
    (data: { nickname?: string; avatar?: string }, cb?: (err: string | null) => void) => {
      const code = socketRoom.get(socket.id);
      if (!code) {
        cb?.("不在房间内");
        return;
      }
      const room = rooms.get(code);
      if (!room) {
        cb?.("房间不存在");
        return;
      }
      const rp = room.players.get(socket.id);
      if (rp) {
        if (typeof data?.nickname === "string" && data.nickname.trim()) {
          rp.nickname = data.nickname.trim().slice(0, 16);
        }
        if (typeof data?.avatar === "string") rp.avatar = data.avatar;
      }
      const g = games.get(code);
      const gp = g?.players.get(socket.id);
      if (gp) {
        if (typeof data?.nickname === "string" && data.nickname.trim()) {
          gp.nickname = data.nickname.trim().slice(0, 16);
        }
        if (typeof data?.avatar === "string") gp.avatar = data.avatar;
      }
      const sp = room.spectators?.get(socket.id);
      if (sp) {
        if (typeof data?.nickname === "string" && data.nickname.trim()) {
          sp.nickname = data.nickname.trim().slice(0, 16);
        }
        if (typeof data?.avatar === "string") sp.avatar = data.avatar;
      }
      broadcastRoom(room);
      if (g) broadcastGameState(code);
      cb?.(null);
    }
  );

  /** 点击对战席：空席入座；已被占用则与占用者换位。观战席上的人点此席入座对战席 */
  socket.on("room:setSlot", (slot: unknown, cb?: (err: string | null) => void) => {
    const code = socketRoom.get(socket.id);
    if (!code) {
      cb?.("不在房间内");
      return;
    }
    const room = rooms.get(code);
    if (!room) return;
    if (games.has(code)) {
      cb?.("游戏进行中无法换位");
      return;
    }
    if (room.spectators?.has(socket.id)) {
      const targetSlot = Math.floor(Number(slot));
      spectatorTakesBattleSlot(room, socket.id, targetSlot, (err) => {
        if (err) {
          cb?.(err);
          return;
        }
        broadcastRoom(room);
        cb?.(null);
      });
      return;
    }
    const me = room.players.get(socket.id);
    if (!me) {
      cb?.("未在座");
      return;
    }
    const targetSlot = Math.floor(Number(slot));
    if (!Number.isFinite(targetSlot) || targetSlot < 0 || targetSlot >= matchModeConfig(room.matchMode).maxSlots) {
      cb?.("席位无效");
      return;
    }

    const occupant = [...room.players.values()].find((p) => p.slotIndex === targetSlot);
    if (!occupant) {
      me.slotIndex = targetSlot;
      broadcastRoom(room);
      cb?.(null);
      return;
    }
    if (occupant.socketId === socket.id) {
      cb?.(null);
      return;
    }
    if (occupant.socketId === room.hostId && socket.id !== room.hostId) {
      cb?.("无法与房主换位");
      return;
    }
    const tmp = me.slotIndex;
    me.slotIndex = occupant.slotIndex;
    occupant.slotIndex = tmp;
    broadcastRoom(room);
    cb?.(null);
  });

  /** 点击观战席：对战席玩家入座或互换；观战者换位 */
  socket.on("room:setSpectatorSlot", (raw: unknown, cb?: (err: string | null) => void) => {
    const code = socketRoom.get(socket.id);
    if (!code) {
      cb?.("不在房间内");
      return;
    }
    const room = rooms.get(code);
    if (!room) return;
    if (games.has(code)) {
      cb?.("游戏进行中无法换位");
      return;
    }
    const targetSlot = Math.floor(Number(raw));
    if (!Number.isFinite(targetSlot) || targetSlot < 0 || targetSlot >= SPECTATOR_BENCH_SLOTS) {
      cb?.("观战席无效");
      return;
    }

    const mePl = room.players.get(socket.id);
    if (mePl) {
      const occ = [...(room.spectators?.entries() ?? [])].find(([, s]) => s.spectatorSlot === targetSlot);
      if (!occ) {
        if (firstFreeSpectatorSlot(room) < 0) {
          cb?.("观战席已满");
          return;
        }
        const err = moveBattlePlayerToEmptyBench(room, socket.id, targetSlot);
        if (err) {
          cb?.(err);
          return;
        }
      } else {
        const err = swapBattlePlayerWithBenchSpectator(room, socket.id, targetSlot);
        if (err) {
          cb?.(err);
          return;
        }
      }
      broadcastRoom(room);
      cb?.(null);
      return;
    }

    const meSp = room.spectators?.get(socket.id);
    if (meSp) {
      if (typeof meSp.spectatorSlot !== "number") {
        cb?.("观战席未就绪");
        return;
      }
      const err = swapSpectatorsOnBench(room, socket.id, targetSlot);
      if (err) {
        cb?.(err);
        return;
      }
      broadcastRoom(room);
      cb?.(null);
      return;
    }

    cb?.("未在房间内");
  });

  socket.on("room:setGridSize", (raw: unknown, cb?: (err: string | null) => void) => {
    const code = socketRoom.get(socket.id);
    const room = code ? rooms.get(code) : undefined;
    if (!code || !room || room.hostId !== socket.id) {
      cb?.("仅房主可修改地图尺寸");
      return;
    }
    if (games.has(code)) {
      cb?.("游戏进行中无法修改");
      return;
    }
    const gs = normalizeGridSize(raw);
    if (gs == null) {
      cb?.("请选择有效的地图尺寸");
      return;
    }
    room.gridSize = gs;
    broadcastRoom(room);
    cb?.(null);
  });

  socket.on("room:setMatchMode", (raw: unknown, cb?: (err: string | null) => void) => {
    const code = socketRoom.get(socket.id);
    const room = code ? rooms.get(code) : undefined;
    if (!code || !room || room.hostId !== socket.id) {
      cb?.("仅房主可修改对局类型");
      return;
    }
    if (games.has(code)) {
      cb?.("游戏进行中无法修改");
      return;
    }
    const next = normalizeMatchMode(raw);
    const cfg = matchModeConfig(next);
    if ([...room.players.values()].some((p) => p.slotIndex >= cfg.maxSlots)) {
      cb?.(`当前有玩家坐在超出${cfg.label}上限的位置，请先调整席位`);
      return;
    }
    room.matchMode = next;
    broadcastRoom(room);
    cb?.(null);
  });

  socket.on("game:retireToLobby", (cb?: (err: string | null) => void) => {
    const code = socketRoom.get(socket.id);
    const g = code ? games.get(code) : undefined;
    const room = code ? rooms.get(code) : undefined;
    if (!code || !g || !room) {
      cb?.("不在对局中");
      return;
    }
    const pl = g.players.get(socket.id);
    if (!pl) {
      cb?.(null);
      return;
    }
    if (!g.retiredToLobby) g.retiredToLobby = new Set();
    if (g.phase === "playing" && pl.hp > 0 && g.turnOrder.includes(socket.id)) {
      const left = eliminatePlayerFromGame(g, socket.id, { deathCause: "退出游戏" });
      if (left) io.to(code).emit("game:playerLeft", { nickname: left.nickname });
    }
    g.retiredToLobby.add(socket.id);
    broadcastGameState(code);
    socket.emit("game:leftToRoom", { roomCode: code });
    socket.emit("room:state", roomPayload(room));
    cb?.(null);
  });

  socket.on("room:start", (cb?: (err: string | null) => void) => {
    const code = socketRoom.get(socket.id);
    if (!code) {
      cb?.("不在房间内");
      return;
    }
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) {
      cb?.("仅房主可开始");
      return;
    }
    const startError = validateRoomCanStart(room);
    if (startError) {
      cb?.(startError);
      return;
    }
    if (games.has(code)) {
      cb?.("游戏已开始");
      return;
    }
    const lite = new Map(
      [...room.players.values()].map((p) => [
        p.socketId,
        {
          socketId: p.socketId,
          gameAccountId: p.gameAccountId,
          nickname: p.nickname,
          avatar: p.avatar,
          slotIndex: p.slotIndex,
          botDifficulty: room.botDifficulties?.get(p.socketId),
        },
      ])
    );
    const created = createGameFromRoom(code, lite, room.gridSize, room.matchMode);
    if (!created) {
      cb?.("开局失败，请重试");
      return;
    }
    games.set(code, created.session);
    if (room.spectators) {
      for (const sp of room.spectators.values()) {
        sp.watching = true;
      }
    }
    io.to(code).emit("game:begin", {
      gridSize: created.session.gridSize,
      spawnSlots: created.spawnBySocket,
      slotAssignments: created.session.slotAssignments,
    });
    broadcastGameState(code);
    scheduleTurnTimer(code);
    cb?.(null);
  });

  socket.on("game:action", (action: GameAction, cb?: (err: string | null, data?: unknown) => void) => {
    const code = socketRoom.get(socket.id);
    if (!code) {
      cb?.("不在房间内");
      return;
    }
    const g = games.get(code);
    if (!g) {
      const room = rooms.get(code);
      socket.emit("game:invalid", { message: "游戏未开始或已结束，已返回房间" });
      if (room) socket.emit("room:state", roomPayload(room));
      cb?.("游戏未开始");
      return;
    }
    if (g.retiredToLobby?.has(socket.id)) {
      const room = rooms.get(code);
      socket.emit("game:invalid", { message: "你已返回房间" });
      if (room) socket.emit("room:state", roomPayload(room));
      cb?.("你已返回房间");
      return;
    }
    if (!g.players.has(socket.id)) {
      const room = rooms.get(code);
      socket.emit("game:invalid", { message: "你已不在当前对局中，已返回房间" });
      if (room) socket.emit("room:state", roomPayload(room));
      cb?.("你已不在当前对局中");
      return;
    }
    const movingPlayer = action.kind === "move" ? g.players.get(socket.id) : undefined;
    const moveEvent =
      action.kind === "move" && movingPlayer
        ? {
            actorId: socket.id,
            from: { col: movingPlayer.col, row: movingPlayer.row },
            path: action.path,
          }
        : null;
    const res = applyGameAction(g, socket.id, action);
    if (!res.ok) {
      cb?.(res.error);
      return;
    }
    if (moveEvent) io.to(code).emit("game:move", moveEvent);
    broadcastGameState(code);
    cb?.(null, res.data);
    if (g.beastTurnPending) runBeastIfPending(code);
    else scheduleTurnTimer(code);
  });

  socket.on("room:transferHost", (targetSocketId: string, cb?: (err: string | null) => void) => {
    const code = socketRoom.get(socket.id);
    if (!code) {
      cb?.("不在房间内");
      return;
    }
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) {
      cb?.("仅房主可操作");
      return;
    }
    if (!room.players.has(targetSocketId)) {
      cb?.("目标不在房间");
      return;
    }
    if (isBotSocketId(targetSocketId)) {
      cb?.("不能将房主交给电脑");
      return;
    }
    room.hostId = targetSocketId;
    broadcastRoom(room);
    cb?.(null);
  });

  /** 房主与另一名对战席玩家互换席位索引 */
  socket.on("room:swapSeatWith", (targetSocketId: unknown, cb?: (err: string | null) => void) => {
    const code = socketRoom.get(socket.id);
    if (!code) {
      cb?.("不在房间内");
      return;
    }
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) {
      cb?.("仅房主可操作");
      return;
    }
    if (games.has(code)) {
      cb?.("游戏进行中无法换位");
      return;
    }
    const tid = String(targetSocketId ?? "");
    if (!tid || tid === socket.id) {
      cb?.("无效目标");
      return;
    }
    const me = room.players.get(socket.id);
    const peer = room.players.get(tid);
    if (!me || !peer) {
      cb?.("仅可在对战席玩家之间更换位置");
      return;
    }
    const a = me.slotIndex;
    me.slotIndex = peer.slotIndex;
    peer.slotIndex = a;
    broadcastRoom(room);
    cb?.(null);
  });

  socket.on(
    "room:addBot",
    (data: { slotIndex?: unknown; difficulty?: unknown } | undefined, cb?: (err: string | null) => void) => {
      const code = socketRoom.get(socket.id);
      if (!code) {
        cb?.("不在房间内");
        return;
      }
      const room = rooms.get(code);
      if (!room || room.hostId !== socket.id) {
        cb?.("仅房主可添加电脑");
        return;
      }
      if (games.has(code)) {
        cb?.("游戏进行中无法添加");
        return;
      }
      const rawDiff = String(data?.difficulty ?? "");
      if (rawDiff !== "easy" && rawDiff !== "medium" && rawDiff !== "hard") {
        cb?.("难度无效");
        return;
      }
      const diff = rawDiff as BotDifficulty;
      const slot = Math.floor(Number(data?.slotIndex));
      const cfg = matchModeConfig(room.matchMode);
      if (!Number.isFinite(slot) || slot < 0 || slot >= cfg.maxSlots) {
        cb?.("席位无效");
        return;
      }
      const taken = [...room.players.values()].some((p) => p.slotIndex === slot);
      if (taken) {
        cb?.("该席位已有玩家");
        return;
      }
      const botId = `bot:${randomUUID()}`;
      const nick =
        diff === "easy" ? "电脑(初级)" : diff === "medium" ? "电脑(中级)" : "电脑(高级)";
      const gid = `bot_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
      room.players.set(botId, {
        socketId: botId,
        gameAccountId: gid,
        nickname: nick,
        avatar: botAvatarDataUrl(botId),
        slotIndex: slot,
      });
      if (!room.botDifficulties) room.botDifficulties = new Map();
      room.botDifficulties.set(botId, diff);
      broadcastRoom(room);
      cb?.(null);
    }
  );

  socket.on("room:kick", (targetSocketId: string, cb?: (err: string | null) => void) => {
    const code = socketRoom.get(socket.id);
    if (!code) {
      cb?.("不在房间内");
      return;
    }
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) {
      cb?.("仅房主可操作");
      return;
    }
    if (targetSocketId === socket.id) {
      cb?.("不能踢出自己");
      return;
    }
    const target = room.players.get(targetSocketId);
    if (!target) {
      cb?.("目标不在房间");
      return;
    }
    const gKick = games.get(code);
    if (gKick) {
      const left = eliminatePlayerFromGame(gKick, targetSocketId, { deathCause: "被房主移出游戏" });
      if (left) io.to(code).emit("game:playerLeft", { nickname: left.nickname });
      broadcastGameState(code);
    }
    room.players.delete(targetSocketId);
    room.botDifficulties?.delete(targetSocketId);
    io.sockets.sockets.get(targetSocketId)?.leave(code);
    socketRoom.delete(targetSocketId);
    io.to(targetSocketId).emit("room:kicked");
    if (room.players.size === 0 && (room.spectators?.size ?? 0) === 0 && !games.has(code)) {
      rooms.delete(room.code);
    } else if (room.hostId === targetSocketId) {
      const nextHuman = pickRandomHumanHost(room);
      if (nextHuman) {
        room.hostId = nextHuman;
        broadcastRoom(room);
      } else {
        dissolveRoom(room);
      }
    } else {
      broadcastRoom(room);
    }
    cb?.(null);
  });

  socket.on("disconnect", () => {
    const code = socketRoom.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (room?.spectators?.has(socket.id)) {
      room.spectators!.delete(socket.id);
      socketRoom.delete(socket.id);
      broadcastRoom(room);
      return;
    }
    const g = games.get(code);
    if (g && g.players.has(socket.id)) {
      const pl = g.players.get(socket.id)!;
      if (pl.hp > 0 && g.phase === "playing") {
        pl.disconnectedAt = Date.now();
        appendReplayLog(g, socket.id, `玩家「${pl.nickname}」断开连接，等待重连`);
      }
      socketRoom.delete(socket.id);
      broadcastGameState(code);
      if (room) broadcastRoom(room);
      return;
    }
    let roomAfter: Room | null = null;
    if (room) {
      roomAfter = removePlayerFromRoom(socket.id, room);
    }
    socketRoom.delete(socket.id);
    if (g) broadcastGameState(code);
    if (roomAfter) broadcastRoom(roomAfter);
  });
});

const PORT = Number(process.env.PORT) || 3001;
httpServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[Dark Forest] 端口 ${PORT} 已被占用（请先关闭之前的后端进程，或设置环境变量 PORT 使用其他端口）`
    );
    process.exit(1);
  }
  throw err;
});
httpServer.listen(PORT, () => {
  console.log(`Dark Forest server http://localhost:${PORT}`);
});
