import fs from "node:fs";
import path from "node:path";
import type { GameReplayEntry, GameSession } from "./game/gameTypes.js";
import { buildRanking } from "./game/engine.js";
import { mapSizeLabel } from "./mapConfig.js";
import { MATCH_MODE_CONFIGS, type MatchMode } from "./matchModes.js";

const DATA_DIR = path.join(process.cwd(), "server-data");
const STORE_FILE = path.join(DATA_DIR, "match-store.json");

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

type StoreFile = {
  accounts: Record<string, AccountRow>;
  matches: StoredMatch[];
};

function emptyStore(): StoreFile {
  return { accounts: {}, matches: [] };
}

function readStore(): StoreFile {
  try {
    const raw = fs.readFileSync(STORE_FILE, "utf-8");
    const j = JSON.parse(raw) as StoreFile;
    return {
      accounts: j.accounts && typeof j.accounts === "object" ? j.accounts : {},
      matches: Array.isArray(j.matches) ? j.matches : [],
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(s: StoreFile): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(s), "utf-8");
}

/** 2–24 位：字母、数字、中文、下划线、短横线 */
export function normalizeGameAccountId(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (s.length < 2 || s.length > 24) return null;
  if (!/^[\w\-\u4e00-\u9fa5]+$/.test(s)) return null;
  return s;
}

export function upsertAccount(
  gameAccountId: string,
  nickname: string,
  avatar: string
): { ok: true } | { ok: false; error: string } {
  const id = normalizeGameAccountId(gameAccountId);
  if (!id) {
    return { ok: false, error: "账号格式无效（2–24 位，字母、数字、中文、下划线或短横线）" };
  }
  const store = readStore();
  store.accounts[id] = {
    nickname: nickname.trim().slice(0, 16) || "猎人",
    avatar: typeof avatar === "string" ? avatar : "",
    updatedAt: Date.now(),
  };
  writeStore(store);
  return { ok: true };
}

export function getAccount(gameAccountId: string): AccountRow | null {
  const id = normalizeGameAccountId(gameAccountId);
  if (!id) return null;
  return readStore().accounts[id] ?? null;
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

export function listMatchesForAccount(gameAccountId: string): MatchListItem[] {
  const id = normalizeGameAccountId(gameAccountId);
  if (!id) return [];
  const { matches } = readStore();
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

export function getMatchDetailForAccount(
  matchId: string,
  gameAccountId: string
): StoredMatch | null {
  const aid = normalizeGameAccountId(gameAccountId);
  if (!aid) return null;
  const { matches } = readStore();
  const m = matches.find((x) => x.matchId === matchId);
  if (!m || !m.rankings.some((r) => r.gameAccountId === aid)) return null;
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

export function listLeaderboard(): Record<MatchMode, LeaderboardRow[]> {
  const store = readStore();
  const byMode = {} as Record<MatchMode, Map<string, LeaderboardRow>>;

  for (const mode of Object.keys(MATCH_MODE_CONFIGS) as MatchMode[]) {
    byMode[mode] = new Map();
  }

  for (const match of store.matches) {
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
      const acc = store.accounts[rank.gameAccountId];
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

export function recordFinishedMatchIfNeeded(g: GameSession): void {
  if (g.phase !== "ended") return;
  const store = readStore();
  if (store.matches.some((m) => m.matchId === g.matchId)) return;

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
  store.matches.push({
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
  });
  writeStore(store);
}
