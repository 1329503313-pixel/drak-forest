import {
  ATTACK_COST,
  ATTACK_RANGE,
  TURN_LIMIT_MS,
  SKILL_META,
  type SkillId,
  VISION_RADIUS,
} from "./constants.js";
import { toGameSessionRules, type RoomGameSettings } from "../roomGameSettings.js";
import { randomUUID } from "node:crypto";
import {
  cellKey,
  cellsInChebyshevDisk,
  cellsInRectCenter,
  chebyshev,
  formatCellLabel,
  generateWallKeys,
  inBounds,
  manhattan,
  OCT_DIRS,
  orthogonalNeighbors,
  parseKey,
  rayFrom,
} from "./grid.js";
import type {
  BeastState,
  BotDifficulty,
  BountyPair,
  BurningZone,
  FlareZone,
  GamePlayer,
  GameReplayEntry,
  GameSession,
  MapEventKind,
  MapEventState,
  PendingNukeState,
  TurnFlags,
} from "./gameTypes.js";

export type { BotDifficulty } from "./gameTypes.js";
import { pickSpawnPositions } from "./spawn.js";
import { matchModeConfig, teamIdForSlot, type MatchMode } from "../matchModes.js";

function freshTurnFlags(): TurnFlags {
  return {
    didAttack: false,
    learnCount: 0,
    skillIdsUsed: [],
    didRest: false,
    didMove: false,
  };
}

export type RoomPlayerLite = {
  socketId: string;
  gameAccountId: string;
  nickname: string;
  avatar: string;
  slotIndex: number;
  botDifficulty?: BotDifficulty;
};

export const REPLAY_SYSTEM = "__system__";
const REPLAY_BEAST = "__beast__";
const BEAST_MAX_HP = 15;
type DamageEvent = NonNullable<GameReplayEntry["damageEvents"]>[number];

export function snapshotVitals(g: GameSession): Record<string, { nickname: string; hp: number; stamina: number }> {
  const o: Record<string, { nickname: string; hp: number; stamina: number }> = {};
  for (const pl of g.players.values()) {
    o[pl.socketId] = {
      nickname: pl.nickname,
      hp: Math.max(0, pl.hp),
      stamina: pl.stamina,
    };
  }
  return o;
}

export function appendReplayLog(
  g: GameSession,
  actorId: string,
  summary: string,
  damage?: string,
  damageEvents?: GameReplayEntry["damageEvents"]
): void {
  const actorNickname =
    actorId === REPLAY_SYSTEM ? "系统" : actorId === REPLAY_BEAST ? "巨兽" : (g.players.get(actorId)?.nickname ?? "?");
  const entry: GameReplayEntry = {
    seq: g.replayLog.length,
    roundNumber: g.roundNumber,
    actorId,
    actorNickname,
    summary,
    damage,
    damageEvents,
    vitals: snapshotVitals(g),
  };
  g.replayLog.push(entry);
}

function allGridKeys(n: number): Set<string> {
  const s = new Set<string>();
  for (let c = 0; c < n; c++) {
    for (let r = 0; r < n; r++) s.add(cellKey(c, r));
  }
  return s;
}

/** 断线重连：将局中所有 oldSid 引用替换为 newSid */
export function rebindPlayerSocket(g: GameSession, oldSid: string, newSid: string): void {
  const p = g.players.get(oldSid);
  if (!p || oldSid === newSid) return;
  g.players.delete(oldSid);
  p.socketId = newSid;
  p.disconnectedAt = null;
  g.players.set(newSid, p);
  const ti = g.turnOrder.indexOf(oldSid);
  if (ti >= 0) g.turnOrder[ti] = newSid;
  for (const k of Object.keys(g.slotAssignments)) {
    const si = Number(k);
    if (g.slotAssignments[si] === oldSid) g.slotAssignments[si] = newSid;
  }
  const tf = g.turnFlags.get(oldSid);
  if (tf) {
    g.turnFlags.delete(oldSid);
    g.turnFlags.set(newSid, tf);
  }
  for (const z of g.burningZones) {
    if (z.ownerId === oldSid) z.ownerId = newSid;
  }
  for (const f of g.flareZones) {
    if (f.ownerId === oldSid) f.ownerId = newSid;
  }
  for (const b of g.bountyPairs) {
    if (b.aId === oldSid) b.aId = newSid;
    if (b.bId === oldSid) b.bId = newSid;
  }
  for (const pl of g.players.values()) {
    if (pl.bountyPartnerId === oldSid) pl.bountyPartnerId = newSid;
  }
  for (const c of g.shadowClones) {
    if (c.ownerId === oldSid) c.ownerId = newSid;
  }
  for (const n of g.pendingNukes) {
    if (n.ownerId === oldSid) n.ownerId = newSid;
  }
  for (const m of g.landmines) {
    if (m.ownerId === oldSid) m.ownerId = newSid;
  }
  for (const r of g.sonicRadars) {
    if (r.ownerId === oldSid) r.ownerId = newSid;
  }
}

/** 断线超过 maxMs 未重连则淘汰 */
export function purgeDisconnectedPlayers(
  g: GameSession,
  now: number,
  maxMs: number
): { nickname: string }[] {
  const purged: { nickname: string }[] = [];
  for (const id of [...g.turnOrder]) {
    if (id.startsWith("bot:")) continue;
    const p = g.players.get(id);
    if (!p?.disconnectedAt) continue;
    if (now - p.disconnectedAt > maxMs) {
      const { nickname } = p;
      appendReplayLog(g, REPLAY_SYSTEM, `玩家「${nickname}」断线超过时限，视为离开`);
      eliminatePlayerFromGame(g, id, { deathCause: "断线离开" });
      purged.push({ nickname });
    }
  }
  return purged;
}

export function createGameFromRoom(
  roomCode: string,
  roomPlayers: Map<string, RoomPlayerLite>,
  gridSize: number,
  matchMode: MatchMode = "solo",
  roomGameSettings: RoomGameSettings
): { session: GameSession; spawnBySocket: Record<string, { slotIndex: number; gridLabel: string }> } | null {
  const sorted = [...roomPlayers.values()].sort((a, b) => a.slotIndex - b.slotIndex);
  const modeCfg = matchModeConfig(matchMode);
  const spawns = pickSpawnPositions(sorted.length, gridSize);
  if (!spawns) return null;
  const wallKeys = generateWallKeys(gridSize, spawns);
  const rs = roomGameSettings;
  const rules = toGameSessionRules(rs);

  const slotAssignments: Record<number, string> = {};
  const players = new Map<string, GamePlayer>();
  const spawnBySocket: Record<string, { slotIndex: number; gridLabel: string }> = {};

  sorted.forEach((p, i) => {
    const pos = spawns[i]!;
    slotAssignments[p.slotIndex] = p.socketId;
    spawnBySocket[p.socketId] = {
      slotIndex: p.slotIndex,
      gridLabel: formatCellLabel(pos.col, pos.row),
    };
    const botDiff = p.botDifficulty;
    const hardCpu = botDiff === "hard";
    players.set(p.socketId, {
      socketId: p.socketId,
      gameAccountId: p.gameAccountId,
      slotIndex: p.slotIndex,
      teamId: teamIdForSlot(modeCfg.mode, p.slotIndex),
      nickname: p.nickname,
      avatar: p.avatar,
      col: pos.col,
      row: pos.row,
      hp: rs.initialHp,
      stamina: hardCpu ? rs.maxStamina : rs.initialStamina,
      skills: [],
      turnSerial: 0,
      lastSkillAtTurn: {},
      stealthActive: false,
      bountyPartnerId: null,
      resumeToken: randomUUID(),
      disconnectedAt: null,
      skipNextTurn: false,
      damageBonus: 0,
      deathCause: null,
      botDifficulty: botDiff,
      goldenBellForRound: null,
      markedExposeUntilRound: null,
    });
  });

  const turnOrder = sorted.map((p) => p.socketId);
  const session: GameSession = {
    roomCode,
    gridSize,
    matchMode: modeCfg.mode,
    matchModeLabel: modeCfg.label,
    teamSize: modeCfg.teamSize,
    rules,
    matchId: randomUUID(),
    retiredToLobby: new Set(),
    slotAssignments,
    turnOrder,
    turnIndex: 0,
    roundNumber: 1,
    turnDeadlineAt: null,
    turnTimerSeq: 0,
    players,
    burningZones: [],
    flareZones: [],
    bountyPairs: [],
    shadowClones: [],
    pendingNukes: [],
    landmines: [],
    sonicRadars: [],
    turnFlags: new Map(),
    phase: "playing",
    winnerId: null,
    eliminationOrder: [],
    shrinkMargin: 0,
    wallKeys,
    poisonWarningKeys: [],
    mapEvent: null,
    beast: null,
    beastTurnPending: false,
    replayLog: [],
  };

  for (const id of turnOrder) {
    session.turnFlags.set(id, freshTurnFlags());
  }

  onTurnStart(session, turnOrder[0]!);
  session.turnTimerSeq++;
  session.turnDeadlineAt = Date.now() + TURN_LIMIT_MS;
  appendReplayLog(session, turnOrder[0]!, "对局开始：各玩家已部署");
  return { session, spawnBySocket };
}

export function currentPlayerId(g: GameSession): string {
  return g.turnOrder[g.turnIndex]!;
}

function sessionMaxHp(g: GameSession): number {
  return g.rules.maxHp;
}

function sessionMaxStamina(g: GameSession): number {
  return g.rules.maxStamina;
}

function sessionAttackDamage(g: GameSession): number {
  return g.rules.attackDamage;
}

function onTurnStart(g: GameSession, pid: string): void {
  const p = g.players.get(pid);
  if (!p || p.hp <= 0) return;
  p.turnSerial++;
  p.stamina = Math.min(sessionMaxStamina(g), p.stamina + 2);
  /** 高级电脑：回合开始额外恢复 3 点体力（仍受上限约束） */
  if (p.botDifficulty === "hard") {
    p.stamina = Math.min(sessionMaxStamina(g), p.stamina + 3);
  }
  const n = g.gridSize;
  const burnEvents: DamageEvent[] = [];
  for (const z of g.burningZones) {
    const inBurn = cellsInRectCenter(z.centerCol, z.centerRow, 1, n).some(
      (cell) => cell.col === p.col && cell.row === p.row
    );
    if (inBurn) {
      const evt = applyDirectDamage(g, z.ownerId, p, 3, "燃烧");
      if (evt) burnEvents.push(evt);
    }
  }
  if (burnEvents.length > 0) {
    appendReplayLog(g, burnEvents[0]!.sourceId, "燃烧伤害", formatDamageEvents(burnEvents), burnEvents);
  }
  g.flareZones = g.flareZones.filter((f) => f.ownerId !== pid);
}

/** 战斗中体力归零者移出行列并结算胜负（可连续多名） */
export function eliminateAllDeadFromTurn(
  g: GameSession,
  opts?: { skipTurnCallbacks?: boolean }
): void {
  for (;;) {
    if (g.phase !== "playing") return;
    const deadInTurn = g.turnOrder.find((id) => (g.players.get(id)?.hp ?? 0) <= 0);
    if (!deadInTurn) return;
    eliminatePlayerFromGame(g, deadInTurn, opts);
  }
}

