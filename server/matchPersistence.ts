import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { GameReplayEntry, GameSession } from "./game/gameTypes.js";
import { buildRanking } from "./game/engine.js";
import { mapSizeLabel } from "./mapConfig.js";
import { MATCH_MODE_CONFIGS, type MatchMode } from "./matchModes.js";
import { getPool } from "./db.js";

export type AccountRow = {
  nickname: string;
  avatar: string;
  updatedAt: number;
};

export type StoredMatchRanking = {
  gameAccountId: string;
  nickname: string;
  rank: number;
  avatar: string;
  /** 开局席位阵营，用于排行榜「至少两方人类阵营」判定 */
  teamId?: number;
  resultText?: string;
  resultKind?: "win" | "death";
};

export type StoredMatch = {
  matchId: string;
  roomCode: string;
  endedAt: number;
  gridSize: number;
  mapSizeLabel: string;
  matchMode?: MatchMode;
  matchModeLabel?: string;
  finalRoundNumber?: number;
  rankings: StoredMatchRanking[];
  replayLog: GameReplayEntry[];
};

type MatchRow = RowDataPacket & {
  match_id: string;
  ended_at: number;
  payload: StoredMatch;
};

type AccountDbRow = RowDataPacket & {
  game_account_id: string;
  nickname: string;
  avatar: string;
  updated_at: number;
};

function normalizeStoredMatch(raw: unknown): StoredMatch | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as StoredMatch;
  if (typeof m.matchId !== "string") return null;
  const gridSize = m.gridSize ?? 15;
  return {
    ...m,
    gridSize,
    mapSizeLabel: m.mapSizeLabel ?? mapSizeLabel(gridSize),
    matchMode: m.matchMode ?? "solo",
    matchModeLabel: m.matchModeLabel ?? MATCH_MODE_CONFIGS[m.matchMode ?? "solo"].label,
    rankings: Array.isArray(m.rankings) ? m.rankings : [],
    replayLog: Array.isArray(m.replayLog) ? m.replayLog : [],
  };
}

async function loadAllMatches(): Promise<StoredMatch[]> {
  const pool = getPool();
  const [rows] = await pool.query<MatchRow[]>(
    "SELECT match_id, ended_at, payload FROM matches ORDER BY ended_at DESC"
  );
  const out: StoredMatch[] = [];
  for (const r of rows) {
    const payload =
      typeof r.payload === "string" ? (JSON.parse(r.payload) as unknown) : r.payload;
    const m = normalizeStoredMatch(payload);
    if (m) out.push(m);
  }
  return out;
}

async function loadAccountsMap(): Promise<Record<string, AccountRow>> {
  const pool = getPool();
  const [rows] = await pool.query<AccountDbRow[]>(
    "SELECT game_account_id, nickname, avatar, updated_at FROM accounts"
  );
  const accounts: Record<string, AccountRow> = {};
  for (const r of rows) {
    accounts[r.game_account_id] = {
      nickname: r.nickname,
      avatar: r.avatar,
      updatedAt: Number(r.updated_at),
    };
  }
  return accounts;
}

/** 2–24 位：字母、数字、中文、下划线、短横线 */
export function normalizeGameAccountId(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (s.length < 2 || s.length > 24) return null;
  if (!/^[\w\-\u4e00-\u9fa5]+$/.test(s)) return null;
  return s;
}

export async function upsertAccount(
  gameAccountId: string,
  nickname: string,
  avatar: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const id = normalizeGameAccountId(gameAccountId);
  if (!id) {
    return { ok: false, error: "账号格式无效（2–24 位，字母、数字、中文、下划线或短横线）" };
  }
  const pool = getPool();
  const now = Date.now();
  await pool.execute(
    `INSERT INTO accounts (game_account_id, nickname, avatar, updated_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE nickname = VALUES(nickname), avatar = VALUES(avatar), updated_at = VALUES(updated_at)`,
    [id, nickname.trim().slice(0, 16) || "猎人", typeof avatar === "string" ? avatar : "", now]
  );
  return { ok: true };
}

export async function getAccount(gameAccountId: string): Promise<AccountRow | null> {
  const id = normalizeGameAccountId(gameAccountId);
  if (!id) return null;
  const pool = getPool();
  const [rows] = await pool.query<AccountDbRow[]>(
    "SELECT nickname, avatar, updated_at FROM accounts WHERE game_account_id = ? LIMIT 1",
    [id]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    nickname: r.nickname,
    avatar: r.avatar,
    updatedAt: Number(r.updated_at),
  };
}

