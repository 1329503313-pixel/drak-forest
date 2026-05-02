import { useCallback, useEffect, useState } from "react";
import type { GameReplayEntryView } from "@/types/game";
import type { MatchHistoryDetail } from "@/types/match";
import { mapSizeLabel } from "@/constants/mapSizes";
import { PlayerAvatarFrame } from "@/components/PlayerAvatarFrame";
import { DEFAULT_AVATAR } from "@/utils/defaultAvatar";
import { adminFetch } from "@/utils/adminApi";
import { exportReplayImage } from "@/utils/replayImage";

type Props = {
  matchId: string | null;
  open: boolean;
  onClose: () => void;
};

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(ts);
  }
}

function rankLabel(rank: number): string {
  if (rank === 1) return "冠军";
  if (rank === 2) return "亚军";
  if (rank === 3) return "季军";
  return `第 ${rank} 名`;
}

export function AdminReplayModal({ matchId, open, onClose }: Props) {
  const [detail, setDetail] = useState<MatchHistoryDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!matchId) return;
    setLoading(true);
    setErr(null);
    try {
      const d = await adminFetch<MatchHistoryDetail>(`/matches/${encodeURIComponent(matchId)}`);
      setDetail(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [matchId]);

  useEffect(() => {
    if (!open || !matchId) {
      setDetail(null);
      return;
    }
    void load();
  }, [open, matchId, load]);

  const saveImage = async () => {
    if (!detail) return;
    const replayLog = Array.isArray(detail.replayLog) ? (detail.replayLog as GameReplayEntryView[]) : [];
    if (replayLog.length === 0) return;
    setSaving(true);
    try {
      await exportReplayImage({
        title: "对局复盘",
        subtitle: `${formatTime(detail.endedAt)} · 房间 ${detail.roomCode} · ${detail.mapSizeLabel ?? mapSizeLabel(detail.gridSize ?? 15)}`,
        entries: replayLog,
        filename: `admin-replay-${detail.roomCode}-${detail.matchId.slice(0, 8)}.png`,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "导出失败");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const replayLog = Array.isArray(detail?.replayLog) ? (detail!.replayLog as GameReplayEntryView[]) : [];

  return (
    <div
      className="admin-replay-overlay"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div className="admin-replay-inner" onClick={(e) => e.stopPropagation()}>
        <div className="admin-replay-top">
          <h2>完整对局复盘</h2>
          <button type="button" className="game-screen__replay-close-x" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        {loading ? <p className="admin-hint">加载中…</p> : null}
        {err ? <p className="admin-error">{err}</p> : null}
        {detail && !loading ? (
          <>
            <p className="admin-replay-meta">
              {formatTime(detail.endedAt)} · 房间 {detail.roomCode} · {detail.mapSizeLabel ?? mapSizeLabel(detail.gridSize ?? 15)} ·{" "}
              {detail.matchModeLabel ?? "—"} · 对局 ID <span className="admin-code">{detail.matchId}</span>
            </p>
            {(detail.rankings?.length ?? 0) > 0 ? (
              <div className="admin-replay-ranks">
                <h3 className="admin-subheading">结算排名</h3>
                <ol className="history-ranks admin-replay-rank-list">
                  {[...(detail.rankings ?? [])]
                    .sort((a, b) => a.rank - b.rank)
                    .map((r) => (
                      <li key={`${detail.matchId}-${r.gameAccountId}-${r.rank}`}>
                        <span className="history-rank-num">#{r.rank}</span>
                        <PlayerAvatarFrame src={r.avatar || DEFAULT_AVATAR} alt="" width={28} height={28} />
                        <span className="history-rank-name">{r.nickname}</span>
                        <span className="history-rank-label">{rankLabel(r.rank)}</span>
                        <span
                          className={`history-rank-result history-rank-result--${r.resultKind ?? (r.rank === 1 ? "win" : "death")}`}
                        >
                          {r.resultText ?? (r.rank === 1 ? "胜利" : "已出局")}
                        </span>
                      </li>
                    ))}
                </ol>
              </div>
            ) : null}
            <h3 className="admin-subheading">操作时间线</h3>
            <div className="game-screen__replay-body admin-replay-body">
              {replayLog.length === 0 ? (
                <p className="admin-muted">本场无复盘日志条目。</p>
              ) : (
                <ul className="game-screen__replay-list">
                  {replayLog.map((e) => (
                    <li key={e.seq} className="game-screen__replay-item">
                      <div className="game-screen__replay-head">
                        <span className="game-screen__replay-seq">#{e.seq + 1}</span>
                        <span className="game-screen__replay-meta">
                          第 {e.roundNumber} 轮 · {e.actorNickname}
                        </span>
                      </div>
                      <p className="game-screen__replay-sum">{e.summary}</p>
                      {e.damage ? <p className="game-screen__replay-dmg">{e.damage}</p> : null}
                      <div className="game-screen__replay-vitals">
                        {Object.entries(e.vitals ?? {}).map(([sid, v]) => (
                          <span key={sid} className="game-screen__replay-vital-chip">
                            {v.nickname} ♥{v.hp} ⚡{v.stamina}
                          </span>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="game-screen__replay-foot">
              <button type="button" className="btn-primary game-screen__replay-save" disabled={saving || replayLog.length === 0} onClick={() => void saveImage()}>
                {saving ? "保存中…" : "导出复盘长图"}
              </button>
              <button type="button" className="btn-secondary game-screen__replay-close-bottom" onClick={onClose}>
                关闭
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