/** 玩家离开/出局：移出行列顺序，当前回合者离开时轮到下一位 */
export function eliminatePlayerFromGame(
  g: GameSession,
  socketId: string,
  opts?: { skipTurnCallbacks?: boolean; deathCause?: string }
): { nickname: string } | null {
  const pl = g.players.get(socketId);
  if (!pl) return null;
  const nickname = pl.nickname;
  pl.hp = 0;
  if (opts?.deathCause && !pl.deathCause) pl.deathCause = opts.deathCause;
  pl.bountyPartnerId = null;

  const idx = g.turnOrder.indexOf(socketId);
  if (idx === -1) {
    checkWinner(g);
    return null;
  }

  if (!g.eliminationOrder.includes(socketId)) {
    g.eliminationOrder.push(socketId);
  }

  const wasCurrent = idx === g.turnIndex;
  g.turnOrder.splice(idx, 1);

  g.bountyPairs = g.bountyPairs.filter((b) => b.aId !== socketId && b.bId !== socketId);
  for (const p of g.players.values()) {
    if (p.bountyPartnerId === socketId) p.bountyPartnerId = null;
  }
  g.shadowClones = g.shadowClones.filter((c) => c.ownerId !== socketId);
  g.pendingNukes = g.pendingNukes.filter((n) => n.ownerId !== socketId);
  g.landmines = g.landmines.filter((m) => m.ownerId !== socketId);
  g.sonicRadars = g.sonicRadars.filter((r) => r.ownerId !== socketId);

  if (g.turnOrder.length === 0) {
    g.phase = "ended";
    g.winnerId = null;
    return { nickname };
  }

  if (idx < g.turnIndex) {
    g.turnIndex--;
  } else if (wasCurrent) {
    g.turnIndex %= g.turnOrder.length;
  }

  checkWinner(g);
  if (g.phase !== "playing") return { nickname };

  if (wasCurrent && !opts?.skipTurnCallbacks) {
    startCurrentTurn(g);
  }
  return { nickname };
}

function skillRoundsRemaining(p: GamePlayer, sk: SkillId): number {
  const meta = SKILL_META[sk];
  const last = p.lastSkillAtTurn[sk] ?? -9999;
  if (p.turnSerial - last > meta.cooldown) return 0;
  return meta.cooldown + 1 - (p.turnSerial - last);
}

/** 矩形 [lo..hi]² 的外圈（将被淘汰的一层格子） */
function outerRingCellKeys(lo: number, hi: number): Set<string> {
  const s = new Set<string>();
  if (lo > hi) return s;
  for (let c = lo; c <= hi; c++) {
    s.add(cellKey(c, lo));
    s.add(cellKey(c, hi));
  }
  for (let r = lo + 1; r <= hi - 1; r++) {
    s.add(cellKey(lo, r));
    s.add(cellKey(hi, r));
  }
  return s;
}

function cellInPlayableArea(g: GameSession, col: number, row: number): boolean {
  const m = g.shrinkMargin;
  const n = g.gridSize;
  return col >= m && col <= n - 1 - m && row >= m && row <= n - 1 - m;
}

function cellIsWall(g: GameSession, col: number, row: number): boolean {
  return g.wallKeys.includes(cellKey(col, row));
}

function damageAmountFor(g: GameSession, actorId: string, base: number): number {
  return base + Math.max(0, g.players.get(actorId)?.damageBonus ?? 0);
}

function deathCauseFor(g: GameSession, actorId: string, operation: string): string {
  if (actorId === REPLAY_BEAST) return "死于巨兽";
  if (actorId === REPLAY_SYSTEM) return `死于${operation}`;
  const actor = g.players.get(actorId);
  return actor ? `死于${actor.nickname}的${operation}` : `死于${operation}`;
}

function inferDeathCause(g: GameSession, playerId: string): string {
  const player = g.players.get(playerId);
  if (player?.deathCause) return player.deathCause;

  for (let i = g.replayLog.length - 1; i >= 0; i--) {
    const entry = g.replayLog[i]!;
    const hit = [...(entry.damageEvents ?? [])].reverse().find((e) => e.targetId === playerId);
    if (!hit) continue;
    if (hit.deathCause) return hit.deathCause;
    if (hit.sourceId === REPLAY_BEAST) return "死于巨兽";
    if (hit.sourceId === REPLAY_SYSTEM) {
      if (entry.summary.includes("火山")) return "死于火山喷发";
      if (entry.summary.includes("毒圈")) return "死于毒圈";
      return `死于${hit.operation ?? entry.summary}`;
    }
    return `死于${hit.sourceNickname}的${hit.operation ?? entry.summary.replace(/^使用技能：/, "")}`;
  }

  return "死因未知";
}

function mapEventName(kind: MapEventKind): string {
  if (kind === "volcano") return "火山喷发";
  if (kind === "earthquake") return "地震";
  return "天降甘霖";
}

function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function randomFrom<T>(arr: T[]): T | undefined {
  return arr[Math.floor(Math.random() * arr.length)];
}

function eventCellKeys(ev: MapEventState, n: number): string[] {
  return cellsInRectCenter(ev.centerCol, ev.centerRow, 1, n).map((cell) => cellKey(cell.col, cell.row));
}

function chooseEventCenter(g: GameSession): { col: number; row: number } | null {
  const m = g.shrinkMargin;
  const candidates: Array<{ col: number; row: number }> = [];
  for (let col = m + 1; col <= g.gridSize - 2 - m; col++) {
    for (let row = m + 1; row <= g.gridSize - 2 - m; row++) {
      candidates.push({ col, row });
    }
  }
  return randomFrom(candidates) ?? null;
}

function chooseMapEvent(g: GameSession): MapEventState | null {
  const center = chooseEventCenter(g);
  if (!center) return null;
  const kinds: MapEventKind[] = ["volcano", "earthquake", "rain"];
  return {
    kind: randomFrom(kinds) ?? "volcano",
    phase: "warning",
    centerCol: center.col,
    centerRow: center.row,
    roundNumber: g.roundNumber,
  };
}

function preparePoisonWarning(g: GameSession): void {
  const m = g.shrinkMargin;
  const lo = m;
  const hi = g.gridSize - 1 - m;
  g.poisonWarningKeys = [...outerRingCellKeys(lo, hi)];
  if (g.poisonWarningKeys.length > 0) {
    appendReplayLog(g, REPLAY_SYSTEM, "毒圈预警：下一轮红色高亮区域将会收缩");
  }
}

/** roundNumber 已在 endTurn 中加一之后调用；第 4 轮起每 3 轮收缩一次 */
function applyShrinkAfterRoundAdvance(g: GameSession): void {
  const n = g.gridSize;
  const m = g.shrinkMargin;
  const lo = m;
  const hi = n - 1 - m;
  if (lo > hi) return;
  const ring = outerRingCellKeys(lo, hi);
  for (const id of [...g.turnOrder]) {
    const pl = g.players.get(id);
    if (!pl || pl.hp <= 0) continue;
    if (ring.has(cellKey(pl.col, pl.row)))
      eliminatePlayerFromGame(g, id, { skipTurnCallbacks: true, deathCause: "死于毒圈" });
  }
  g.shrinkMargin++;
  appendReplayLog(
    g,
    REPLAY_SYSTEM,
    `毒圈收缩：第 ${m} 层外圈消失，停留该圈的存活玩家被淘汰`
  );
  checkWinner(g);
}

function applyMapEvent(g: GameSession, ev: MapEventState): void {
  const cells = cellsInRectCenter(ev.centerCol, ev.centerRow, 1, g.gridSize);
  if (ev.kind === "volcano") {
    const events: DamageEvent[] = [];
    for (const p of g.players.values()) {
      if (p.hp <= 0) continue;
      if (cells.some((cell) => cell.col === p.col && cell.row === p.row)) {
        const evt = applyDirectDamage(g, REPLAY_SYSTEM, p, 3, "火山喷发");
        if (evt) events.push(evt);
      }
    }
    appendReplayLog(g, REPLAY_SYSTEM, "火山喷发：区域内玩家受到 3 点伤害", formatDamageEvents(events), events);
    /** 处于 round 起点 onRoundStart 内，外层 endTurn 会再调 startCurrentTurn，禁止此处回调否则同一回合被开启两次 */
    eliminateAllDeadFromTurn(g, { skipTurnCallbacks: true });
    return;
  }

  if (ev.kind === "earthquake") {
    const hit: string[] = [];
    for (const p of g.players.values()) {
      if (p.hp <= 0) continue;
      if (cells.some((cell) => cell.col === p.col && cell.row === p.row)) {
        p.skipNextTurn = true;
        hit.push(p.nickname);
      }
    }
    appendReplayLog(g, REPLAY_SYSTEM, hit.length > 0 ? `地震：${hit.join("、")} 下一次行动将被跳过` : "地震：区域内没有玩家");
    return;
  }

  const healed: string[] = [];
  for (const p of g.players.values()) {
    if (p.hp <= 0) continue;
    if (cells.some((cell) => cell.col === p.col && cell.row === p.row)) {
      p.hp = Math.min(sessionMaxHp(g), p.hp + 3);
      p.stamina = Math.min(sessionMaxStamina(g), p.stamina + 3);
      healed.push(p.nickname);
    }
  }
  appendReplayLog(g, REPLAY_SYSTEM, healed.length > 0 ? `天降甘霖：${healed.join("、")} 恢复生命与体力` : "天降甘霖：区域内没有玩家");
}

function updateMapEventForRound(g: GameSession): void {
  if (g.mapEvent?.phase === "active" && g.mapEvent.roundNumber < g.roundNumber) {
    g.mapEvent = null;
  }
  if (g.roundNumber < 5) return;
  const cycle = (g.roundNumber - 5) % 3;
  if (cycle === 0) {
    const ev = chooseMapEvent(g);
    if (!ev) return;
    g.mapEvent = ev;
    const color = ev.kind === "rain" ? "绿色" : "红色";
    appendReplayLog(g, REPLAY_SYSTEM, `事件预警：下一轮「${mapEventName(ev.kind)}」将在${color}高亮区域发生`);
  } else if (cycle === 1 && g.mapEvent?.phase === "warning") {
    g.mapEvent = { ...g.mapEvent, phase: "active", roundNumber: g.roundNumber };
    appendReplayLog(g, REPLAY_SYSTEM, `事件发生：${mapEventName(g.mapEvent.kind)}`);
    applyMapEvent(g, g.mapEvent);
  } else if (cycle === 2) {
    g.mapEvent = null;
  }
}

function updatePoisonForRound(g: GameSession): void {
  g.poisonWarningKeys = [];
  if (g.roundNumber >= 4 && (g.roundNumber - 4) % 3 === 0) {
    applyShrinkAfterRoundAdvance(g);
  }
  if (g.phase !== "playing") return;
  if (g.roundNumber >= 3 && (g.roundNumber - 3) % 3 === 0) {
    preparePoisonWarning(g);
  }
}

function beastCellKeys(beast: BeastState): string[] {
  return [
    cellKey(beast.col, beast.row),
    cellKey(beast.col + 1, beast.row),
    cellKey(beast.col, beast.row + 1),
    cellKey(beast.col + 1, beast.row + 1),
  ];
}

function beastOccupies(beast: BeastState | null, col: number, row: number): boolean {
  if (!beast || beast.hp <= 0) return false;
  return col >= beast.col && col <= beast.col + 1 && row >= beast.row && row <= beast.row + 1;
}

function beastPositionValid(g: GameSession, col: number, row: number): boolean {
  if (col < 0 || row < 0 || col + 1 >= g.gridSize || row + 1 >= g.gridSize) return false;
  for (let dc = 0; dc <= 1; dc++) {
    for (let dr = 0; dr <= 1; dr++) {
      const c = col + dc;
      const r = row + dr;
      if (!cellInPlayableArea(g, c, r) || cellIsWall(g, c, r)) return false;
      if ([...g.players.values()].some((p) => p.hp > 0 && p.col === c && p.row === r)) return false;
    }
  }
  return true;
}

function spawnBeast(g: GameSession): void {
  if (g.beast || g.roundNumber < 7) return;
  const candidates: Array<{ col: number; row: number }> = [];
  for (let col = 0; col < g.gridSize - 1; col++) {
    for (let row = 0; row < g.gridSize - 1; row++) {
      if (beastPositionValid(g, col, row)) candidates.push({ col, row });
    }
  }
  const pos = randomFrom(candidates);
  if (!pos) return;
  g.beast = {
    col: pos.col,
    row: pos.row,
    hp: BEAST_MAX_HP,
    maxHp: BEAST_MAX_HP,
    spawnedRound: g.roundNumber,
    lastActedRound: 0,
  };
  appendReplayLog(g, REPLAY_SYSTEM, "巨兽已经出现，击杀巨兽获得奖励");
}