export type MatchListItem = {
  matchId: string;
  roomCode: string;
  endedAt: number;
  gridSize: number;
  mapSizeLabel: string;
  matchMode: MatchMode;
  matchModeLabel: string;
  rankings: StoredMatchRanking[];
};

export async function listMatchesForAccount(gameAccountId: string): Promise<MatchListItem[]> {
  const id = normalizeGameAccountId(gameAccountId);
  if (!id) return [];
  const matches = await loadAllMatches();
  return matches
    .filter((m) => m.rankings.some((r) => r.gameAccountId === id))
    .map((m) => {
      const gridSize = m.gridSize ?? 15;
      return {
        matchId: m.matchId,
        roomCode: m.roomCode,
        endedAt: m.endedAt,
        gridSize,
        mapSizeLabel: m.mapSizeLabel ?? mapSizeLabel(gridSize),
        matchMode: m.matchMode ?? "solo",
        matchModeLabel: m.matchModeLabel ?? MATCH_MODE_CONFIGS[m.matchMode ?? "solo"].label,
        rankings: m.rankings,
      };
    })
    .sort((a, b) => b.endedAt - a.endedAt);
}

export async function getMatchDetailForAccount(
  matchId: string,
  gameAccountId: string
): Promise<StoredMatch | null> {
  const aid = normalizeGameAccountId(gameAccountId);
  if (!aid) return null;
  const pool = getPool();
  const [rows] = await pool.query<MatchRow[]>(
    "SELECT payload FROM matches WHERE match_id = ? LIMIT 1",
    [matchId]
  );
  const r = rows[0];
  if (!r) return null;
  const payload =
    typeof r.payload === "string" ? (JSON.parse(r.payload) as unknown) : r.payload;
  const m = normalizeStoredMatch(payload);
  if (!m || !m.rankings.some((x) => x.gameAccountId === aid)) return null;
  return m;
}

export type LeaderboardRow = {
  gameAccountId: string;
  nickname: string;
  avatar: string;
  wins: number;
  games: number;
  winRate: number;
};

function eligibleRoundNumber(m: StoredMatch): number {
  if (typeof m.finalRoundNumber === "number") return m.finalRoundNumber;
  return Math.max(0, ...((m.replayLog ?? []).map((e) => Number(e.roundNumber) || 0)));
}

/** 至少两名人类玩家分属不同阵营（teamId）；历史数据无 teamId 时仅在单人混战下按账号区分 */
function distinctHumanTeamCount(m: StoredMatch): number {
  const humans = m.rankings.filter((r) => r.gameAccountId && !isBotGameAccountId(r.gameAccountId));
  if (humans.length < 2) return 0;
  const mode = m.matchMode ?? "solo";
  const missingTeam = humans.some((r) => typeof r.teamId !== "number");
  if (missingTeam) {
    if (mode === "solo") {
      return new Set(humans.map((r) => r.gameAccountId)).size;
    }
    return 0;
  }
  return new Set(humans.map((r) => r.teamId as number)).size;
}

/** 有效计入排行榜：轮数 ≥6，且至少两名人类玩家来自不同阵营 */
function isValidLeaderboardMatch(m: StoredMatch): boolean {
  if (eligibleRoundNumber(m) < 6) return false;
  return distinctHumanTeamCount(m) >= 2;
}

/** 与房间内电脑 bot 的 gameAccountId（bot_ 前缀）一致，不计入排行榜 */
function isBotGameAccountId(id: string): boolean {
  return id.startsWith("bot_");
}

