import { useCallback, useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import { GameScreen } from "@/components/game/GameScreen";
import type { GameClientState } from "@/types/game";
import { adminFetch } from "@/utils/adminApi";

const POLL_MS = 1200;

type Props = {
  roomCode: string;
  onClose: () => void;
};

export function AdminSpectateOverlay({ roomCode, onClose }: Props) {
  const socket = useMemo(
    () =>
      io(import.meta.env.VITE_SOCKET_URL || undefined, {
        path: "/socket.io",
        transports: ["websocket", "polling"],
        autoConnect: true,
      }),
    []
  );

  const [state, setState] = useState<GameClientState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const s = await adminFetch<GameClientState>(`/games/${roomCode}/state`);
      setState(s);
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "加载失败";
      setError(msg);
    }
  }, [roomCode]);

  useEffect(() => {
    void poll();
    const id = window.setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  useEffect(() => {
    return () => {
      socket.disconnect();
    };
  }, [socket]);

  const myId = state?.players[0]?.socketId ?? "__admin__";

  return (
    <div className="admin-spectate-root">
      <div className="admin-spectate-banner" role="status">
        <span>
          管理员观战 · 房间 <strong className="admin-code">{roomCode}</strong> · 约每 {POLL_MS / 1000}s 刷新
        </span>
        <button type="button" className="admin-btn" onClick={onClose}>
          关闭观战
        </button>
      </div>
      {error && !state ? (
        <div className="admin-spectate-fallback">
          <p className="admin-error">{error}</p>
          <p className="admin-muted">对局可能已结束或房间号无效。</p>
          <button type="button" className="btn-secondary" onClick={onClose}>
            返回
          </button>
        </div>
      ) : null}
      {error && state ? (
        <p className="admin-spectate-warn" role="status">
          {error}（已保留上一帧画面）
        </p>
      ) : null}
      {!state && !error ? (
        <div className="admin-spectate-fallback">
          <p className="admin-hint">正在加载观战视角…</p>
        </div>
      ) : null}
      {state ? (
        <div className="admin-spectate-game-wrap">
          <GameScreen
            state={state}
            myId={myId}
            socket={socket}
            onLeaveRoom={onClose}
            onDismissGameEnd={onClose}
            onActionError={() => undefined}
          />
        </div>
      ) : null}
    </div>
  );
}