function distanceFromBeastToPlayer(beast: BeastState, p: GamePlayer): number {
  let best = Number.POSITIVE_INFINITY;
  for (const k of beastCellKeys(beast)) {
    const b = parseKey(k);
    best = Math.min(best, manhattan(b, p));
  }
  return best;
}

function livingPlayersInBeastVision(g: GameSession, beast: BeastState): GamePlayer[] {
  return [...g.players.values()]
    .filter((p) => p.hp > 0 && distanceFromBeastToPlayer(beast, p) <= 5)
    .sort((a, b) => distanceFromBeastToPlayer(beast, a) - distanceFromBeastToPlayer(beast, b));
}

function moveBeast(g: GameSession): Array<{ col: number; row: number }> {
  const beast = g.beast;
  if (!beast || beast.hp <= 0) return [];
  const target = livingPlayersInBeastVision(g, beast)[0];
  const steps = randomInt(1, 3);
  const positions: Array<{ col: number; row: number }> = [{ col: beast.col, row: beast.row }];

  for (let i = 0; i < steps; i++) {
    const candidates = orthogonalNeighbors(beast.col, beast.row, g.gridSize)
      .filter((p) => beastPositionValid(g, p.col, p.row));
    if (candidates.length === 0) return positions;
    let chosen: { col: number; row: number } | undefined;
    if (target) {
      const currentDistance = distanceFromBeastToPlayer(beast, target);
      const closer = candidates.filter((p) => {
        const tmp = { ...beast, col: p.col, row: p.row };
        return distanceFromBeastToPlayer(tmp, target) < currentDistance;
      });
      chosen = randomFrom(closer.length > 0 ? closer : candidates);
    } else {
      chosen = randomFrom(candidates);
    }
    if (!chosen) return positions;
    beast.col = chosen.col;
    beast.row = chosen.row;
    positions.push({ col: beast.col, row: beast.row });
  }
  return positions;
}

function beastAttack(g: GameSession): DamageEvent[] {
  const beast = g.beast;
  if (!beast || beast.hp <= 0) return [];
  const adjacentCells = new Set<string>();
  for (const k of beastCellKeys(beast)) {
    const b = parseKey(k);
    for (const nb of orthogonalNeighbors(b.col, b.row, g.gridSize)) {
      if (!beastOccupies(beast, nb.col, nb.row)) adjacentCells.add(cellKey(nb.col, nb.row));
    }
  }
  const cellsWithPlayers = [...adjacentCells].filter((k) => {
    const pos = parseKey(k);
    return [...g.players.values()].some((p) => p.hp > 0 && p.col === pos.col && p.row === pos.row);
  });
  const chosen = randomFrom(cellsWithPlayers);
  if (!chosen) return [];
  const pos = parseKey(chosen);
  const events: DamageEvent[] = [];
  for (const p of g.players.values()) {
    if (p.hp > 0 && p.col === pos.col && p.row === pos.row) {
      const evt = applyDirectDamage(g, REPLAY_BEAST, p, 2, "巨兽");
      if (evt) events.push(evt);
    }
  }
  return events;
}

export function runPendingBeastTurn(g: GameSession): {
  from: { col: number; row: number };
  path: Array<{ col: number; row: number }>;
  damageEvents: DamageEvent[];
} | null {
  const beast = g.beast;
  if (!g.beastTurnPending || !beast || beast.hp <= 0 || beast.lastActedRound === g.roundNumber) return null;
  const positions = moveBeast(g);
  const mineEvents: DamageEvent[] = [];
  for (const k of beastCellKeys(beast)) {
    const pos = parseKey(k);
    mineEvents.push(...triggerLandminesAt(g, REPLAY_BEAST, pos.col, pos.row));
  }
  const damageEvents = [...mineEvents, ...beastAttack(g)];
  beast.lastActedRound = g.roundNumber;
  g.beastTurnPending = false;
  appendReplayLog(
    g,
    REPLAY_BEAST,
    damageEvents.length > 0 ? "巨兽发动攻击" : "巨兽正在徘徊",
    formatDamageEvents(damageEvents),
    damageEvents
  );
  /** 随后会 turnIndex=0、新回合 onRoundStart、startCurrentTurn，禁止淘汰回调里再开回合 */
  eliminateAllDeadFromTurn(g, { skipTurnCallbacks: true });
  if (g.phase !== "playing") {
    return {
      from: positions[0] ?? { col: beast.col, row: beast.row },
      path: positions.slice(1),
      damageEvents,
    };
  }
  g.turnIndex = 0;
  g.roundNumber++;
  onRoundStart(g);
  startCurrentTurn(g);
  return {
    from: positions[0] ?? { col: beast.col, row: beast.row },
    path: positions.slice(1),
    damageEvents,
  };
}

function onRoundStart(g: GameSession): void {
  resolveNukeExplosions(g);
  for (const pl of g.players.values()) {
    if (pl.markedExposeUntilRound != null && g.roundNumber > pl.markedExposeUntilRound) {
      pl.markedExposeUntilRound = null;
    }
  }
  for (const d of g.shadowClones) {
    d.roundsLeft -= 1;
  }
  g.shadowClones = g.shadowClones.filter((d) => d.roundsLeft > 0);
  for (const r of g.sonicRadars) {
    r.roundsLeft -= 1;
  }
  g.sonicRadars = g.sonicRadars.filter((r) => r.roundsLeft > 0);
  for (const z of g.burningZones) {
    z.roundsLeft -= 1;
  }
  g.burningZones = g.burningZones.filter((z) => z.roundsLeft > 0);
  for (const b of g.bountyPairs) {
    b.roundsLeft -= 1;
  }
  g.bountyPairs = g.bountyPairs.filter((b) => b.roundsLeft > 0);
  updatePoisonForRound(g);
  updateMapEventForRound(g);
  spawnBeast(g);
}

function advanceTurnPointer(g: GameSession): void {
  if (g.turnOrder.length === 0) return;
  const wasLast = g.turnIndex >= g.turnOrder.length - 1;
  if (wasLast) {
    if (g.beast && g.beast.hp > 0 && g.beast.lastActedRound !== g.roundNumber) {
      g.beastTurnPending = true;
      g.turnDeadlineAt = null;
    } else {
      g.turnIndex = 0;
      g.roundNumber++;
      onRoundStart(g);
    }
  } else {
    g.turnIndex++;
  }
}

function startCurrentTurn(g: GameSession): void {
  let guard = 0;
  while (g.phase === "playing" && g.turnOrder.length > 0 && guard++ < 100) {
    if (g.beastTurnPending) return;
    const next = currentPlayerId(g);
    const p = g.players.get(next);
    if (!p || p.hp <= 0) {
      eliminateAllDeadFromTurn(g, { skipTurnCallbacks: true });
      continue;
    }
    if (p.skipNextTurn) {
      p.skipNextTurn = false;
      appendReplayLog(g, REPLAY_SYSTEM, `地震影响：${p.nickname} 本轮无法行动`);
      advanceTurnPointer(g);
      continue;
    }
    g.turnFlags.set(next, freshTurnFlags());
    onTurnStart(g, next);
    /** 回合开始燃烧等伤害可能致死；勿在此处 startCurrentTurn，仅同步队列 */
    eliminateAllDeadFromTurn(g, { skipTurnCallbacks: true });
    if (g.phase !== "playing") return;
    if (currentPlayerId(g) !== next || (g.players.get(next)?.hp ?? 0) <= 0) {
      continue;
    }
    g.turnTimerSeq++;
    g.turnDeadlineAt = Date.now() + TURN_LIMIT_MS;
    checkWinner(g);
    return;
  }
}

function endTurn(g: GameSession): void {
  advanceTurnPointer(g);
  if (g.phase !== "playing") return;
  startCurrentTurn(g);
  checkWinner(g);
}

function checkWinner(g: GameSession): void {
  const alive = [...g.players.values()].filter((x) => x.hp > 0);
  if (g.teamSize > 1) {
    const aliveTeams = new Set(alive.map((p) => p.teamId));
    if (aliveTeams.size <= 1) {
      g.phase = "ended";
      g.winnerId = alive[0]?.socketId ?? null;
    }
    return;
  }
  if (alive.length <= 1) {
    g.phase = "ended";
    g.winnerId = alive[0]?.socketId ?? null;
  }
}

function sameTeam(g: GameSession, aId: string, bId: string): boolean {
  if (g.teamSize <= 1) return false;
  const a = g.players.get(aId);
  const b = g.players.get(bId);
  return Boolean(a && b && a.teamId === b.teamId);
}

function canUseSkill(g: GameSession, actorId: string, sk: SkillId): boolean {
  const p = g.players.get(actorId);
  if (!p) return false;
  if (!p.skills.includes(sk)) return false;
  if (sk === "blade_escape") return false;
  const meta = SKILL_META[sk];
  const last = p.lastSkillAtTurn[sk] ?? -9999;
  return p.turnSerial - last > meta.cooldown;
}

function skillStaminaCost(g: GameSession, actorId: string, sk: SkillId): number {
  const meta = SKILL_META[sk];
  if (sk !== "landmine") return meta.cost;
  const tf = g.turnFlags.get(actorId);
  const usedLandmines = tf?.skillIdsUsed.filter((x) => x === "landmine").length ?? 0;
  return usedLandmines >= 1 ? 3 : meta.cost;
}

function skillDamageAmountFor(g: GameSession, actorId: string, base: number): number {
  if (actorId === REPLAY_SYSTEM || actorId === REPLAY_BEAST) return base;
  return damageAmountFor(g, actorId, base);
}

function triggerLandminesAt(g: GameSession, walkerId: string, col: number, row: number): DamageEvent[] {
  const idx = g.landmines.findIndex((m) => m.col === col && m.row === row);
  if (idx < 0) return [];
  const mine = g.landmines[idx]!;
  g.landmines.splice(idx, 1);
  if (walkerId === REPLAY_BEAST) {
    const evt = applyBeastDamage(g, mine.ownerId, 4);
    return evt ? [evt] : [];
  }
  const victim = g.players.get(walkerId);
  if (!victim || victim.hp <= 0) return [];
  const evt = applyTrapDamageToPlayer(g, victim, 4, "地雷");
  return evt ? [evt] : [];
}

function logSonicRadarForPath(g: GameSession, actorId: string, path: Array<{ col: number; row: number }>): void {
  const mover = g.players.get(actorId);
  if (!mover || path.length === 0) return;
  for (const radar of g.sonicRadars) {
    const zone = new Set(
      cellsInChebyshevDisk(radar.col, radar.row, 4, g.gridSize).map((c) => cellKey(c.col, c.row))
    );
    const touches = path.some((step) => zone.has(cellKey(step.col, step.row)));
    if (touches) {
      const labels = path.map((s) => formatCellLabel(s.col, s.row)).join(" → ");
      appendReplayLog(g, REPLAY_SYSTEM, `声波雷达：${mover.nickname} 在侦测区内移动 ${labels}`);
      return;
    }
  }
}

function cellHasLivingPlayer(g: GameSession, col: number, row: number): boolean {
  return [...g.players.values()].some((p) => p.hp > 0 && p.col === col && p.row === row);
}

function cellBlockedForSkillPlacement(g: GameSession, col: number, row: number): boolean {
  if (!cellInPlayableArea(g, col, row) || cellIsWall(g, col, row)) return true;
  if (cellHasLivingPlayer(g, col, row)) return true;
  if (beastOccupies(g.beast, col, row)) return true;
  if (g.shadowClones.some((d) => d.col === col && d.row === row)) return true;
  if (g.pendingNukes.some((n) => n.col === col && n.row === row)) return true;
  if (g.landmines.some((m) => m.col === col && m.row === row)) return true;
  if (g.sonicRadars.some((r) => r.col === col && r.row === row)) return true;
  return false;
}

