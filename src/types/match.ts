import type { GameReplayEntryView } from "@/types/game";
import type { MatchMode } from "@/constants/matchModes";

export type MatchHistoryRanking = {
  gameAccountId: string;
  nickname: string;
  rank: number;
  avatar: string;
  resultText?: string;
  resultKind?: "win" | "death";
};

export type MatchHistoryItem = {
  matchId: string;
  roomCode: string;
  endedAt: number;
  gridSize?: number;
  mapSizeLabel?: string;
  matchMode?: MatchMode;
  matchModeLabel?: string;
  rankings: MatchHistoryRanking[];
};

export type MatchHistoryDetail = MatchHistoryItem & {
  replayLog: GameReplayEntryView[];
};

export type LeaderboardRow = {
  gameAccountId: string;
  nickname: string;
  avatar: string;
  wins: number;
  games: number;
  winRate: number;
};

export type LeaderboardByMode = Record<MatchMode, LeaderboardRow[]>;
