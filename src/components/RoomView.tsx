import { useState } from "react";
import { ALLOWED_GRID_SIZES, mapSizeLabel } from "@/constants/mapSizes";
import { MATCH_MODE_OPTIONS, matchModeConfig, teamIdForSlot, type MatchMode } from "@/constants/matchModes";
import type { PlayerPublic, RoomState, SpectatorSeatPublic } from "@/types/room";
import { PlayerAvatarFrame } from "@/components/PlayerAvatarFrame";
import { DEFAULT_AVATAR } from "@/utils/defaultAvatar";

const SPECTATOR_BENCH_COLS = 4;

type Props = {
  state: RoomState;
  myId: string;
  onLeave: () => void;
  onStart: () => void;
  onPickSlot: (slotIndex: number) => void;
  onPickSpectatorSlot: (slotIndex: number) => void;
  /** 房主点击空对战席时打开选单（更换位置 / 添加电脑），非房主仍走 onPickSlot */
  onHostPickEmptyBattleSlot?: (slotIndex: number) => void;
  onHostManagePlayer: (targetId: string) => void;
  onSpectate?: () => void;
  onSetGridSize?: (size: number) => void;
  onSetMatchMode?: (mode: MatchMode) => void;
};

function buildSlotMap(state: RoomState): (PlayerPublic | null)[] {
  const { maxSlots, players } = state;
  const arr: (PlayerPublic | null)[] = Array.from({ length: maxSlots }, () => null);
  for (const p of players) {
    if (p.slotIndex >= 0 && p.slotIndex < maxSlots) {
      arr[p.slotIndex] = p;
    }
  }
  return arr;
}

function buildSpectatorSlotRow(state: RoomState): (SpectatorSeatPublic | null)[] {
  const raw = state.spectatorSlots;
  if (raw && raw.length === SPECTATOR_BENCH_COLS) return raw;
  return Array.from({ length: SPECTATOR_BENCH_COLS }, () => null);
}

function CrownBadge() {
  return (
    <span className="crown-badge" title="房主" aria-label="房主">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4.2 8.3 8.4 12l3.6-6 3.6 6 4.2-3.7-1.6 9.7H5.8L4.2 8.3Z" />
        <path d="M6.2 20h11.6" />
      </svg>
    </span>
  );
}