function resolveNukeExplosions(g: GameSession): void {
  const remain: PendingNukeState[] = [];
  for (const nuke of g.pendingNukes) {
    if (g.roundNumber <= nuke.placedRound) {
      remain.push(nuke);
      continue;
    }
    const cells = cellsInRectCenter(nuke.col, nuke.row, 2, g.gridSize);
    const events: DamageEvent[] = [];
    for (const cell of cells) {
      events.push(...damageShadowDecoysOnCell(g, nuke.ownerId, cell.col, cell.row, "核弹"));
      events.push(...damageSonicRadarsOnCell(g, nuke.ownerId, cell.col, cell.row, 8, "核弹"));
      events.push(...damageEnemiesOnCell(g, nuke.ownerId, cell.col, cell.row, 8, "核弹"));
      events.push(...damageBeastOnCells(g, nuke.ownerId, [cell], 8));
    }
    appendReplayLog(
      g,
      REPLAY_SYSTEM,
      `核弹爆炸（${formatCellLabel(nuke.col, nuke.row)}）`,
      formatDamageEvents(events),
      events
    );
    eliminateAllDeadFromTurn(g, { skipTurnCallbacks: true });
  }
  g.pendingNukes = remain;
}

/** 对格内所有敌方存活单位造成伤害（允许多人同格） */
function damageEnemiesOnCell(
  g: GameSession,
  actorId: string,
  col: number,
  row: number,
  dmg: number,
  operation: string
): DamageEvent[] {
  const events: DamageEvent[] = [];
  for (const pl of g.players.values()) {
    if (pl.hp > 0 && pl.col === col && pl.row === row && pl.socketId !== actorId && !sameTeam(g, actorId, pl.socketId)) {
      const evt = applyDirectDamage(g, actorId, pl, dmg, operation);
      if (evt) events.push(evt);
    }
  }
  return events;
}

function damageShadowDecoysOnCell(
  g: GameSession,
  actorId: string,
  col: number,
  row: number,
  operation: string
): DamageEvent[] {
  const events: DamageEvent[] = [];
  const actor = g.players.get(actorId);
  g.shadowClones = g.shadowClones.filter((d) => {
    if (d.col !== col || d.row !== row) return true;
    if (sameTeam(g, actorId, d.ownerId)) return true;
    const owner = g.players.get(d.ownerId);
    events.push({
      sourceId: actorId,
      sourceNickname: actor?.nickname ?? (actorId === REPLAY_BEAST ? "巨兽" : "系统"),
      targetId: d.id,
      targetNickname: `影分身(${owner?.nickname ?? "?"})`,
      amount: 1,
      operation,
    });
    return false;
  });
  return events;
}

function damageSonicRadarsOnCell(
  g: GameSession,
  actorId: string,
  col: number,
  row: number,
  rawDmg: number,
  operation: string
): DamageEvent[] {
  const events: DamageEvent[] = [];
  const actor = g.players.get(actorId);
  for (let i = g.sonicRadars.length - 1; i >= 0; i--) {
    const r = g.sonicRadars[i]!;
    if (r.col !== col || r.row !== row) continue;
    const prevHp = r.hp;
    r.hp -= rawDmg;
    events.push({
      sourceId: actorId,
      sourceNickname: actor?.nickname ?? (actorId === REPLAY_BEAST ? "巨兽" : "系统"),
      targetId: r.id,
      targetNickname: "声波雷达",
      amount: Math.min(rawDmg, prevHp),
      operation,
    });
    if (r.hp <= 0) g.sonicRadars.splice(i, 1);
    break;
  }
  return events;
}

function applyDirectDamage(
  g: GameSession,
  actorId: string,
  target: GamePlayer,
  dmg: number,
  operation: string
): DamageEvent | null {
  if (target.hp <= 0) return null;
  if (actorId !== REPLAY_SYSTEM && actorId !== REPLAY_BEAST) {
    if (sameTeam(g, actorId, target.socketId)) return null;
  }
  const actor =
    actorId !== REPLAY_SYSTEM && actorId !== REPLAY_BEAST ? g.players.get(actorId) : undefined;
  let raw = skillDamageAmountFor(g, actorId, dmg);
  const preBell = raw;

  const bellActive =
    target.goldenBellForRound != null && target.goldenBellForRound === g.roundNumber;
  if (bellActive) {
    raw = Math.max(0, raw - 3);
    if (actor && actorId !== REPLAY_BEAST && actorId !== REPLAY_SYSTEM && preBell > 0) {
      const thru = g.roundNumber + 1;
      actor.markedExposeUntilRound =
        actor.markedExposeUntilRound == null
          ? thru
          : Math.max(actor.markedExposeUntilRound, thru);
    }
  }

  const bladeIdx = target.skills.indexOf("blade_escape");
  if (bladeIdx >= 0 && raw > 0 && target.hp - raw <= 0) {
    const oldHp = target.hp;
    target.skills.splice(bladeIdx, 1);
    target.hp = 1;
    return {
      sourceId: actorId,
      sourceNickname: actor?.nickname ?? (actorId === REPLAY_BEAST ? "巨兽" : "系统"),
      targetId: target.socketId,
      targetNickname: target.nickname,
      amount: Math.max(0, oldHp - 1),
      operation,
      deathCause: undefined,
    };
  }

  if (raw <= 0) return null;

  const amount = Math.min(raw, target.hp);
  target.hp = Math.max(0, target.hp - raw);
  if (target.hp <= 0 && !target.deathCause) target.deathCause = deathCauseFor(g, actorId, operation);
  if (amount <= 0) return null;
  const deathCause = target.hp <= 0 ? (target.deathCause ?? deathCauseFor(g, actorId, operation)) : undefined;
  return {
    sourceId: actorId,
    sourceNickname: actor?.nickname ?? (actorId === REPLAY_BEAST ? "巨兽" : "系统"),
    targetId: target.socketId,
    targetNickname: target.nickname,
    amount,
    operation,
    deathCause,
  };
}

function applyTrapDamageToPlayer(
  g: GameSession,
  target: GamePlayer,
  dmg: number,
  operation: string
): DamageEvent | null {
  return applyDirectDamage(g, REPLAY_SYSTEM, target, dmg, operation);
}

function applyBeastDamage(g: GameSession, actorId: string, dmg: number): DamageEvent | null {
  const beast = g.beast;
  if (!beast || beast.hp <= 0) return null;
  const actor = g.players.get(actorId);
  const finalDmg = damageAmountFor(g, actorId, dmg);
  const amount = Math.min(finalDmg, beast.hp);
  beast.hp = Math.max(0, beast.hp - finalDmg);
  if (amount <= 0) return null;
  const evt: DamageEvent = {
    sourceId: actorId,
    sourceNickname: actor?.nickname ?? "?",
    targetId: REPLAY_BEAST,
    targetNickname: "巨兽",
    amount,
  };
  if (beast.hp <= 0 && actor) {
    actor.hp = Math.min(sessionMaxHp(g), actor.hp + 4);
    actor.stamina = Math.min(sessionMaxStamina(g), actor.stamina + 3);
    actor.damageBonus += 1;
    appendReplayLog(g, actorId, `击杀巨兽：${actor.nickname} 获得生命、体力与伤害加成`);
  }
  return evt;
}

function damageBeastOnCells(
  g: GameSession,
  actorId: string,
  cells: Array<{ col: number; row: number }>,
  dmg: number
): DamageEvent[] {
  const beast = g.beast;
  if (!beast || beast.hp <= 0) return [];
  if (!cells.some((cell) => beastOccupies(beast, cell.col, cell.row))) return [];
  const evt = applyBeastDamage(g, actorId, dmg);
  return evt ? [evt] : [];
}

function formatDamageEvents(events: DamageEvent[]): string | undefined {
  if (events.length === 0) return undefined;
  const grouped = new Map<string, { nickname: string; amount: number }>();
  for (const e of events) {
    const prev = grouped.get(e.targetId);
    if (prev) prev.amount += e.amount;
    else grouped.set(e.targetId, { nickname: e.targetNickname, amount: e.amount });
  }
  return [...grouped.values()].map((e) => `${e.nickname} -${e.amount} 生命`).join("；");
}

export type GameAction =
  | { kind: "move"; path: Array<{ col: number; row: number }> }
  | { kind: "attack"; col: number; row: number }
  | { kind: "rest"; mode: "hp" | "stamina" }
  | { kind: "learn"; confirmOverwrite?: boolean }
  | { kind: "skill"; skillId: SkillId; payload: Record<string, unknown> }
  | { kind: "endTurn" };

type ActionOkData = {
  learnedSkill?: { id: SkillId; name: string };
  overwrittenSkill?: { id: SkillId; name: string };
};

