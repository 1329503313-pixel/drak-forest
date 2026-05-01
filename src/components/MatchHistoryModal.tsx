import { useCallback, useEffect, useState } from "react";
import type { GameReplayEntryView } from "@/types/game";
import type { MatchHistoryDetail, MatchHistoryItem } from "@/types/match";
import { PlayerAvatarFrame } from "@/components/PlayerAvatarFrame";
import { DEFAULT_AVATAR } from "@/utils/defaultAvatar";
import { mapSizeLabel } from "@/constants/mapSizes";
import { fetchMatchDetail, fetchMatchList } from "@/utils/matchApi";
import { exportReplayImage } from "@/utils/replayImage";

type Props = {
  open: boolean;
  gameAccountId: string;
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

export function MatchHistoryModal({ open, gameAccountId, onClose }: Props) {
  const [list, setList] = useState<MatchHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);
  const [replay, setReplay] = useState<MatchHistoryDetail | null>(null);
  const [replayBusy, setReplayBusy] = useState(false);
  const [replayErr, setReplayErr] = useState<string | null>(null);
  const [replaySaving, setReplaySaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setListErr(null);
    try {
      const rows = await fetchMatchList(gameAccountId);
      setList(rows);
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "加载失败");
      setList([]);
    } finally {
      setLoading(false);
    }
  }, [gameAccountId]);

  useEffect(() => {
    if (!open || !gameAccountId) return;
    void load();
    setReplay(null);
  }, [open, gameAccountId, load]);

  const openReplay = async (matchId: string) => {
    setReplayBusy(true);
    setReplayErr(null);
    try {
      const d = await fetchMatchDetail(matchId, gameAccountId);
      setReplay(d);
    } catch (e) {
      setReplayErr(e instanceof Error ? e.message : "加载复盘失败");
    } finally {
      setReplayBusy(false);
    }
  };

  const saveReplayImage = async () => {
    if (!replay || replayLog.length === 0) return;
    setReplaySaving(true);
    try {
      await exportReplayImage({
        title: "复盘记录",
        subtitle: `${formatTime(replay.endedAt)} · 房间 ${replay.roomCode} · ${replay.mapSizeLabel ?? mapSizeLabel(replay.gridSize ?? 15)}`,
        entries: replayLog,
        filename: `replay-${replay.roomCode}-${replay.matchId.slice(0, 8)}.png`,
      });
    } catch (e) {
      setReplayErr(e instanceof Error ? e.message : "保存复盘记录失败");
    } finally {
      setReplaySaving(false);
    }
  };

  if (!open) return null;

  const showEmpty = !loading && !listErr && list.length === 0;
  const replayLog = Array.isArray(replay?.replayLog)
    ? (replay.replayLog as GameReplayEntryView[])
    : [];

  return (
    <>
      <div className="overlay" role="dialog" aria-modal="true" onClick={onClose}>
        <div className="modal modal--history" onClick={(e) => e.stopPropagation()}>
          <h3>对局记录</h3>
          {loading ? <p className="modal-hint">加载中…</p> : null}
          {listErr ? <p className="modal-error">{listErr}</p> : null}
          {replayErr ? <p className="modal-error">{replayErr}</p> : null}
          {showEmpty ? (
            <p className="modal-hint" role="status">
              对局记录为空。完成并结算对局后，将在此显示历史对局。
            </p>
          ) : null}
          {list.length > 0 ? (
          <ul className="history-list">
            {list.map((m) => (
              <li key={m.matchId} className="history-row">
                <div className="history-row__main">
                  <div className="history-row__time">{formatTime(m.endedAt)}</div>
                  <div className="history-row__meta">
                    房间 {m.roomCode} · {m.mapSizeLabel ?? mapSizeLabel(m.gridSize ?? 15)}
                  </div>
                  <ol className="history-ranks">
                    {[...m.rankings]
                      .sort((a, b) => a.rank - b.rank)
                      .map((r) => (
                        <li key={`${m.matchId}-${r.gameAccountId}-${r.rank}`}>
                          <span className="history-rank-num">#{r.rank}</span>
                          <PlayerAvatarFrame src={r.avatar || DEFAULT_AVATAR} alt="" width={28} height={28} />
                          <span className="history-rank-name">{r.nickname}</span>
                          <span className="history-rank-label">{rankLabel(r.rank)}</span>
                          <span className={`history-rank-result history-rank-result--${r.resultKind ?? (r.rank === 1 ? "win" : "death")}`}>
                            {r.resultText ?? (r.rank === 1 ? "胜利" : "已出局")}
                          </span>
                        </li>
                      ))}
                  </ol>
                </div>
                <button
                  type="button"
                  className="btn-secondary history-replay-btn"
                  disabled={replayBusy}
                  onClick={() => void openReplay(m.matchId)}
                >
                  复盘记录
                </button>
              </li>
            ))}
          </ul>
          ) : null}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      </div>

      {replay && (
        <div
          className="game-screen__replay-overlay game-screen__replay-overlay--stack-top"
          role="dialog"
          aria-modal="true"
          onClick={() => setReplay(null)}
        >
          <div className="game-screen__replay-inner" onClick={(e) => e.stopPropagation()}>
            <div className="game-screen__replay-top">
              <h3>复盘记录</h3>
              <button
                type="button"
                className="game-screen__replay-close-x"
                aria-label="关闭"
                onClick={() => setReplay(null)}
              >
                ×
              </button>
            </div>
            <p className="modal-hint" style={{ margin: "0 16px 10px" }}>
              {formatTime(replay.endedAt)} · 房间 {replay.roomCode} ·{" "}
              {replay.mapSizeLabel ?? mapSizeLabel(replay.gridSize ?? 15)}
            </p>
            <div className="game-screen__replay-body">
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
            </div>
            <div className="game-screen__replay-foot">
              <button
                type="button"
                className="btn-primary game-screen__replay-save"
                disabled={replaySaving}
                onClick={() => void saveReplayImage()}
              >
                {replaySaving ? "保存中…" : "保存记录"}
              </button>
              <button type="button" className="btn-secondary game-screen__replay-close-bottom" onClick={() => setReplay(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
