import { useCallback, useEffect, useState } from "react";
import { MATCH_MODE_OPTIONS, type MatchMode } from "@/constants/matchModes";
import type { LeaderboardByMode } from "@/types/match";
import { PlayerAvatarFrame } from "@/components/PlayerAvatarFrame";
import { DEFAULT_AVATAR } from "@/utils/defaultAvatar";
import { fetchLeaderboard } from "@/utils/matchApi";

type Props = {
  open: boolean;
  onClose: () => void;
};

function formatRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function LeaderboardModal({ open, onClose }: Props) {
  const [rows, setRows] = useState<LeaderboardByMode>({
    solo: [],
    duo: [],
    trio: [],
    squad: [],
  });
  const [activeMode, setActiveMode] = useState<MatchMode>("solo");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setRows(await fetchLeaderboard());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载排行榜失败");
      setRows({ solo: [], duo: [], trio: [], squad: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  if (!open) return null;
  const activeRows = rows[activeMode] ?? [];

  return (
    <div className="overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal modal--leaderboard" onClick={(e) => e.stopPropagation()}>
        <h3>排行榜</h3>
        <p className="modal-hint">
          仅统计「有效对局」：至少 6 轮，且至少两名人类玩家分属不同阵营；胜局与场次均以此为准。无有效胜场的玩家不展示。
        </p>
        <div className="leaderboard-tabs" role="tablist" aria-label="排行榜榜单">
          {MATCH_MODE_OPTIONS.map((mode) => (
            <button
              key={mode.mode}
              type="button"
              className={"leaderboard-tab" + (activeMode === mode.mode ? " leaderboard-tab--active" : "")}
              onClick={() => setActiveMode(mode.mode)}
            >
              {mode.label}
            </button>
          ))}
        </div>
        {loading ? <p className="modal-hint">加载中…</p> : null}
        {err ? <p className="modal-error">{err}</p> : null}
        {!loading && !err && activeRows.length === 0 ? (
          <p className="modal-hint">暂无可统计的玩家。</p>
        ) : null}
        {activeRows.length > 0 ? (
          <ol className="leaderboard-list">
            {activeRows.map((row, index) => (
              <li key={row.gameAccountId} className="leaderboard-row">
                <span className="leaderboard-rank">#{index + 1}</span>
                <PlayerAvatarFrame src={row.avatar || DEFAULT_AVATAR} alt="" width={40} height={40} />
                <span className="leaderboard-name">{row.nickname}</span>
                <span className="leaderboard-stat">
                  <strong>{row.wins}</strong>
                  <small>胜局</small>
                </span>
                <span className="leaderboard-stat">
                  <strong>{formatRate(row.winRate)}</strong>
                  <small>胜率</small>
                </span>
              </li>
            ))}
          </ol>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