export function applyGameAction(
  g: GameSession,
  actorId: string,
  action: GameAction
): { ok: true; data?: ActionOkData } | { ok: false; error: string } {
  if (g.phase !== "playing") return { ok: false, error: "游戏已结束" };
  if (g.beastTurnPending) return { ok: false, error: "巨兽的回合" };
  const isBotActor = actorId.startsWith("bot:");
  if (
    !isBotActor &&
    g.turnDeadlineAt &&
    Date.now() > g.turnDeadlineAt &&
    action.kind !== "endTurn"
  ) {
    return { ok: false, error: "行动时间已结束" };
  }
  if (currentPlayerId(g) !== actorId) return { ok: false, error: "当前不是你的回合" };
  const p = g.players.get(actorId);
  if (!p || p.hp <= 0) return { ok: false, error: "你已出局" };
  const tf = g.turnFlags.get(actorId)!;
  const n = g.gridSize;

  if (tf.didRest) return { ok: false, error: "本回合已休息" };

  if (action.kind === "endTurn") {
    appendReplayLog(g, actorId, "结束回合");
    endTurn(g);
    return { ok: true };
  }

  switch (action.kind) {
    case "move": {
      if (tf.didRest) return { ok: false, error: "已休息，无法移动" };
      const path = action.path;
      if (!path.length) return { ok: false, error: "路径为空" };
      let c = p.col;
      let r = p.row;
      let cost = 0;
      const visited: Array<{ col: number; row: number }> = [];
      for (const step of path) {
        if (manhattan({ col: c, row: r }, step) !== 1) return { ok: false, error: "只能横竖相邻移动" };
        if (!inBounds(step.col, step.row, n)) return { ok: false, error: "越界" };
        if (!cellInPlayableArea(g, step.col, step.row))
          return { ok: false, error: "无法进入已消失的格子" };
        if (cellIsWall(g, step.col, step.row)) return { ok: false, error: "墙壁不可通行" };
        if (beastOccupies(g.beast, step.col, step.row)) return { ok: false, error: "巨兽所在区域不可通行" };
        c = step.col;
        r = step.row;
        cost++;
        visited.push({ col: c, row: r });
        const mineEv = triggerLandminesAt(g, actorId, c, r);
        if (mineEv.length > 0) {
          if (p.stamina < cost) return { ok: false, error: "体力不足" };
          p.stamina -= cost;
          p.col = c;
          p.row = r;
          tf.didMove = true;
          appendReplayLog(
            g,
            actorId,
            `移动至 ${formatCellLabel(c, r)}（地雷）`,
            formatDamageEvents(mineEv),
            mineEv
          );
          eliminateAllDeadFromTurn(g);
          logSonicRadarForPath(g, actorId, visited);
          return { ok: true };
        }
      }
      if (p.stamina < cost) return { ok: false, error: "体力不足" };
      p.stamina -= cost;
      p.col = c;
      p.row = r;
      tf.didMove = true;
      appendReplayLog(g, actorId, `移动至 ${formatCellLabel(p.col, p.row)}`);
      logSonicRadarForPath(g, actorId, visited);
      return { ok: true };
    }
    case "attack": {
      if (tf.didAttack === false && (tf.learnCount > 0 || tf.skillIdsUsed.length > 0)) {
        return { ok: false, error: "本回合已学习或使用技能，不能攻击" };
      }
      if (!cellInPlayableArea(g, action.col, action.row))
        return { ok: false, error: "目标区域无效" };
      if (chebyshev(p, { col: action.col, row: action.row }) > ATTACK_RANGE) {
        return { ok: false, error: "目标超出攻击距离" };
      }
      if (p.stamina < ATTACK_COST) return { ok: false, error: "体力不足" };
      p.stamina -= ATTACK_COST;
      tf.didAttack = true;
      if (p.stealthActive) p.stealthActive = false;
      const ad = sessionAttackDamage(g);
      const damageEvents = [
        ...damageShadowDecoysOnCell(g, actorId, action.col, action.row, "普通攻击"),
        ...damageSonicRadarsOnCell(g, actorId, action.col, action.row, ad, "普通攻击"),
        ...damageEnemiesOnCell(g, actorId, action.col, action.row, ad, "普通攻击"),
        ...damageBeastOnCells(g, actorId, [{ col: action.col, row: action.row }], ad),
      ];
      eliminateAllDeadFromTurn(g);
      appendReplayLog(
        g,
        actorId,
        `攻击 ${formatCellLabel(action.col, action.row)}`,
        formatDamageEvents(damageEvents),
        damageEvents
      );
      return { ok: true };
    }
    case "rest": {
      if (tf.didMove || tf.didAttack || tf.learnCount > 0 || tf.skillIdsUsed.length > 0) {
        return { ok: false, error: "已行动过，无法休息" };
      }
      const mode = String((action as { mode?: string }).mode ?? "");
      if (mode === "hp") {
        const rh = g.rules.restHp;
        if (rh <= 0) return { ok: false, error: "本局休息不可恢复生命" };
        if (p.hp >= sessionMaxHp(g)) return { ok: false, error: "生命已达上限，无法恢复" };
        p.hp = Math.min(sessionMaxHp(g), p.hp + rh);
      } else {
        const rst = g.rules.restStamina;
        if (rst <= 0) return { ok: false, error: "本局休息不可恢复体力" };
        if (p.stamina >= sessionMaxStamina(g)) return { ok: false, error: "体力已达上限，无法恢复" };
        p.stamina = Math.min(sessionMaxStamina(g), p.stamina + rst);
      }
      tf.didRest = true;
      appendReplayLog(
        g,
        actorId,
        mode === "hp"
          ? `休息：恢复 ${g.rules.restHp} 点生命`
          : `休息：恢复 ${g.rules.restStamina} 点体力`
      );
      endTurn(g);
      return { ok: true };
    }
    case "learn": {
      if (tf.didAttack) return { ok: false, error: "本回合已攻击，无法学习" };
      if (tf.learnCount >= 2) return { ok: false, error: "本回合学习次数已满" };
      if (p.stamina < 3) return { ok: false, error: "体力不足" };
      if (p.skills.length >= 5 && !action.confirmOverwrite) {
        return { ok: false, error: "已拥有5个技能，继续学习将随机覆盖一个技能" };
      }
      const pool = g.rules.learnableSkills;
      let choices = pool.filter((s) => !p.skills.includes(s));
      let overwritten: SkillId | undefined;
      if (choices.length === 0 && p.skills.length > 0) {
        overwritten = p.skills.splice(Math.floor(Math.random() * p.skills.length), 1)[0];
        choices = pool.filter((s) => !p.skills.includes(s));
      }
      if (choices.length === 0) return { ok: false, error: "无法学习技能" };
      if (p.skills.length >= 5) {
        overwritten = p.skills.splice(Math.floor(Math.random() * p.skills.length), 1)[0];
      }
      const sk = choices[Math.floor(Math.random() * choices.length)]!;
      p.skills.push(sk);
      p.stamina -= 3;
      tf.learnCount++;
      appendReplayLog(g, actorId, `学习技能：${SKILL_META[sk].name}`);
      return {
        ok: true,
        data: {
          learnedSkill: { id: sk, name: SKILL_META[sk].name },
          overwrittenSkill: overwritten ? { id: overwritten, name: SKILL_META[overwritten].name } : undefined,
        },
      };
    }
    case "skill": {
      if (tf.didAttack) return { ok: false, error: "本回合已攻击，无法使用技能" };
      if (tf.skillIdsUsed.length >= 2) return { ok: false, error: "本回合技能次数已满" };
      if (tf.skillIdsUsed.includes(action.skillId)) return { ok: false, error: "不能重复使用同一技能" };
      const sk = action.skillId;
      if (!p.skills.includes(sk)) return { ok: false, error: "未掌握该技能" };
      if (!canUseSkill(g, actorId, sk)) return { ok: false, error: "技能冷却中" };
      const staminaCost = skillStaminaCost(g, actorId, sk);
      if (p.stamina < staminaCost) return { ok: false, error: "体力不足" };
      const res = executeSkill(g, actorId, sk, action.payload);
      if (!res.ok) return res;
      p.stamina -= staminaCost;
      p.lastSkillAtTurn[sk] = p.turnSerial;
      tf.skillIdsUsed.push(sk);
      if (p.stealthActive && sk !== "stealth") p.stealthActive = false;
      eliminateAllDeadFromTurn(g);
      appendReplayLog(
        g,
        actorId,
        `使用技能：${SKILL_META[sk].name}`,
        formatDamageEvents(res.damageEvents ?? []),
        res.damageEvents
      );
      return { ok: true };
    }
  }
  return { ok: false, error: "未知操作" };
}

export function timeoutCurrentTurn(g: GameSession, expectedSeq: number): { ok: true; actorId: string } | { ok: false } {
  if (g.phase !== "playing" || g.beastTurnPending || g.turnTimerSeq !== expectedSeq) return { ok: false };
  const actorId = currentPlayerId(g);
  const p = g.players.get(actorId);
  if (!p || p.hp <= 0) return { ok: false };
  appendReplayLog(g, actorId, "行动超时，自动结束回合");
  endTurn(g);
  return { ok: true, actorId };
}

function executeSkill(
  g: GameSession,
  actorId: string,
  sk: SkillId,
  payload: Record<string, unknown>
): { ok: true; damageEvents?: DamageEvent[] } | { ok: false; error: string } {
  const p = g.players.get(actorId)!;
  const n = g.gridSize;

  switch (sk) {
    case "laser": {
      const di = Number(payload.dc);
      const dj = Number(payload.dr);
      const okDir = OCT_DIRS.some(([a, b]) => a === di && b === dj);
      if (!okDir) return { ok: false, error: "无效方向" };
      const cells = rayFrom(p.col, p.row, di, dj, n);
      const damageEvents: DamageEvent[] = [];
      for (const cell of cells) {
        damageEvents.push(...damageShadowDecoysOnCell(g, actorId, cell.col, cell.row, "激光"));
        damageEvents.push(...damageSonicRadarsOnCell(g, actorId, cell.col, cell.row, 4, "激光"));
        damageEvents.push(...damageEnemiesOnCell(g, actorId, cell.col, cell.row, 4, "激光"));
      }
      damageEvents.push(...damageBeastOnCells(g, actorId, cells, 4));
      return { ok: true, damageEvents };
    }
    case "missile": {
      const col = Number(payload.col);
      const row = Number(payload.row);
      if (!inBounds(col, row, n)) return { ok: false, error: "无效坐标" };
      if (!cellInPlayableArea(g, col, row)) return { ok: false, error: "该格已不在安全区内" };
      const damageEvents: DamageEvent[] = [];
      const cells = cellsInRectCenter(col, row, 1, n);
      for (const cell of cells) {
        damageEvents.push(...damageShadowDecoysOnCell(g, actorId, cell.col, cell.row, "导弹"));
        damageEvents.push(...damageSonicRadarsOnCell(g, actorId, cell.col, cell.row, 4, "导弹"));
        damageEvents.push(...damageEnemiesOnCell(g, actorId, cell.col, cell.row, 4, "导弹"));
      }
      damageEvents.push(...damageBeastOnCells(g, actorId, cells, 4));
      return { ok: true, damageEvents };
    }
    case "sniper": {
      const col = Number(payload.col);
      const row = Number(payload.row);
      if (!inBounds(col, row, n)) return { ok: false, error: "无效坐标" };
      if (!cellInPlayableArea(g, col, row)) return { ok: false, error: "该格已不在安全区内" };
      const pre: DamageEvent[] = [
        ...damageShadowDecoysOnCell(g, actorId, col, row, "狙击"),
        ...damageSonicRadarsOnCell(g, actorId, col, row, 6, "狙击"),
      ];
      const tgt = [...g.players.values()].find(
        (x) => x.hp > 0 && x.col === col && x.row === row && x.socketId !== actorId && !sameTeam(g, actorId, x.socketId)
      );
      if (!tgt && !beastOccupies(g.beast, col, row)) {
        // 允许对空格释放（空枪），仍消耗体力与进入冷却
        return { ok: true, damageEvents: [...pre, ...damageBeastOnCells(g, actorId, [{ col, row }], 6)] };
      }
      if (!tgt) return { ok: true, damageEvents: [...pre, ...damageBeastOnCells(g, actorId, [{ col, row }], 6)] };
      const evt = applyDirectDamage(g, actorId, tgt, 6, "狙击");
      return {
        ok: true,
        damageEvents: [...pre, ...(evt ? [evt] : []), ...damageBeastOnCells(g, actorId, [{ col, row }], 6)],
      };
    }
    case "flare": {
      const col = Number(payload.col);
      const row = Number(payload.row);
      if (!inBounds(col, row, n)) return { ok: false, error: "无效坐标" };
      if (!cellInPlayableArea(g, col, row)) return { ok: false, error: "该格已不在安全区内" };
      g.flareZones.push({ centerCol: col, centerRow: row, ownerId: actorId });
      return { ok: true };
    }
    case "burn": {
      const col = Number(payload.col);
      const row = Number(payload.row);
      if (!inBounds(col, row, n)) return { ok: false, error: "无效坐标" };
      if (!cellInPlayableArea(g, col, row)) return { ok: false, error: "该格已不在安全区内" };
      g.burningZones.push({ centerCol: col, centerRow: row, ownerId: actorId, roundsLeft: 2 });
      return { ok: true };
    }
    case "bounty": {
      const targetId = String(payload.targetId ?? "");
      if (!g.players.has(targetId) || targetId === actorId) return { ok: false, error: "无效目标" };
      if (sameTeam(g, actorId, targetId)) return { ok: false, error: "不能对队友发布悬赏" };
      const vis = visibleKeysForViewer(g, actorId);
      const tgt = g.players.get(targetId)!;
      if (tgt.hp <= 0) return { ok: false, error: "无效目标" };
      if (!vis.has(cellKey(tgt.col, tgt.row))) return { ok: false, error: "看不到该玩家" };
      g.bountyPairs.push({ aId: actorId, bId: targetId, roundsLeft: 3 });
      const a = g.players.get(actorId)!;
      const b = g.players.get(targetId)!;
      a.bountyPartnerId = targetId;
      b.bountyPartnerId = actorId;
      return { ok: true };
    }
    case "stealth": {
      p.stealthActive = true;
      return { ok: true };
    }
    case "jet": {
      const col = Number(payload.col);
      const row = Number(payload.row);
      if (!inBounds(col, row, n)) return { ok: false, error: "无效坐标" };
      if (!cellInPlayableArea(g, col, row)) return { ok: false, error: "无法落在禁区外" };
      if (cellIsWall(g, col, row)) return { ok: false, error: "墙壁不可通行" };
      if (beastOccupies(g.beast, col, row)) return { ok: false, error: "巨兽所在区域不可通行" };
      if (chebyshev(p, { col, row }) > 8) return { ok: false, error: "超出喷射距离" };
      p.col = col;
      p.row = row;
      return { ok: true };
    }
    case "jump": {
      const col = Number(payload.col);
      const row = Number(payload.row);
      if (!inBounds(col, row, n)) return { ok: false, error: "无效坐标" };
      if (!cellInPlayableArea(g, col, row)) return { ok: false, error: "无法落在禁区外" };
      if (cellIsWall(g, col, row)) return { ok: false, error: "墙壁不可通行" };
      if (beastOccupies(g.beast, col, row)) return { ok: false, error: "巨兽所在区域不可通行" };
      p.col = col;
      p.row = row;
      return { ok: true };
    }
    case "execute": {
      const targetId = String(payload.targetId ?? "");
      const tgt = g.players.get(targetId);
      if (!tgt || tgt.hp <= 0) return { ok: false, error: "无效目标" };
      if (sameTeam(g, actorId, targetId)) return { ok: false, error: "不能攻击队友" };
      /** 以自身为中心的 3×3（切比雪夫距离 ≤1，不含与自身同格） */
      if (tgt.col === p.col && tgt.row === p.row) return { ok: false, error: "无效目标" };
      if (chebyshev(p, tgt) > 1) return { ok: false, error: "目标须在以自身为中心的 3×3 范围内" };
      const evt = applyDirectDamage(g, actorId, tgt, 7, "斩首");
      return { ok: true, damageEvents: evt ? [evt] : [] };
    }
    case "shadow_clone": {
      const col = Number(payload.col);
      const row = Number(payload.row);
      if (!inBounds(col, row, n)) return { ok: false, error: "无效坐标" };
      if (chebyshev(p, { col, row }) > 3) return { ok: false, error: "超出影分身放置距离" };
      if (cellBlockedForSkillPlacement(g, col, row)) return { ok: false, error: "该格无法放置" };
      const id = `clone:${randomUUID()}`;
      g.shadowClones.push({ id, ownerId: actorId, col, row, roundsLeft: 2 });
      return { ok: true };
    }
    case "golden_bell": {
      p.goldenBellForRound = g.roundNumber + 1;
      return { ok: true };
    }
    case "blade_escape":
      return { ok: false, error: "被动技能，无法主动使用" };
    case "nuke": {
      const col = Number(payload.col);
      const row = Number(payload.row);
      if (!inBounds(col, row, n)) return { ok: false, error: "无效坐标" };
      if (cellBlockedForSkillPlacement(g, col, row)) return { ok: false, error: "该格无法放置" };
      const id = `nuke:${randomUUID()}`;
      g.pendingNukes.push({ id, ownerId: actorId, col, row, placedRound: g.roundNumber });
      appendReplayLog(
        g,
        REPLAY_SYSTEM,
        `核弹预警：${formatCellLabel(col, row)} 将于下一轮在 5×5 范围内爆炸`
      );
      return { ok: true };
    }
    case "landmine": {
      const col = Number(payload.col);
      const row = Number(payload.row);
      if (!inBounds(col, row, n)) return { ok: false, error: "无效坐标" };
      if (chebyshev(p, { col, row }) > 2) return { ok: false, error: "超出地雷放置距离" };
      if (cellBlockedForSkillPlacement(g, col, row)) return { ok: false, error: "该格无法放置" };
      if (g.landmines.filter((m) => m.ownerId === actorId).length >= 2)
        return { ok: false, error: "场上最多保留 2 枚地雷" };
      const id = `mine:${randomUUID()}`;
      g.landmines.push({ id, ownerId: actorId, col, row });
      return { ok: true };
    }
    case "sonic_radar": {
      const col = Number(payload.col);
      const row = Number(payload.row);
      if (!inBounds(col, row, n)) return { ok: false, error: "无效坐标" };
      if (cellBlockedForSkillPlacement(g, col, row)) return { ok: false, error: "该格无法放置" };
      const id = `radar:${randomUUID()}`;
      g.sonicRadars.push({ id, ownerId: actorId, col, row, roundsLeft: 1, hp: 3 });
      return { ok: true };
    }
    default:
      return { ok: false, error: "未知技能" };
  }
}