export async function listLeaderboard(): Promise<Record<MatchMode, LeaderboardRow[]>> {
  const storeMatches = await loadAllMatches();
  const accounts = await loadAccountsMap();
  const byMode = {} as Record<MatchMode, Map<string, LeaderboardRow>>;

  for (const mode of Object.keys(MATCH_MODE_CONFIGS) as MatchMode[]) {
    byMode[mode] = new Map();
  }

  for (const match of storeMatches) {
    if (!isValidLeaderboardMatch(match)) continue;
    const mode = match.matchMode ?? "solo";
    const rows = byMode[mode] ?? byMode.solo;
    for (const rank of match.rankings) {
      if (!rank.gameAccountId || isBotGameAccountId(rank.gameAccountId)) continue;
      const row =
        rows.get(rank.gameAccountId) ??
        ({
          gameAccountId: rank.gameAccountId,
          nickname: rank.nickname,
          avatar: rank.avatar,
          wins: 0,
          games: 0,
          winRate: 0,
        } satisfies LeaderboardRow);
      const acc = accounts[rank.gameAccountId];
      row.nickname = rank.nickname || acc?.nickname || row.nickname;
      row.avatar = rank.avatar || acc?.avatar || row.avatar;
      row.games++;
      if (rank.rank === 1) row.wins++;
      rows.set(rank.gameAccountId, row);
    }
  }

  const out = {} as Record<MatchMode, LeaderboardRow[]>;
  for (const mode of Object.keys(MATCH_MODE_CONFIGS) as MatchMode[]) {
    out[mode] = [...byMode[mode].values()]
      .filter((row) => !isBotGameAccountId(row.gameAccountId) && row.wins > 0)
      .map((row) => ({
        ...row,
        winRate: row.games > 0 ? row.wins / row.games : 0,
      }))
      .sort((a, b) => b.wins - a.wins || b.winRate - a.winRate || b.games - a.games || a.nickname.localeCompare(b.nickname, "zh-CN"));
  }
  return out;
}

export type AccountListEntry = { gameAccountId: string } & AccountRow;

export async function listAllAccounts(): Promise<AccountListEntry[]> {
  const pool = getPool();
  const [rows] = await pool.query<AccountDbRow[]>(
    "SELECT game_account_id, nickname, avatar, updated_at FROM accounts ORDER BY updated_at DESC"
  );
  return rows.map((r) => ({
    gameAccountId: r.game_account_id,
    nickname: r.nickname,
    avatar: r.avatar,
    updatedAt: Number(r.updated_at),
  }));
}

export async function deleteAccountById(rawId: string): Promise<boolean> {
  const id = normalizeGameAccountId(rawId);
  if (!id) return false;
  const pool = getPool();
  const [res] = await pool.execute("DELETE FROM accounts WHERE game_account_id = ?", [id]);
  return (res as ResultSetHeader).affectedRows > 0;
}

export async function listAllMatchesAdmin(): Promise<StoredMatch[]> {
  return loadAllMatches();
}

export async function getMatchByIdAdmin(matchId: string): Promise<StoredMatch | null> {
  const pool = getPool();
  const [rows] = await pool.query<MatchRow[]>(
    "SELECT payload FROM matches WHERE match_id = ? LIMIT 1",
    [matchId]
  );
  const r = rows[0];
  if (!r) return null;
  const payload =
    typeof r.payload === "string" ? (JSON.parse(r.payload) as unknown) : r.payload;
  return normalizeStoredMatch(payload);
}

export async function deleteMatchById(matchId: string): Promise<boolean> {
  const pool = getPool();
  const [res] = await pool.execute("DELETE FROM matches WHERE match_id = ?", [matchId]);
  return (res as ResultSetHeader).affectedRows > 0;
}

export async function recordFinishedMatchIfNeeded(g: GameSession): Promise<void> {
  if (g.phase !== "ended") return;

  const rankings = buildRanking(g).map((r) => {
    const pl = g.players.get(r.socketId);
    return {
      gameAccountId: pl?.gameAccountId ?? "",
      nickname: r.nickname,
      rank: r.rank,
      avatar: r.avatar,
      teamId: pl?.teamId,
      resultText: r.resultText,
      resultKind: r.resultKind,
    };
  });

  const replayLog = JSON.parse(JSON.stringify(g.replayLog)) as GameReplayEntry[];
  const stored: StoredMatch = {
    matchId: g.matchId,
    roomCode: g.roomCode,
    endedAt: Date.now(),
    gridSize: g.gridSize,
    mapSizeLabel: mapSizeLabel(g.gridSize),
    matchMode: g.matchMode,
    matchModeLabel: g.matchModeLabel,
    finalRoundNumber: g.roundNumber,
    rankings,
    replayLog,
  };

  const pool = getPool();
  try {
    await pool.execute(
      `INSERT INTO matches (match_id, ended_at, payload) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE match_id = match_id`,
      [g.matchId, stored.endedAt, JSON.stringify(stored)]
    );
  } catch (e) {
    console.error("[matchPersistence] 写入对局记录失败:", e);
  }
}
