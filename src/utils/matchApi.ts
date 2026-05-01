import type { LeaderboardByMode, MatchHistoryDetail, MatchHistoryItem } from "@/types/match";

async function parseJson<T>(res: Response): Promise<T> {
  const j = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    const msg = typeof (j as { error?: string }).error === "string" ? (j as { error: string }).error : res.statusText;
    throw new Error(msg);
  }
  return j as T;
}

export async function registerAccountApi(body: {
  gameAccountId: string;
  nickname: string;
  avatar: string;
}): Promise<void> {
  const res = await fetch("/api/account/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await parseJson<{ ok: boolean }>(res);
}

export async function fetchAccountProfile(gameAccountId: string): Promise<{
  gameAccountId: string;
  nickname: string;
  avatar: string;
  updatedAt: number;
} | null> {
  const res = await fetch(`/api/account/${encodeURIComponent(gameAccountId)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || res.statusText);
  }
  return (await res.json()) as {
    gameAccountId: string;
    nickname: string;
    avatar: string;
    updatedAt: number;
  };
}

export async function fetchMatchList(gameAccountId: string): Promise<MatchHistoryItem[]> {
  const res = await fetch(`/api/matches?account=${encodeURIComponent(gameAccountId)}`);
  const j = await parseJson<{ matches: MatchHistoryItem[] }>(res);
  return j.matches ?? [];
}

export async function fetchMatchDetail(
  matchId: string,
  gameAccountId: string
): Promise<MatchHistoryDetail> {
  const res = await fetch(
    `/api/match/${encodeURIComponent(matchId)}?account=${encodeURIComponent(gameAccountId)}`
  );
  return parseJson<MatchHistoryDetail>(res);
}

export async function fetchLeaderboard(): Promise<LeaderboardByMode> {
  const res = await fetch("/api/leaderboard");
  const j = await parseJson<{ leaderboard: LeaderboardByMode }>(res);
  return j.leaderboard;
}