/** 可见坐标集合（战争迷雾：视野半径 + 照明弹 + 悬赏透视对手） */
export function visibleKeysForViewer(g: GameSession, viewerId: string): Set<string> {
  const set = new Set<string>();
  const me = g.players.get(viewerId);
  if (!me || me.hp <= 0) return set;
  const n = g.gridSize;

  const addRadius = (c: number, r: number, rad: number) => {
    for (let dc = -rad; dc <= rad; dc++) {
      for (let dr = -rad; dr <= rad; dr++) {
        if (Math.abs(dc) + Math.abs(dr) <= rad) {
          const cc = c + dc;
          const rr = r + dr;
          if (inBounds(cc, rr, n)) set.add(cellKey(cc, rr));
        }
      }
    }
  };

  /** 高级电脑：自身视野半径 +2（曼哈顿菱形） */
  const selfVisionRad =
    me.botDifficulty === "hard" && me.socketId.startsWith("bot:")
      ? VISION_RADIUS + 2
      : VISION_RADIUS;
  addRadius(me.col, me.row, selfVisionRad);

  if (g.teamSize > 1) {
    for (const mate of g.players.values()) {
      if (mate.socketId !== viewerId && mate.hp > 0 && mate.teamId === me.teamId) {
        addRadius(mate.col, mate.row, VISION_RADIUS);
      }
    }
  }

  for (const f of g.flareZones) {
    for (const cell of cellsInRectCenter(f.centerCol, f.centerRow, 2, n)) {
      set.add(cellKey(cell.col, cell.row));
    }
  }

  const bounty = g.bountyPairs.find((b) => b.aId === viewerId || b.bId === viewerId);
  if (bounty) {
    const other = bounty.aId === viewerId ? bounty.bId : bounty.aId;
    const op = g.players.get(other);
    if (op && op.hp > 0) addRadius(op.col, op.row, VISION_RADIUS);
  }

  return set;
}

export function serializePublicPlayer(
  g: GameSession,
  viewerId: string,
  pl: GamePlayer,
  visible: Set<string>,
  opts?: { spectatorVision?: boolean; roomAvatarBySocket?: Map<string, string> }
): Record<string, unknown> {
  const k = cellKey(pl.col, pl.row);
  const seeCell = visible.has(k);
  const bountySee = g.bountyPairs.some(
    (b) =>
      (b.aId === viewerId && b.bId === pl.socketId) ||
      (b.bId === viewerId && b.aId === pl.socketId)
  );
  const forceExpose =
    pl.markedExposeUntilRound != null && g.roundNumber <= pl.markedExposeUntilRound;
  const canSeePosition =
    Boolean(opts?.spectatorVision) ||
    pl.socketId === viewerId ||
    bountySee ||
    forceExpose ||
    (seeCell && !pl.stealthActive);

  const avatarOut = opts?.roomAvatarBySocket?.get(pl.socketId) ?? pl.avatar;

  return {
    socketId: pl.socketId,
    slotIndex: pl.slotIndex,
    teamId: pl.teamId,
    nickname: pl.nickname,
    avatar: avatarOut,
    hp: pl.hp,
    stamina: pl.socketId === viewerId ? pl.stamina : undefined,
    col: canSeePosition ? pl.col : null,
    row: canSeePosition ? pl.row : null,
    gridLabel: canSeePosition ? formatCellLabel(pl.col, pl.row) : null,
    skills: pl.socketId === viewerId ? pl.skills : pl.skills.map(() => "?"),
    stealthActive: pl.socketId === viewerId ? pl.stealthActive : pl.stealthActive && !canSeePosition,
    eliminated: pl.hp <= 0,
    skipNextTurn: pl.socketId === viewerId ? pl.skipNextTurn : undefined,
    damageBonus: pl.socketId === viewerId ? pl.damageBonus : undefined,
  };
}

export type BuildGamePayloadOpts = {
  roomAvatarBySocket?: Map<string, string>;
  spectatorMode?: boolean;
  /** 房间内已点「观战」的人数（所有客户端一致展示） */
  watchingSpectatorCount?: number;
};

/** 核弹全局预警：锚点格 + 与爆炸判定一致的 5×5（half=2）范围 */
function pendingNukeWarningKeys(g: GameSession): string[] {
  const set = new Set<string>();
  const n = g.gridSize;
  for (const nu of g.pendingNukes) {
    for (const cell of cellsInRectCenter(nu.col, nu.row, 2, n)) {
      set.add(cellKey(cell.col, cell.row));
    }
  }
  return [...set];
}

export function buildGamePayload(g: GameSession, viewerId: string, opts?: BuildGamePayloadOpts) {
  const spectator = opts?.spectatorMode === true;
  const me = g.players.get(viewerId);
  const deadSpectating = Boolean(!spectator && me && me.hp <= 0 && g.phase === "playing");
  const effectiveVision = spectator || deadSpectating;
  const visible = effectiveVision ? allGridKeys(g.gridSize) : visibleKeysForViewer(g, viewerId);
  const serOpts = { spectatorVision: effectiveVision, roomAvatarBySocket: opts?.roomAvatarBySocket };
  const players = [...g.players.values()].map((pl) =>
    serializePublicPlayer(g, viewerId, pl, visible, serOpts)
  );

  const tf = !spectator && !deadSpectating ? g.turnFlags.get(viewerId) : undefined;
  const mySkillCooldowns: Partial<Record<SkillId, number>> = {};
  if (!spectator && !deadSpectating && me && me.hp > 0) {
    for (const sk of me.skills) {
      const r = skillRoundsRemaining(me, sk);
      if (r > 0) mySkillCooldowns[sk] = r;
    }
  }

  let winnerNickname: string | null = null;
  if (g.phase === "ended" && g.winnerId) {
    winnerNickname = g.players.get(g.winnerId)?.nickname ?? null;
  }

  const ranking =
    g.phase === "ended"
      ? buildRanking(g)
      : undefined;

  const burningCellKeys: string[] = [];
  const burnSet = new Set<string>();
  for (const z of g.burningZones) {
    for (const cell of cellsInRectCenter(z.centerCol, z.centerRow, 1, g.gridSize)) {
      const ck = cellKey(cell.col, cell.row);
      if (!burnSet.has(ck)) {
        burnSet.add(ck);
        burningCellKeys.push(ck);
      }
    }
  }

  const last = g.replayLog[g.replayLog.length - 1];
  const mapEvent = g.mapEvent
    ? {
        ...g.mapEvent,
        cellKeys: eventCellKeys(g.mapEvent, g.gridSize),
      }
    : null;
  const beast =
    g.beast && g.beast.hp > 0
      ? {
          col: g.beast.col,
          row: g.beast.row,
          hp: g.beast.hp,
          maxHp: g.beast.maxHp,
          cellKeys: beastCellKeys(g.beast),
          spawnedRound: g.beast.spawnedRound,
        }
      : null;

  const showSpectatorFeed = spectator || deadSpectating;
  const isBeastTurn = g.beastTurnPending && Boolean(beast);
  const currentTurnId = isBeastTurn ? REPLAY_BEAST : g.turnOrder.length === 0 ? (g.winnerId ?? "") : currentPlayerId(g);
  const currentTurnIndex = g.turnOrder.indexOf(currentTurnId);
  const nextTurnId = isBeastTurn
    ? (g.turnOrder[0] ?? null)
    : currentTurnIndex >= 0 && g.turnOrder.length > 1
      ? g.turnOrder[(currentTurnIndex + 1) % g.turnOrder.length]
      : null;

  return {
    roomCode: g.roomCode,
    gridSize: g.gridSize,
    matchMode: g.matchMode,
    matchModeLabel: g.matchModeLabel,
    teamSize: g.teamSize,
    gameRules: {
      maxHp: g.rules.maxHp,
      maxStamina: g.rules.maxStamina,
      restHp: g.rules.restHp,
      restStamina: g.rules.restStamina,
      attackDamage: g.rules.attackDamage,
    },
    roundNumber: g.roundNumber,
    shrinkMargin: g.shrinkMargin,
    turnOf: currentTurnId,
    isMyTurn:
      !spectator &&
      !deadSpectating &&
      !isBeastTurn &&
      currentTurnId === viewerId &&
      (g.players.get(viewerId)?.hp ?? 0) > 0,
    isBeastTurn,
    turnDeadlineAt: isBeastTurn ? null : g.turnDeadlineAt,
    phase: g.phase,
    players,
    visibleCells: [...visible],
    wallKeys: g.wallKeys,
    poisonWarningKeys: g.poisonWarningKeys,
    turnFlags: tf,
    skillMeta: SKILL_META,
    winnerId: g.winnerId,
    winnerNickname,
    mySkillCooldowns,
    ranking,
    burningCellKeys,
    mapEvent,
    beast,
    isSpectator: spectator || deadSpectating,
    isEliminatedSpectator: deadSpectating,
    turnOrderNicknames: [...g.turnOrder.map((id) => g.players.get(id)?.nickname ?? "?"), ...(beast ? ["巨兽"] : [])],
    currentTurnNickname: isBeastTurn ? "巨兽" : currentTurnId ? (g.players.get(currentTurnId)?.nickname ?? "?") : undefined,
    nextTurnNickname: nextTurnId ? (g.players.get(nextTurnId)?.nickname ?? "?") : undefined,
    spectatorLastSummary: showSpectatorFeed ? (last?.summary ?? "") : undefined,
    replayLog: g.replayLog,
    myResumeToken: !spectator && !deadSpectating && me && me.hp > 0 ? me.resumeToken : undefined,
    watchingSpectatorCount: opts?.watchingSpectatorCount ?? 0,
    nukeWarningKeys: pendingNukeWarningKeys(g),
    allyLandmineKeys: me
      ? g.landmines
          .filter((m) => m.ownerId === viewerId || sameTeam(g, m.ownerId, viewerId))
          .map((m) => cellKey(m.col, m.row))
      : [],
    sonicRadarCells: g.sonicRadars.map((r) => ({
      id: r.id,
      col: r.col,
      row: r.row,
      hp: r.hp,
      zoneKeys: cellsInChebyshevDisk(r.col, r.row, 4, g.gridSize).map((c) => cellKey(c.col, c.row)),
    })),
    shadowClones: g.shadowClones.map((d) => {
      const owner = g.players.get(d.ownerId);
      return {
        id: d.id,
        col: d.col,
        row: d.row,
        ownerSocketId: d.ownerId,
        nickname: owner?.nickname ?? "?",
        avatar: owner?.avatar ?? "",
      };
    }),
  };
}