export function RoomView({
  state,
  myId,
  onLeave,
  onStart,
  onPickSlot,
  onPickSpectatorSlot,
  onHostPickEmptyBattleSlot,
  onHostManagePlayer,
  onSpectate,
  onSetGridSize,
  onSetMatchMode,
}: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const isHost = state.hostId === myId;
  const slotMap = buildSlotMap(state);
  const spectatorRow = buildSpectatorSlotRow(state);
  const cfg = matchModeConfig(state.matchMode);
  const startBlockReason = (() => {
    if (state.players.length < 2) return `对战席至少需要 2 名玩家才能开始（最多 ${state.maxSlots} 人）`;
    if (cfg.mode === "solo") return null;
    const counts = new Map<number, number>();
    for (const p of state.players) {
      const tid = teamIdForSlot(state.matchMode, p.slotIndex);
      counts.set(tid, (counts.get(tid) ?? 0) + 1);
    }
    if (counts.size < 2) return "组队模式至少需要两支队伍";
    if ([...counts.values()].some((count) => count !== cfg.teamSize)) return "每支已入座队伍必须坐满";
    return null;
  })();
  const canStartGame = !startBlockReason;

  if (state.waitingToSpectate) {
    return (
      <div className="room-overlay">
        <div className="room-scroll">
          <header className="room-head">
            <div className="room-head__code">
              <div className="room-code-label">房间号</div>
              <div className="room-code">{state.code}</div>
            </div>
            <button type="button" className="link-btn" onClick={onLeave}>
              退出
            </button>
          </header>
          <div className="room-body">
            <p className="room-hint">本房间对局进行中。你以访客身份进入，可观看战局，没有自己的角色。</p>
            <p className="room-meta-line">
              地图：{state.mapSizeLabel ?? `${state.gridSize ?? 15}×${state.gridSize ?? 15}`}
            </p>
          </div>
        </div>
        <div className="room-dock-fixed" aria-label="观战">
          <div className="room-dock-inner">
            <button
              type="button"
              className="btn-primary room-btn-start room-btn-start--floating"
              onClick={() => onSpectate?.()}
            >
              进行观战
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="room-overlay">
        <div className="room-scroll">
          <header className="room-head">
            <div className="room-head__code">
              <div className="room-code-label">房间号</div>
              <div className="room-code">{state.code}</div>
            </div>
            <div className="room-head__actions">
              {isHost && !state.gameInProgress && (
                <button type="button" className="link-btn" onClick={() => setSettingsOpen(true)}>
                  房间设置
                </button>
              )}
              <button type="button" className="link-btn" onClick={onLeave}>
                退出房间
              </button>
            </div>
          </header>

          <div className="room-body">
            <p className="room-hint">
              对战席与观战席分列：点空位入座；点他人席位换位。进入观战席的玩家开局后为观战视角。非房主不可与房主换位。房主点对战席上的对方头像可进行管理。
            </p>
            <p className="room-meta-line">
              对局类型：{state.matchModeLabel ?? cfg.label} · 地图：{state.mapSizeLabel ?? `${state.gridSize ?? 15}×${state.gridSize ?? 15}`}
            </p>
            <div className="room-slots-wrap">
            <div className="room-seat-section-title">对战席</div>
            <div
              className="room-slots"
              role="list"
              aria-label="对战席"
              style={{ ["--room-slot-cols" as string]: String(state.rowSize ?? cfg.rowSize) }}
            >
          {slotMap.map((p, slotIndex) => {
            const teamId = teamIdForSlot(state.matchMode, slotIndex);
            const teamClass = state.matchMode === "solo" ? "" : ` room-slot--team-${teamId % 6}`;
            if (p === null) {
              return (
                <button
                  key={slotIndex}
                  type="button"
                  className={`room-slot room-slot--empty${teamClass}`}
                  onClick={() =>
                    isHost && onHostPickEmptyBattleSlot
                      ? onHostPickEmptyBattleSlot(slotIndex)
                      : onPickSlot(slotIndex)
                  }
                >
                  <span className="room-slot-idx">{slotIndex + 1}</span>
                  {state.matchMode !== "solo" && <span className="room-slot-team">队伍 {teamId + 1}</span>}
                  <span className="room-slot-empty-label">空位</span>
                </button>
              );
            }

            const isSelf = p.socketId === myId;
            const isPeerHost = state.hostId === p.socketId;

            if (isSelf) {
              return (
                <div key={slotIndex} className={`room-slot room-slot--filled room-slot--mine${teamClass}`}>
                  <span className="room-slot-idx" aria-hidden>
                    {slotIndex + 1}
                  </span>
                  <div className="room-slot-face room-slot-face--static">
                    {isPeerHost && <CrownBadge />}
                    {p.isBot && <span className="room-slot-bot-tag">电脑</span>}
                    <PlayerAvatarFrame src={p.avatar || DEFAULT_AVATAR} alt="" variant="fill" />
                    <span className="label">{p.nickname}</span>
                  </div>
                </div>
              );
            }

            if (isHost) {
              return (
                <div key={slotIndex} className={`room-slot room-slot--filled room-slot--host-split${teamClass}`}>
                  <button
                    type="button"
                    className="room-slot-idx-btn"
                    onClick={() => onPickSlot(slotIndex)}
                    title="与此席换位"
                    aria-label={`席位 ${slotIndex + 1}，点击换位`}
                  >
                    {slotIndex + 1}
                  </button>
                  <button
                    type="button"
                    className="room-slot-face room-slot-face--peer"
                    onClick={() => onHostManagePlayer(p.socketId)}
                    title="房主管理"
                  >
                    {isPeerHost && <CrownBadge />}
                    {p.isBot && <span className="room-slot-bot-tag">电脑</span>}
                    <PlayerAvatarFrame src={p.avatar || DEFAULT_AVATAR} alt="" variant="fill" />
                    <span className="label">{p.nickname}</span>
                  </button>
                </div>
              );
            }

            return (
              <button
                key={slotIndex}
                type="button"
                className={`room-slot room-slot--filled room-slot--swap${teamClass}`}
                onClick={() => onPickSlot(slotIndex)}
              >
                <span className="room-slot-idx">{slotIndex + 1}</span>
                <span className="room-slot-face">
                  {isPeerHost && <CrownBadge />}
                  {p.isBot && <span className="room-slot-bot-tag">电脑</span>}
                  <PlayerAvatarFrame src={p.avatar || DEFAULT_AVATAR} alt="" variant="fill" />
                  <span className="label">{p.nickname}</span>
                </span>
              </button>
            );
          })}
            </div>

            <div className="room-seat-section-title room-seat-section-title--spectator">观战席</div>
            <div
              className="room-slots room-slots--spectator"
              role="list"
              aria-label="观战席"
              style={{ ["--room-slot-cols" as string]: String(SPECTATOR_BENCH_COLS) }}
            >
              {spectatorRow.map((p, slotIndex) => {
                const teamClass = " room-slot--spectator-bench";
                if (p === null) {
                  return (
                    <button
                      key={`sp-${slotIndex}`}
                      type="button"
                      className={`room-slot room-slot--empty${teamClass}`}
                      onClick={() => onPickSpectatorSlot(slotIndex)}
                    >
                      <span className="room-slot-idx">{slotIndex + 1}</span>
                      <span className="room-slot-empty-label">空位</span>
                    </button>
                  );
                }

                const isSelf = p.socketId === myId;
                const isPeerHost = state.hostId === p.socketId;

                if (isSelf) {
                  return (
                    <div key={`sp-${slotIndex}`} className={`room-slot room-slot--filled room-slot--mine${teamClass}`}>
                      <span className="room-slot-idx" aria-hidden>
                        {slotIndex + 1}
                      </span>
                      <div className="room-slot-face room-slot-face--static">
                        {isPeerHost && <CrownBadge />}
                        <PlayerAvatarFrame src={p.avatar || DEFAULT_AVATAR} alt="" variant="fill" />
                        <span className="label">{p.nickname}</span>
                      </div>
                    </div>
                  );
                }

                if (isHost) {
                  return (
                    <div key={`sp-${slotIndex}`} className={`room-slot room-slot--filled room-slot--host-split${teamClass}`}>
                      <button
                        type="button"
                        className="room-slot-idx-btn"
                        onClick={() => onPickSpectatorSlot(slotIndex)}
                        title="与此席换位"
                        aria-label={`观战席 ${slotIndex + 1}，点击换位`}
                      >
                        {slotIndex + 1}
                      </button>
                      <button
                        type="button"
                        className="room-slot-face room-slot-face--peer"
                        onClick={() => onPickSpectatorSlot(slotIndex)}
                        title="与此席换位"
                      >
                        {isPeerHost && <CrownBadge />}
                        <PlayerAvatarFrame src={p.avatar || DEFAULT_AVATAR} alt="" variant="fill" />
                        <span className="label">{p.nickname}</span>
                      </button>
                    </div>
                  );
                }

                return (
                  <button
                    key={`sp-${slotIndex}`}
                    type="button"
                    className={`room-slot room-slot--filled room-slot--swap${teamClass}`}
                    onClick={() => onPickSpectatorSlot(slotIndex)}
                  >
                    <span className="room-slot-idx">{slotIndex + 1}</span>
                    <span className="room-slot-face">
                      {isPeerHost && <CrownBadge />}
                      <PlayerAvatarFrame src={p.avatar || DEFAULT_AVATAR} alt="" variant="fill" />
                      <span className="label">{p.nickname}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="room-dock-fixed" aria-label="房间操作">
        <div className="room-dock-inner">
          {isHost && (
            <>
              <button
                type="button"
                className="btn-primary room-btn-start room-btn-start--floating"
                onClick={onStart}
                disabled={!canStartGame}
              >
                开始游戏
              </button>
              {!canStartGame && <p className="room-start-hint">{startBlockReason}</p>}
            </>
          )}
          {!isHost && (
            <p className="room-wait-msg">等待房主开始游戏…</p>
          )}
        </div>
      </div>
      </div>

      {isHost && settingsOpen && !state.gameInProgress && (
        <div
          className="overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="room-settings-title"
          onClick={() => setSettingsOpen(false)}
        >
          <div className="modal modal--room-settings" onClick={(e) => e.stopPropagation()}>
            <h3 id="room-settings-title">房间设置</h3>
            <p className="modal-hint">仅在开局前可修改；全员可见上方摘要。</p>
            <div className="room-map-picker" style={{ marginBottom: 12 }}>
              <span className="room-map-picker__label">对局类型</span>
              {MATCH_MODE_OPTIONS.map((mode) => (
                <button
                  key={mode.mode}
                  type="button"
                  className={
                    "room-map-chip" + ((state.matchMode ?? "solo") === mode.mode ? " room-map-chip--active" : "")
                  }
                  disabled={(state.matchMode ?? "solo") === mode.mode}
                  onClick={() => onSetMatchMode?.(mode.mode)}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            <div className="room-map-picker" style={{ marginBottom: 16 }}>
              <span className="room-map-picker__label">地图尺寸</span>
              {ALLOWED_GRID_SIZES.map((sz) => (
                <button
                  key={sz}
                  type="button"
                  className={"room-map-chip" + ((state.gridSize ?? 15) === sz ? " room-map-chip--active" : "")}
                  disabled={(state.gridSize ?? 15) === sz}
                  onClick={() => onSetGridSize?.(sz)}
                >
                  {mapSizeLabel(sz)}
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn-primary" onClick={() => setSettingsOpen(false)}>
                完成
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