export type RankingRow = {
  rank: number;
  socketId: string;
  nickname: string;
  avatar: string;
  resultText: string;
  resultKind: "win" | "death";
};

/** 第 1 名为获胜者；其后按淘汰倒序：最后出局者为第 2 名 */
export function buildRanking(g: GameSession): RankingRow[] {
  const out: RankingRow[] = [];
  const added = new Set<string>();
  let rank = 1;
  if (g.winnerId) {
    const w = g.players.get(g.winnerId);
    if (w) {
      const winners = g.teamSize > 1
        ? [...g.players.values()].filter((p) => p.teamId === w.teamId)
        : [w];
      for (const p of winners.sort((a, b) => a.slotIndex - b.slotIndex)) {
        out.push({
          rank: 1,
          socketId: p.socketId,
          nickname: p.nickname,
          avatar: p.avatar,
          resultText: "胜利",
          resultKind: "win",
        });
        added.add(p.socketId);
      }
      rank = 2;
    }
  }
  for (let i = g.eliminationOrder.length - 1; i >= 0; i--) {
    const id = g.eliminationOrder[i]!;
    if (added.has(id)) continue;
    const p = g.players.get(id);
    if (!p) continue;
    out.push({
      rank: rank++,
      socketId: id,
      nickname: p.nickname,
      avatar: p.avatar,
      resultText: inferDeathCause(g, id),
      resultKind: "death",
    });
    added.add(id);
  }
  for (const p of [...g.players.values()].sort((a, b) => a.slotIndex - b.slotIndex)) {
    if (added.has(p.socketId)) continue;
    out.push({
      rank: rank++,
      socketId: p.socketId,
      nickname: p.nickname,
      avatar: p.avatar,
      resultText: inferDeathCause(g, p.socketId),
      resultKind: "death",
    });
  }
  return out;
}

export function isBotSocketId(id: string): boolean {
  return id.startsWith("bot:");
}

/** 毒圈预警格 + 下一轮火山/地震预警格（甘霖不视为灾害） */
function botEnvironmentalHazardKeys(g: GameSession): Set<string> {
  const s = new Set<string>(g.poisonWarningKeys);
  const ev = g.mapEvent;
  if (ev && ev.phase === "warning" && (ev.kind === "volcano" || ev.kind === "earthquake")) {
    for (const k of eventCellKeys(ev, g.gridSize)) s.add(k);
  }
  return s;
}

/** 巨兽 melee：与其 2×2 躯体正交相邻的格子会受到巨兽攻击伤害 */
function botBeastMeleeThreatKeys(g: GameSession): Set<string> {
  const s = new Set<string>();
  const beast = g.beast;
  if (!beast || beast.hp <= 0) return s;
  const n = g.gridSize;
  for (const bk of beastCellKeys(beast)) {
    const { col, row } = parseKey(bk);
    for (const nb of orthogonalNeighbors(col, row, n)) {
      if (!beastOccupies(beast, nb.col, nb.row)) s.add(cellKey(nb.col, nb.row));
    }
  }
  return s;
}

/** 初/中级电脑优先躲避：环境灾害 + 巨兽威胁格 */
function botUrgentDangerKeys(g: GameSession): Set<string> {
  const s = botEnvironmentalHazardKeys(g);
  for (const k of botBeastMeleeThreatKeys(g)) s.add(k);
  return s;
}

function botWalkNeighborsRiskAware(
  g: GameSession,
  col: number,
  row: number,
  danger: Set<string>
): Array<{ col: number; row: number }> {
  const all = botWalkNeighbors(g, col, row);
  const safe = all.filter((c) => !danger.has(cellKey(c.col, c.row)));
  return safe.length > 0 ? safe : all;
}

function botBfsFirstStepAvoiding(
  g: GameSession,
  actorId: string,
  goal: { col: number; row: number },
  forbidden: Set<string>
): { col: number; row: number } | null {
  const p = g.players.get(actorId)!;
  const start = cellKey(p.col, p.row);
  const goalKey = cellKey(goal.col, goal.row);
  const prev = new Map<string, string>();
  const seen = new Set<string>([start]);
  const q: string[] = [start];
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi]!;
    const pos = parseKey(cur);
    for (const nb of botWalkNeighbors(g, pos.col, pos.row)) {
      const nk = cellKey(nb.col, nb.row);
      if (seen.has(nk)) continue;
      if (forbidden.has(nk) && nk !== goalKey) continue;
      seen.add(nk);
      prev.set(nk, cur);
      q.push(nk);
    }
  }
  if (!seen.has(goalKey)) return null;
  let cur = goalKey;
  while (prev.has(cur)) {
    const parent = prev.get(cur)!;
    if (parent === start) return parseKey(cur);
    cur = parent;
  }
  return null;
}

function botBfsFirstStepRiskAware(
  g: GameSession,
  actorId: string,
  goal: { col: number; row: number },
  danger: Set<string>
): { col: number; row: number } | null {
  const step = botBfsFirstStepAvoiding(g, actorId, goal, danger);
  if (step) return step;
  return botBfsFirstStep(g, actorId, goal);
}

/** 从当前格 BFS，走向任意非 urgent 危险格的第一步 */
function botFirstStepLeaveUrgentDanger(g: GameSession, actorId: string): { col: number; row: number } | null {
  const p = g.players.get(actorId)!;
  const danger = botUrgentDangerKeys(g);
  const start = cellKey(p.col, p.row);
  if (!danger.has(start)) return null;
  const prev = new Map<string, string>();
  const seen = new Set<string>([start]);
  const q: Array<{ col: number; row: number }> = [{ col: p.col, row: p.row }];
  for (let qi = 0; qi < q.length; qi++) {
    const pos = q[qi]!;
    for (const nb of botWalkNeighbors(g, pos.col, pos.row)) {
      const nk = cellKey(nb.col, nb.row);
      if (seen.has(nk)) continue;
      seen.add(nk);
      prev.set(nk, cellKey(pos.col, pos.row));
      if (!danger.has(nk)) {
        let cur = nk;
        while (prev.has(cur)) {
          const par = prev.get(cur)!;
          if (par === start) return parseKey(cur);
          cur = par;
        }
      }
      q.push(nb);
    }
  }
  return null;
}

function botTryFleeUrgentDanger(g: GameSession, actorId: string): GameAction | null {
  const p = g.players.get(actorId)!;
  const step = botFirstStepLeaveUrgentDanger(g, actorId);
  if (!step || manhattan(p, step) !== 1) return null;
  if (p.stamina < 1) return null;
  return { kind: "move", path: [step] };
}

/** 当前不在环境灾害格上、且能打到巨兽时普攻猎兽（技能链仍可能顺带伤及巨兽） */
function botTryAttackBeast(g: GameSession, actorId: string): GameAction | null {
  const p = g.players.get(actorId)!;
  const tf = g.turnFlags.get(actorId)!;
  const beast = g.beast;
  if (!beast || beast.hp <= 0) return null;
  if (tf.didAttack === false && (tf.learnCount > 0 || tf.skillIdsUsed.length > 0)) return null;
  if (p.stamina < ATTACK_COST) return null;
  const env = botEnvironmentalHazardKeys(g);
  if (env.has(cellKey(p.col, p.row))) return null;
  let best: { col: number; row: number } | null = null;
  let bestM = 999;
  for (const bk of beastCellKeys(beast)) {
    const pos = parseKey(bk);
    if (!cellInPlayableArea(g, pos.col, pos.row)) continue;
    if (chebyshev(p, pos) > ATTACK_RANGE) continue;
    const m = manhattan(p, pos);
    if (m < bestM) {
      bestM = m;
      best = pos;
    }
  }
  if (!best) return null;
  return { kind: "attack", col: best.col, row: best.row };
}

function botWalkNeighbors(g: GameSession, col: number, row: number): Array<{ col: number; row: number }> {
  const n = g.gridSize;
  return orthogonalNeighbors(col, row, n).filter(
    (c) =>
      cellInPlayableArea(g, c.col, c.row) &&
      !cellIsWall(g, c.col, c.row) &&
      !beastOccupies(g.beast, c.col, c.row)
  );
}

function botEnemies(g: GameSession, actorId: string): GamePlayer[] {
  return [...g.players.values()].filter(
    (x) => x.hp > 0 && x.socketId !== actorId && !sameTeam(g, actorId, x.socketId)
  );
}

function botNearestEnemy(g: GameSession, actorId: string): GamePlayer | null {
  const p = g.players.get(actorId)!;
  const enemies = botEnemies(g, actorId);
  if (enemies.length === 0) return null;
  let best = enemies[0]!;
  let bestD = manhattan(p, best);
  for (const e of enemies.slice(1)) {
    const d = manhattan(p, e);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/** BFS：返回走向目标格的第一步（四连通） */
function botBfsFirstStep(
  g: GameSession,
  actorId: string,
  goal: { col: number; row: number }
): { col: number; row: number } | null {
  const p = g.players.get(actorId)!;
  const start = cellKey(p.col, p.row);
  const goalKey = cellKey(goal.col, goal.row);
  const prev = new Map<string, string>();
  const seen = new Set<string>([start]);
  const q: string[] = [start];
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi]!;
    const pos = parseKey(cur);
    for (const nb of botWalkNeighbors(g, pos.col, pos.row)) {
      const nk = cellKey(nb.col, nb.row);
      if (seen.has(nk)) continue;
      seen.add(nk);
      prev.set(nk, cur);
      q.push(nk);
    }
  }
  if (!seen.has(goalKey)) return null;
  let cur = goalKey;
  while (prev.has(cur)) {
    const parent = prev.get(cur)!;
    if (parent === start) return parseKey(cur);
    cur = parent;
  }
  return null;
}

function botTryAttack(
  g: GameSession,
  actorId: string,
  pickTarget: (enemies: GamePlayer[]) => GamePlayer | undefined
): GameAction | null {
  const p = g.players.get(actorId)!;
  const tf = g.turnFlags.get(actorId)!;
  if (tf.didAttack === false && (tf.learnCount > 0 || tf.skillIdsUsed.length > 0)) return null;
  const inRange = botEnemies(g, actorId).filter(
    (e) => chebyshev(p, e) <= ATTACK_RANGE && cellInPlayableArea(g, e.col, e.row)
  );
  if (inRange.length === 0) return null;
  if (p.stamina < ATTACK_COST) return null;
  const tgt = pickTarget(inRange);
  if (!tgt) return null;
  return { kind: "attack", col: tgt.col, row: tgt.row };
}

/** 技能偏好：basic 试探；standard≈旧中级；elite≈旧高级全日径搜索 */
function botTrySkill(
  g: GameSession,
  actorId: string,
  skillTier: "basic" | "standard" | "elite"
): GameAction | null {
  const p = g.players.get(actorId)!;
  const tf = g.turnFlags.get(actorId)!;
  if (tf.didAttack) return null;
  const n = g.gridSize;
  const enemies = botEnemies(g, actorId);

  const trySkill = (sk: SkillId, payload: Record<string, unknown>): GameAction | null => {
    if (!p.skills.includes(sk) || !canUseSkill(g, actorId, sk)) return null;
    if (p.stamina < skillStaminaCost(g, actorId, sk)) return null;
    if (tf.skillIdsUsed.includes(sk)) return null;
    return { kind: "skill", skillId: sk, payload };
  };

  if (skillTier !== "basic") {
    const exe = enemies.filter((e) => chebyshev(p, e) <= 1 && e.hp <= 6);
    if (exe.length) {
      const low = exe.sort((a, b) => a.hp - b.hp)[0]!;
      const act = trySkill("execute", { targetId: low.socketId });
      if (act) return act;
    }
  }

  if (skillTier === "elite") {
    let bestSniper: GamePlayer | undefined;
    let bestScore = -1;
    for (const e of enemies) {
      if (!cellInPlayableArea(g, e.col, e.row)) continue;
      const sc = e.hp <= 6 ? 100 - e.hp : 30 - e.hp;
      if (sc > bestScore) {
        bestScore = sc;
        bestSniper = e;
      }
    }
    if (bestSniper) {
      const act = trySkill("sniper", { col: bestSniper.col, row: bestSniper.row });
      if (act) return act;
    }

    let bestMissile: { col: number; row: number } | null = null;
    let bestHits = 0;
    for (let col = 1; col < n - 1; col++) {
      for (let row = 1; row < n - 1; row++) {
        if (!cellInPlayableArea(g, col, row)) continue;
        const cells = cellsInRectCenter(col, row, 1, n);
        let hits = 0;
        for (const e of enemies) {
          if (cells.some((c) => c.col === e.col && c.row === e.row)) hits++;
        }
        if (hits > bestHits) {
          bestHits = hits;
          bestMissile = { col, row };
        }
      }
    }
    if (bestMissile && bestHits >= 1) {
      const act = trySkill("missile", { col: bestMissile.col, row: bestMissile.row });
      if (act) return act;
    }

    for (const [di, dj] of OCT_DIRS) {
      const cells = rayFrom(p.col, p.row, di, dj, n);
      let hits = 0;
      for (const cell of cells) {
        if (enemies.some((e) => e.hp > 0 && e.col === cell.col && e.row === cell.row)) hits++;
      }
      if (hits >= 1) {
        const act = trySkill("laser", { dc: di, dr: dj });
        if (act) return act;
      }
    }
  }

  if (skillTier === "standard") {
    const tgt = botNearestEnemy(g, actorId);
    if (tgt && cellInPlayableArea(g, tgt.col, tgt.row)) {
      const act = trySkill("sniper", { col: tgt.col, row: tgt.row });
      if (act) return act;
    }
    if (tgt) {
      const act = trySkill("missile", { col: tgt.col, row: tgt.row });
      if (act) return act;
    }
  }

  if (skillTier === "basic" && Math.random() < 0.28) {
    const tgt = randomFrom(enemies);
    if (tgt && cellInPlayableArea(g, tgt.col, tgt.row)) {
      const act = trySkill("missile", { col: tgt.col, row: tgt.row });
      if (act) return act;
    }
  }

  return null;
}

function botMinChebyshevToEnemies(g: GameSession, actorId: string): number {
  const p = g.players.get(actorId)!;
  const enemies = botEnemies(g, actorId);
  if (enemies.length === 0) return 999;
  let m = 999;
  for (const e of enemies) m = Math.min(m, chebyshev(p, e));
  return m;
}

/** 走向使「与最近敌人的切比雪夫距离」最大的相邻格（拉扯） */
function botSafestStepFromEnemies(
  g: GameSession,
  actorId: string
): { col: number; row: number } | null {
  const p = g.players.get(actorId)!;
  const enemies = botEnemies(g, actorId);
  if (enemies.length === 0) return null;
  const opts = botWalkNeighbors(g, p.col, p.row);
  if (opts.length === 0) return null;
  let best: { col: number; row: number } | null = null;
  let bestMin = -1;
  for (const c of opts) {
    let minD = 999;
    for (const e of enemies) {
      minD = Math.min(minD, chebyshev(c, e));
    }
    if (minD > bestMin) {
      bestMin = minD;
      best = c;
    }
  }
  return best;
}

/** 高级电脑：偏保守 —— 优先远程消耗与斩杀，危急时隐身/后撤，再贴脸输出 */
function chooseHardApexBotAction(g: GameSession, actorId: string): GameAction {
  const p = g.players.get(actorId)!;
  const tf = g.turnFlags.get(actorId)!;
  const tgt = botNearestEnemy(g, actorId);
  const minD = botMinChebyshevToEnemies(g, actorId);
  const pressured = p.hp <= 7 && minD <= 3;

  const killAtk = botTryAttack(g, actorId, (arr) => {
    const fin = arr.filter((e) => e.hp <= sessionAttackDamage(g));
    if (fin.length) return fin.sort((a, b) => a.hp - b.hp)[0];
    return arr.sort((a, b) => a.hp - b.hp)[0];
  });
  if (killAtk) return killAtk;

  const skElite = botTrySkill(g, actorId, "elite");
  if (skElite) return skElite;

  if (pressured) {
    const stealthAct = ((): GameAction | null => {
      if (!p.skills.includes("stealth") || p.stealthActive) return null;
      if (tf.skillIdsUsed.includes("stealth")) return null;
      if (!canUseSkill(g, actorId, "stealth")) return null;
      if (p.stamina < SKILL_META.stealth.cost) return null;
      return { kind: "skill", skillId: "stealth", payload: {} };
    })();
    if (stealthAct) return stealthAct;

    if (minD <= 2) {
      const flee = botSafestStepFromEnemies(g, actorId);
      if (flee) return { kind: "move", path: [flee] };
    }
  }

  const atk = botTryAttack(g, actorId, (arr) => [...arr].sort((a, b) => a.hp - b.hp)[0]);
  if (atk && (!pressured || p.hp >= 6)) return atk;

  if (
    !tf.didAttack &&
    tf.learnCount < 2 &&
    p.stamina >= 3 &&
    (p.skills.length < 4 || tf.learnCount === 0)
  ) {
    return { kind: "learn", confirmOverwrite: true };
  }

  const beastState = g.beast;
  if (beastState && beastState.hp > 0 && p.hp <= 6) {
    const cells = botWalkNeighbors(g, p.col, p.row);
    const safer = cells.filter((c) => {
      let dmin = 99;
      for (const k of beastCellKeys(beastState)) {
        const b = parseKey(k);
        dmin = Math.min(dmin, manhattan(c, b));
      }
      return dmin >= 3;
    });
    if (safer.length > 0) {
      return { kind: "move", path: [randomFrom(safer)!] };
    }
  }

  if (tgt) {
    const step = botBfsFirstStep(g, actorId, tgt);
    if (step && manhattan(p, step) === 1 && p.stamina >= 1) {
      return { kind: "move", path: [step] };
    }
  }
  if (tgt) {
    const neigh = botWalkNeighbors(g, p.col, p.row);
    if (neigh.length > 0) {
      const sorted = neigh.sort((a, b) => manhattan(a, tgt) - manhattan(b, tgt));
      return { kind: "move", path: [sorted[0]!] };
    }
  }
  if (
    p.hp < sessionMaxHp(g) &&
    !tf.didMove &&
    !tf.didAttack &&
    tf.learnCount === 0 &&
    tf.skillIdsUsed.length === 0
  ) {
    return { kind: "rest", mode: "hp" };
  }
  return { kind: "endTurn" };
}

export function chooseBotAction(g: GameSession, actorId: string, difficulty: BotDifficulty): GameAction {
  const p = g.players.get(actorId)!;
  const tf = g.turnFlags.get(actorId)!;
  const diff = p.botDifficulty ?? difficulty;

  if (diff === "easy") {
    if (Math.random() < 0.1) return { kind: "endTurn" };
    const flee = botTryFleeUrgentDanger(g, actorId);
    if (flee) return flee;

    const danger = botUrgentDangerKeys(g);
    const atkLow = botTryAttack(g, actorId, (arr) => [...arr].sort((a, b) => a.hp - b.hp)[0]);
    if (atkLow) return atkLow;
    const huntBeast = botTryAttackBeast(g, actorId);
    if (huntBeast) return huntBeast;
    const sk = botTrySkill(g, actorId, "standard");
    if (sk) return sk;
    if (!tf.didAttack && tf.learnCount < 2 && p.stamina >= 3 && Math.random() < 0.58) {
      return { kind: "learn", confirmOverwrite: true };
    }
    const tgt = botNearestEnemy(g, actorId);
    if (tgt) {
      const step = botBfsFirstStepRiskAware(g, actorId, tgt, danger);
      if (step && manhattan(p, step) === 1 && p.stamina >= 1) {
        return { kind: "move", path: [step] };
      }
    }
    const neigh = botWalkNeighborsRiskAware(g, p.col, p.row, danger);
    if (neigh.length > 0) {
      const dest = tgt
        ? [...neigh].sort((a, b) => manhattan(a, tgt) - manhattan(b, tgt))[0]!
        : randomFrom(neigh)!;
      return { kind: "move", path: [dest] };
    }
    if (
      p.hp < sessionMaxHp(g) &&
      !tf.didMove &&
      !tf.didAttack &&
      tf.learnCount === 0 &&
      tf.skillIdsUsed.length === 0
    ) {
      return { kind: "rest", mode: "hp" };
    }
    return { kind: "endTurn" };
  }

  if (diff === "medium") {
    const flee = botTryFleeUrgentDanger(g, actorId);
    if (flee) return flee;

    const danger = botUrgentDangerKeys(g);
    const atkFinish = botTryAttack(g, actorId, (arr) => [...arr].sort((a, b) => a.hp - b.hp)[0]);
    if (atkFinish) return atkFinish;
    const huntBeast = botTryAttackBeast(g, actorId);
    if (huntBeast) return huntBeast;
    const skH = botTrySkill(g, actorId, "elite");
    if (skH) return skH;
    if (
      !tf.didAttack &&
      tf.learnCount < 2 &&
      p.stamina >= 3 &&
      (p.skills.length < 4 || tf.learnCount === 0)
    ) {
      return { kind: "learn", confirmOverwrite: true };
    }
    const tgt = botNearestEnemy(g, actorId);
    if (tgt) {
      const step = botBfsFirstStepRiskAware(g, actorId, tgt, danger);
      if (step && manhattan(p, step) === 1 && p.stamina >= 1) {
        return { kind: "move", path: [step] };
      }
    }
    if (tgt) {
      const neigh = botWalkNeighborsRiskAware(g, p.col, p.row, danger);
      if (neigh.length > 0) {
        const sorted = neigh.sort((a, b) => manhattan(a, tgt) - manhattan(b, tgt));
        return { kind: "move", path: [sorted[0]!] };
      }
    }
    if (
      p.hp < sessionMaxHp(g) &&
      !tf.didMove &&
      !tf.didAttack &&
      tf.learnCount === 0 &&
      tf.skillIdsUsed.length === 0
    ) {
      return { kind: "rest", mode: "hp" };
    }
    return { kind: "endTurn" };
  }

  return chooseHardApexBotAction(g, actorId);
}
