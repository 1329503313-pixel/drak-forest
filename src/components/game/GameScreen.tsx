import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Socket } from "socket.io-client";
import {
  ATTACK_DAMAGE,
  MAP_COORD_MIN_CELL_PX,
  MAP_ZOOM_MAX,
  MAP_ZOOM_MIN,
} from "@/constants/game";
import { useMapViewportBasePx } from "@/hooks/useMapViewportBasePx";
import type {
  ClientGameAction,
  GamePlayerView,
  GameClientState,
  GameReplayEntryView,
  SkillId,
} from "@/types/game";
import { PlayerAvatarFrame } from "@/components/PlayerAvatarFrame";
import { DEFAULT_AVATAR } from "@/utils/defaultAvatar";
import { exportReplayImage } from "@/utils/replayImage";
import {
  adjacentEnemyAt,
  attackRangeKeys,
  blockedCellsForMove,
  buildPathFromBfs,
  cellKey,
  inBounds,
  jetReachableKeys,
  keysOutsidePlayable,
  laserRayCells,
  outerRingKeys,
  parseKey,
  reachableOrthogonalCells,
  skillAoeKeys,
  inPlayableArea,
} from "./gameClient";

const MOVE_STEP_MS = 115;
const MAX_VITAL_VALUE = 10;
const MAX_SKILL_COUNT = 5;

const SKILL_WITH_AIM_DELAY: SkillId[] = ["missile", "burn", "flare", "sniper", "jump"];
const EVENT_LABELS = {
  volcano: "火山喷发",
  earthquake: "地震",
  rain: "天降甘霖",
} as const;
const LASER_DIRS: Array<[number, number, string]> = [
  [1, 0, "→"],
  [-1, 0, "←"],
  [0, 1, "↓"],
  [0, -1, "↑"],
  [1, 1, "↘"],
  [1, -1, "↗"],
  [-1, 1, "↙"],
  [-1, -1, "↖"],
];

type UiMode =
  | { t: "idle" }
  | { t: "attack" }
  | { t: "move" }
  | { t: "rest" }
  | { t: "skillMenu" }
  | { t: "skillLaser" }
  | { t: "skillTarget"; skill: SkillId }
  | { t: "skillBounty" };

type MoveAnim = {
  actorId: string;
  positions: Array<{ col: number; row: number }>;
  step: number;
  path: Array<{ col: number; row: number }>;
};

type BeastAnim = {
  positions: Array<{ col: number; row: number }>;
  step: number;
};

function colLetter(c: number): string {
  return String.fromCharCode("A".charCodeAt(0) + c);
}

type Props = {
  state: GameClientState;
  myId: string;
  socket: Socket;
  onLeaveRoom: () => void;
  /** 对局进行中返回房间（不退出房间） */
  onRetireToLobby?: () => void;
  /** 结算界面关闭、仅收起游戏 UI */
  onDismissGameEnd?: () => void;
  playerLeftBanner?: string | null;
  onActionError: (msg: string) => void;
  onActionSuccess?: (msg: string) => void;
};

type ActionResult = {
  learnedSkill?: { id: SkillId; name: string };
  overwrittenSkill?: { id: SkillId; name: string };
};

export function GameScreen({
  state,
  myId,
  socket,
  onLeaveRoom,
  onRetireToLobby,
  onDismissGameEnd,
  playerLeftBanner,
  onActionError,
  onActionSuccess,
}: Props) {
  const n = state.gridSize;
  const isSpectator = state.isSpectator === true || state.isEliminatedSpectator === true;
  const spectatorReplayEntries = useMemo(() => {
    const log = state.replayLog ?? [];
    return [...log].sort((a, b) => a.seq - b.seq);
  }, [state.replayLog]);
  const visible = useMemo(() => new Set(state.visibleCells), [state.visibleCells]);
  const me = state.players.find((p) => p.socketId === myId);
  const tf = state.turnFlags ?? {
    didAttack: false,
    learnCount: 0,
    skillIdsUsed: [],
    didRest: false,
    didMove: false,
  };

  const [zoom, setZoom] = useState(1);
  const [uiMode, setUiMode] = useState<UiMode>({ t: "idle" });
  const [moveAnim, setMoveAnim] = useState<MoveAnim | null>(null);
  const [beastAnim, setBeastAnim] = useState<BeastAnim | null>(null);
  const [beastDamageKeys, setBeastDamageKeys] = useState<Set<string>>(new Set());
  const [aliveModalOpen, setAliveModalOpen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const [attackConfirm, setAttackConfirm] = useState<{
    col: number;
    row: number;
    label: string;
  } | null>(null);
  const [skillAimPending, setSkillAimPending] = useState<{
    skill: SkillId;
    col: number;
    row: number;
    aoeKeys: Set<string>;
  } | null>(null);
  const [skillAimBlink, setSkillAimBlink] = useState(0);
  const [laserFx, setLaserFx] = useState<{ keys: string[]; pulseIdx: number } | null>(null);
  const [damageNotice, setDamageNotice] = useState<string | null>(null);
  const [turnPromptOpen, setTurnPromptOpen] = useState(false);
  const [replaySaving, setReplaySaving] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const spectatorStreamRef = useRef<HTMLDivElement>(null);
  const wasMyTurnRef = useRef(false);
  const seenBeastSpawnRoundRef = useRef<number | null>(null);
  const lastDamageSeqRef = useRef<number>(-1);
  const mapDragRef = useRef<{
    sx: number;
    sy: number;
    sl: number;
    st: number;
  } | null>(null);
  const dragMovedRef = useRef(false);

  const mapViewportBasePx = useMapViewportBasePx();

  /** 驱动回合倒计时与截止对齐 */
  const [, setTurnDeadlineTick] = useState(0);
  useEffect(() => {
    if (!state.isMyTurn || state.phase !== "playing" || state.isBeastTurn || state.turnDeadlineAt == null) return;
    const id = window.setInterval(() => setTurnDeadlineTick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [state.isMyTurn, state.phase, state.isBeastTurn, state.turnDeadlineAt, state.turnOf]);

  useEffect(() => {
    if (!state.isMyTurn || state.phase !== "playing") setUiMode({ t: "idle" });
  }, [state.isMyTurn, state.phase, state.roundNumber, state.turnOf]);

  useEffect(() => {
    if (!isSpectator) return;
    const el = spectatorStreamRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [isSpectator, spectatorReplayEntries.length, state.phase]);

  useEffect(() => {
    if (!state.isMyTurn) {
      setAttackConfirm(null);
      setSkillAimPending(null);
    }
  }, [state.isMyTurn]);

  useEffect(() => {
    if (!myId || !state.replayLog?.length || isSpectator) return;
    for (const entry of state.replayLog) {
      if (entry.seq <= lastDamageSeqRef.current) continue;
      const hits = (entry.damageEvents ?? []).filter((e) => e.targetId === myId && e.amount > 0);
      if (hits.length > 0) {
        const text = hits
          .map((e) => `${e.sourceNickname} 对你造成 ${e.amount} 点伤害`)
          .join("；");
        setDamageNotice(text);
        window.setTimeout(() => setDamageNotice(null), 6000);
      }
      lastDamageSeqRef.current = Math.max(lastDamageSeqRef.current, entry.seq);
    }
  }, [state.replayLog, myId, isSpectator]);

  useEffect(() => {
    if (!skillAimPending) {
      setSkillAimBlink(0);
      return;
    }
    setSkillAimBlink(0);
    const blinkIv = window.setInterval(() => setSkillAimBlink((x) => x + 1), 1000);
    return () => window.clearInterval(blinkIv);
  }, [skillAimPending]);

  useEffect(() => {
    if (!laserFx) return;
    if (laserFx.keys.length === 0) {
      setLaserFx(null);
      return;
    }
    if (laserFx.pulseIdx > laserFx.keys.length) {
      setLaserFx(null);
      return;
    }
    if (laserFx.pulseIdx === laserFx.keys.length) {
      const t = window.setTimeout(() => setLaserFx(null), 420);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => {
      setLaserFx((fx) => (fx ? { ...fx, pulseIdx: fx.pulseIdx + 1 } : null));
    }, 65);
    return () => window.clearTimeout(t);
  }, [laserFx]);

  const emitAction = useCallback(
    (action: ClientGameAction, opts?: { onOkMsg?: string; onOk?: (data?: ActionResult) => void }) => {
      socket.emit("game:action", action, (err: string | null, data?: ActionResult) => {
        if (err) onActionError(err);
        else {
          setUiMode({ t: "idle" });
          opts?.onOk?.(data);
          if (opts?.onOkMsg) onActionSuccess?.(opts.onOkMsg);
        }
      });
    },
    [socket, onActionError, onActionSuccess]
  );

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.08 : 0.08;
      setZoom((z) => Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, z + delta)));
    };
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);

  const onViewportPointerDown = (e: React.PointerEvent) => {
    const el = viewportRef.current;
    if (!el) return;
    dragMovedRef.current = false;
    mapDragRef.current = {
      sx: e.clientX,
      sy: e.clientY,
      sl: el.scrollLeft,
      st: el.scrollTop,
    };

    const move = (ev: PointerEvent) => {
      const d = mapDragRef.current;
      const vp = viewportRef.current;
      if (!d || !vp) return;
      const dx = ev.clientX - d.sx;
      const dy = ev.clientY - d.sy;
      if (dx * dx + dy * dy > 36) dragMovedRef.current = true;
      vp.scrollLeft = d.sl - dx;
      vp.scrollTop = d.st - dy;
    };
    const end = () => {
      mapDragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const shrinkM = state.shrinkMargin ?? 0;
  const wallSet = useMemo(() => new Set(state.wallKeys ?? []), [state.wallKeys]);
  const voidKeys = useMemo(() => keysOutsidePlayable(n, shrinkM), [n, shrinkM]);
  const shrinkWarningKeys = useMemo(() => {
    if (state.poisonWarningKeys?.length) return new Set(state.poisonWarningKeys);
    if (state.roundNumber >= 3 && (state.roundNumber - 3) % 3 === 0) return outerRingKeys(shrinkM, n);
    return new Set<string>();
  }, [state.poisonWarningKeys, state.roundNumber, shrinkM, n]);
  const poisonShrinkBannerActive = shrinkWarningKeys.size > 0;
  const beastWarningActive = state.phase === "playing" && state.roundNumber === 6 && !state.beast;
  const eventCellSet = useMemo(() => new Set(state.mapEvent?.cellKeys ?? []), [state.mapEvent]);
  const beastCellSet = useMemo(() => new Set(state.beast?.cellKeys ?? []), [state.beast]);

  const blocked = useMemo(() => {
    const b = blockedCellsForMove(state, myId);
    voidKeys.forEach((k) => b.add(k));
    return b;
  }, [state, myId, voidKeys]);

  const meCol = me?.col ?? -1;
  const meRow = me?.row ?? -1;
  const meOk = meCol >= 0 && meRow >= 0 && !me?.eliminated;

  const { reachableKeys, movePrev } = useMemo(() => {
    if (!meOk || !me) return { reachableKeys: new Set<string>(), movePrev: new Map<string, string | null>() };
    const stamina = me.stamina ?? 0;
    const { reachable, prev } = reachableOrthogonalCells(meCol, meRow, stamina, n, blocked);
    return { reachableKeys: reachable, movePrev: prev };
  }, [meOk, me, meCol, meRow, n, blocked]);

  const attackKeys = useMemo(() => {
    if (!meOk) return new Set<string>();
    const raw = attackRangeKeys(meCol, meRow, n);
    const out = new Set<string>();
    for (const k of raw) {
      const { col, row } = parseKey(k);
      if (inPlayableArea(col, row, n, shrinkM)) out.add(k);
    }
    return out;
  }, [meOk, meCol, meRow, n, shrinkM]);

  const jetKeys = useMemo(() => {
    if (!meOk) return new Set<string>();
    return jetReachableKeys(meCol, meRow, n, blocked);
  }, [meOk, meCol, meRow, n, blocked]);

  const adjEnemy = useMemo(
    () => (meOk ? adjacentEnemyAt(state, myId, meCol, meRow) : new Map()),
    [meOk, state, myId, meCol, meRow]
  );

  const bountyTargets = useMemo(() => {
    const myTeam = me?.teamId;
    return state.players.filter(
      (p) =>
        p.socketId !== myId &&
        ((state.teamSize ?? 1) <= 1 || p.teamId !== myTeam) &&
        !p.eliminated &&
        p.col != null &&
        p.row != null
    );
  }, [state.players, state.teamSize, myId, me?.teamId]);

  const alivePlayers = useMemo(
    () => state.players.filter((p) => !p.eliminated && p.hp > 0),
    [state.players]
  );

  const myTurnSecondsLeft =
    state.isMyTurn &&
    state.phase === "playing" &&
    !state.isBeastTurn &&
    !me?.eliminated &&
    typeof state.turnDeadlineAt === "number"
      ? Math.max(0, Math.ceil((state.turnDeadlineAt - Date.now()) / 1000))
      : null;

  const burningSet = useMemo(
    () => new Set(state.burningCellKeys ?? []),
    [state.burningCellKeys]
  );

  const cellSelfClass = (col: number, row: number) => {
    if (!meOk || col !== meCol || row !== meRow) return "";
    if ((state.teamSize ?? 1) > 1 && me?.teamId != null) return ` game-screen__cell--team-${me.teamId % 6}`;
    return " game-screen__cell--self";
  };

  const cellFactionClass = (here: GamePlayerView[], isVoid: boolean) => {
    if (isVoid) return "";
    const onCell = here.filter((p) => !p.eliminated && p.col != null && p.row != null);
    if (onCell.length === 0) return "";
    if ((state.teamSize ?? 1) > 1) {
      const teamId = onCell[0]?.teamId ?? 0;
      return ` game-screen__cell--team-${teamId % 6}`;
    }
    if (onCell.some((p) => p.socketId === myId)) return "";
    if (onCell.some((p) => p.socketId !== myId)) return " game-screen__cell--faction-enemy";
    return "";
  };

  const gridPx = mapViewportBasePx * zoom;
  const wrapSize = Math.max(gridPx, mapViewportBasePx);
  const cellPx = gridPx / Math.max(1, n);
  const showGridCoords = cellPx >= MAP_COORD_MIN_CELL_PX;

  const scrollViewportToCell = useCallback(
    (col: number, row: number) => {
      const vp = viewportRef.current;
      if (!vp) return;
      const cell = gridPx / n;
      const pad = (wrapSize - gridPx) / 2;
      const cx = pad + (col + 0.5) * cell;
      const cy = pad + (row + 0.5) * cell;
      const maxL = Math.max(0, vp.scrollWidth - vp.clientWidth);
      const maxT = Math.max(0, vp.scrollHeight - vp.clientHeight);
      vp.scrollLeft = Math.min(maxL, Math.max(0, cx - vp.clientWidth / 2));
      vp.scrollTop = Math.min(maxT, Math.max(0, cy - vp.clientHeight / 2));
    },
    [gridPx, n, wrapSize]
  );

  useLayoutEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    vp.scrollLeft = Math.min(vp.scrollLeft, Math.max(0, vp.scrollWidth - vp.clientWidth));
    vp.scrollTop = Math.min(vp.scrollTop, Math.max(0, vp.scrollHeight - vp.clientHeight));
  }, [mapViewportBasePx]);

  useLayoutEffect(() => {
    const nowMine =
      state.phase === "playing" && state.isMyTurn && state.turnOf === myId && meOk;
    if (nowMine && !wasMyTurnRef.current) {
      setTurnPromptOpen(true);
      const c = meCol;
      const r = meRow;
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollViewportToCell(c, r));
      });
      wasMyTurnRef.current = true;
      return () => cancelAnimationFrame(id);
    }
    wasMyTurnRef.current = nowMine;
  }, [
    state.phase,
    state.isMyTurn,
    state.turnOf,
    myId,
    meOk,
    meCol,
    meRow,
    scrollViewportToCell,
  ]);

  useLayoutEffect(() => {
    const beast = state.beast;
    if (!beast || seenBeastSpawnRoundRef.current === beast.spawnedRound) return;
    seenBeastSpawnRoundRef.current = beast.spawnedRound;
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollViewportToCell(beast.col + 0.5, beast.row + 0.5));
    });
    return () => cancelAnimationFrame(id);
  }, [state.beast, scrollViewportToCell]);

  useLayoutEffect(() => {
    if (!skillAimPending) return;
    const { col, row } = skillAimPending;
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollViewportToCell(col, row));
    });
    return () => cancelAnimationFrame(id);
  }, [skillAimPending, scrollViewportToCell]);

  const canAttack =
    !tf.didAttack && !tf.learnCount && (tf.skillIdsUsed?.length ?? 0) === 0;
  const canSkillTree =
    !tf.didAttack &&
    (tf.skillIdsUsed?.length ?? 0) < 2 &&
    !tf.didRest;
  const canRestBase =
    !tf.didMove &&
    !tf.didAttack &&
    tf.learnCount === 0 &&
    (tf.skillIdsUsed?.length ?? 0) === 0 &&
    !tf.didRest;

  const mySkills = (me?.skills ?? []) as SkillId[];
  const cd = state.mySkillCooldowns ?? {};

  const skillUsable = useCallback(
    (sk: SkillId): boolean => {
      if (!me || mySkills.indexOf(sk) < 0) return false;
      if ((cd[sk] ?? 0) > 0) return false;
      const meta = state.skillMeta[sk];
      if (!meta) return false;
      if ((me.stamina ?? 0) < meta.cost) return false;
      if (!canSkillTree) return false;
      if ((tf.skillIdsUsed as SkillId[]).includes(sk)) return false;
      return true;
    },
    [me, mySkills, cd, state.skillMeta, canSkillTree, tf.skillIdsUsed]
  );

  const endTurn = () => emitAction({ kind: "endTurn" }, { onOkMsg: "已结束回合" });

  const tryAttackMode = () => {
    if ((me?.stamina ?? 0) < 2) {
      onActionError("体力不足，无法攻击（需要 2 点体力）");
      return;
    }
    if (!canAttack) {
      if (tf.didAttack) onActionError("本回合已攻击");
      else onActionError("本回合已学习或使用技能，无法攻击");
      return;
    }
    setUiMode({ t: "attack" });
  };

  const tryMoveMode = () => {
    if (tf.didRest) {
      onActionError("本回合已休息，无法移动");
      return;
    }
    if ((me?.stamina ?? 0) < 1) {
      onActionError("体力不足，无法移动");
      return;
    }
    setUiMode({ t: "move" });
  };

  const tryRestMode = () => {
    if (!canRestBase) {
      if (tf.didRest) onActionError("本回合已休息");
      else if (tf.didMove) onActionError("已移动过，本回合无法休息");
      else if (tf.didAttack) onActionError("已攻击过，本回合无法休息");
      else if (tf.learnCount > 0) onActionError("已学习过，本回合无法休息");
      else if ((tf.skillIdsUsed?.length ?? 0) > 0) onActionError("已使用过技能，本回合无法休息");
      else onActionError("当前无法休息");
      return;
    }
    setUiMode({ t: "rest" });
  };

  const restHp = () => {
    if ((me?.hp ?? 0) >= MAX_VITAL_VALUE) {
      onActionError("生命已达上限，无法恢复");
      return;
    }
    emitAction({ kind: "rest", mode: "hp" }, { onOkMsg: "已恢复生命并休息" });
  };

  const restStamina = () => {
    if ((me?.stamina ?? 0) >= MAX_VITAL_VALUE) {
      onActionError("体力已达上限，无法恢复");
      return;
    }
    emitAction({ kind: "rest", mode: "stamina" }, { onOkMsg: "已恢复体力并休息" });
  };

  const tryLearn = () => {
    if ((me?.stamina ?? 0) < 3) {
      onActionError("体力不足，无法学习（需要 3 点体力）");
      return;
    }
    if (tf.didAttack) {
      onActionError("本回合已攻击，无法学习");
      return;
    }
    if (tf.learnCount >= 2) {
      onActionError("本回合学习次数已达上限");
      return;
    }
    if (tf.didRest) {
      onActionError("本回合已休息");
      return;
    }
    const confirmOverwrite = mySkills.length >= MAX_SKILL_COUNT;
    if (
      confirmOverwrite &&
      !window.confirm("已经拥有5个技能，继续学习将随机覆盖一个，是否继续学习？")
    ) {
      return;
    }
    emitAction(
      { kind: "learn", confirmOverwrite },
      {
        onOk: (data) => {
          const learned = data?.learnedSkill?.name;
          const overwritten = data?.overwrittenSkill?.name;
          if (learned && overwritten) onActionSuccess?.(`学习获得「${learned}」，随机覆盖「${overwritten}」`);
          else if (learned) onActionSuccess?.(`学习获得「${learned}」`);
          else onActionSuccess?.("学习完成");
        },
      }
    );
  };

  const trySkillMenu = () => {
    if (mySkills.length === 0) {
      onActionError("尚未掌握任何技能");
      return;
    }
    if (!canSkillTree) {
      if (tf.didAttack) onActionError("本回合已攻击，无法使用技能");
      else onActionError("本回合无法使用技能");
      return;
    }
    setUiMode({ t: "skillMenu" });
  };

  const playMoveAnimation = useCallback(
    (
      actorId: string,
      positions: Array<{ col: number; row: number }>,
      path: Array<{ col: number; row: number }>,
      onDone?: () => void
    ) => {
      let step = 0;
      setMoveAnim({ actorId, positions, step: 0, path });

      const advance = () => {
        if (step >= positions.length - 1) {
          setMoveAnim(null);
          onDone?.();
          return;
        }
        step++;
        setMoveAnim({ actorId, positions, step, path });
        window.setTimeout(advance, MOVE_STEP_MS);
      };
      window.setTimeout(advance, MOVE_STEP_MS);
    },
    []
  );

  const playBeastAnimation = useCallback(
    (
      positions: Array<{ col: number; row: number }>,
      damageEvents?: GameReplayEntryView["damageEvents"]
    ) => {
      if (positions.length === 0) return;
      let step = 0;
      setBeastAnim({ positions, step: 0 });

      const finish = () => {
        setBeastAnim(null);
        const damaged = new Set<string>();
        const text = (damageEvents ?? [])
          .filter((e) => e.targetId === myId && e.amount > 0)
          .map((e) => {
            const target = state.players.find((p) => p.socketId === e.targetId);
            if (target?.col != null && target.row != null) damaged.add(cellKey(target.col, target.row));
            return `巨兽对你造成 ${e.amount} 点伤害`;
          })
          .join("；");
        for (const e of damageEvents ?? []) {
          const target = state.players.find((p) => p.socketId === e.targetId);
          if (target?.col != null && target.row != null) damaged.add(cellKey(target.col, target.row));
        }
        if (damaged.size > 0) {
          setBeastDamageKeys(damaged);
          window.setTimeout(() => setBeastDamageKeys(new Set()), 700);
        }
        if (text) {
          setDamageNotice(text);
          window.setTimeout(() => setDamageNotice(null), 6000);
        }
      };

      const advance = () => {
        if (step >= positions.length - 1) {
          finish();
          return;
        }
        step++;
        setBeastAnim({ positions, step });
        window.setTimeout(advance, MOVE_STEP_MS);
      };
      window.setTimeout(advance, MOVE_STEP_MS);
    },
    [myId, state.players]
  );

  const runMoveAnimationThenEmit = useCallback(
    (path: Array<{ col: number; row: number }>) => {
      const positions = [{ col: meCol, row: meRow }, ...path];
      playMoveAnimation(myId, positions, path, () =>
        emitAction({ kind: "move", path }, { onOkMsg: "移动完成" })
      );
    },
    [meCol, meRow, myId, emitAction, playMoveAnimation]
  );

  useEffect(() => {
    const onGameMove = (payload: {
      actorId?: string;
      from?: { col: number; row: number };
      path?: Array<{ col: number; row: number }>;
    }) => {
      if (!payload.actorId || payload.actorId === myId) return;
      if (!payload.from || !Array.isArray(payload.path) || payload.path.length === 0) return;
      let visiblePositions = [payload.from, ...payload.path];
      if (!isSpectator) {
        visiblePositions = visiblePositions.filter((cell) => visible.has(cellKey(cell.col, cell.row)));
        if (visiblePositions.length < 2) return;
        const longestRun: Array<{ col: number; row: number }> = [];
        let run: Array<{ col: number; row: number }> = [];
        for (const cell of visiblePositions) {
          const prev = run[run.length - 1];
          if (!prev || Math.abs(prev.col - cell.col) + Math.abs(prev.row - cell.row) === 1) {
            run.push(cell);
          } else {
            if (run.length > longestRun.length) longestRun.splice(0, longestRun.length, ...run);
            run = [cell];
          }
        }
        if (run.length > longestRun.length) longestRun.splice(0, longestRun.length, ...run);
        if (longestRun.length < 2) return;
        visiblePositions = longestRun;
      }
      playMoveAnimation(payload.actorId, visiblePositions, visiblePositions.slice(1));
    };
    socket.on("game:move", onGameMove);
    return () => {
      socket.off("game:move", onGameMove);
    };
  }, [socket, myId, playMoveAnimation, isSpectator, visible]);

  useEffect(() => {
    const onBeastMove = (payload: {
      from?: { col: number; row: number };
      path?: Array<{ col: number; row: number }>;
      damageEvents?: GameReplayEntryView["damageEvents"];
    }) => {
      if (!payload.from) return;
      playBeastAnimation([payload.from, ...(payload.path ?? [])], payload.damageEvents);
    };
    socket.on("game:beastMove", onBeastMove);
    return () => {
      socket.off("game:beastMove", onBeastMove);
    };
  }, [socket, playBeastAnimation]);

  const formatCellLabel = (col: number, row: number) =>
    `${colLetter(col)}${row + 1}`;

  const onCellClick = (col: number, row: number) => {
    if (dragMovedRef.current) return;
    if (moveAnim) return;
    if (!state.isMyTurn || state.phase !== "playing" || !meOk || !me) return;

    const key = cellKey(col, row);
    if (wallSet.has(key)) return;

    if (uiMode.t === "attack") {
      if (!attackKeys.has(key)) return;
      setAttackConfirm({ col, row, label: formatCellLabel(col, row) });
      return;
    }

    if (uiMode.t === "move") {
      if (col === meCol && row === meRow) return;
      if (!reachableKeys.has(key)) return;
      const path = buildPathFromBfs(col, row, meCol, meRow, movePrev);
      if (!path?.length) {
        onActionError("无法到达该格");
        return;
      }
      runMoveAnimationThenEmit(path);
      return;
    }

    if (uiMode.t === "skillTarget") {
      const sk = uiMode.skill;
      if (SKILL_WITH_AIM_DELAY.includes(sk)) {
        if (!inBounds(col, row, n)) return;
        if (skillAimPending) {
          if (skillAimPending.skill !== sk) return;
          setSkillAimPending({
            skill: sk,
            col,
            row,
            aoeKeys: skillAoeKeys(sk, col, row, n),
          });
          return;
        }
        setSkillAimPending({
          skill: sk,
          col,
          row,
          aoeKeys: skillAoeKeys(sk, col, row, n),
        });
        return;
      }
      if (sk === "jet") {
        if (!jetKeys.has(key)) return;
        emitAction({ kind: "skill", skillId: "jet", payload: { col, row } }, { onOkMsg: "技能已释放" });
        return;
      }
      if (sk === "execute") {
        const tid = [...adjEnemy.entries()].find(
          ([, pos]) => pos.col === col && pos.row === row
        )?.[0];
        if (!tid) {
          onActionError("请选择紧邻的敌人");
          return;
        }
        emitAction(
          { kind: "skill", skillId: "execute", payload: { targetId: tid } },
          { onOkMsg: "技能已释放" }
        );
        return;
      }
    }
  };

  const fireLaser = (dc: number, dr: number) => {
    socket.emit(
      "game:action",
      { kind: "skill", skillId: "laser", payload: { dc, dr } },
      (err: string | null) => {
        if (err) onActionError(err);
        else {
          setUiMode({ t: "idle" });
          onActionSuccess?.("激光已发射");
          const mc = me?.col;
          const mr = me?.row;
          if (mc != null && mr != null && mc >= 0 && mr >= 0) {
            const path = laserRayCells(mc, mr, dc, dr, n);
            setLaserFx({
              keys: path.map((p) => cellKey(p.col, p.row)),
              pulseIdx: 0,
            });
          }
        }
      }
    );
  };

  const pickBounty = (targetId: string) => {
    emitAction({ kind: "skill", skillId: "bounty", payload: { targetId } }, { onOkMsg: "悬赏已发布" });
  };

  const fireStealth = () => {
    emitAction({ kind: "skill", skillId: "stealth", payload: {} }, { onOkMsg: "进入隐身状态" });
  };

  const saveReplayImage = async () => {
    if (!state.replayLog?.length) return;
    setReplaySaving(true);
    try {
      await exportReplayImage({
        title: "复盘记录",
        subtitle: `房间 ${state.roomCode} · 地图 ${state.gridSize}×${state.gridSize}`,
        entries: state.replayLog,
        filename: `replay-${state.roomCode}.png`,
      });
      onActionSuccess?.("复盘记录已保存");
    } catch (e) {
      onActionError(e instanceof Error ? e.message : "保存复盘记录失败");
    } finally {
      setReplaySaving(false);
    }
  };

  const cellClass = (col: number, row: number, fog: boolean, key: string) => {
    const isVoid = !inPlayableArea(col, row, n, shrinkM);
    const isWall = wallSet.has(key);
    const isBeast = beastCellSet.has(key);
    const isEvent = eventCellSet.has(key);
    const isSelfCell = meOk && key === cellKey(meCol, meRow);
    let c = "game-screen__cell";
    if (isWall) c += " game-screen__cell--wall";
    else if (isVoid) c += " game-screen__cell--void";
    else c += fog ? " game-screen__cell--fog" : " game-screen__cell--lit";
    if (isEvent && state.mapEvent) {
      c +=
        " game-screen__cell--event-" +
        state.mapEvent.phase +
        " game-screen__cell--event-" +
        state.mapEvent.kind;
    }
    if (isBeast) c += " game-screen__cell--beast-zone";
    if (beastDamageKeys.has(key)) c += " game-screen__cell--beast-damage";
    if (!isWall && !isVoid && burningSet.has(key)) c += " game-screen__cell--burning";

    if (laserFx && laserFx.pulseIdx > 0) {
      const shown = laserFx.keys.slice(0, laserFx.pulseIdx);
      if (shown.includes(key)) c += " game-screen__cell--laser-beam";
    }

    if (!isWall && !isVoid && !isSelfCell && shrinkWarningKeys.has(key)) c += " game-screen__cell--shrink-warn";

    if (skillAimPending?.aoeKeys.has(key) && !isSelfCell) {
      c +=
        " game-screen__cell--skill-aoe" +
        (skillAimBlink % 2 === 0
          ? " game-screen__cell--skill-aoe-bright"
          : " game-screen__cell--skill-aoe-dim");
    }

    if (isWall || state.phase !== "playing" || !state.isMyTurn) return c;

    const skipModeHints = meOk && key === cellKey(meCol, meRow);
    if (skipModeHints) return c;

    if (uiMode.t === "attack" && attackKeys.has(key)) {
      c += " game-screen__cell--hint";
    } else if (uiMode.t === "move" && reachableKeys.has(key) && key !== cellKey(meCol, meRow)) {
      c += " game-screen__cell--hint";
    } else if (uiMode.t === "skillTarget" && !skillAimPending) {
      const sk = uiMode.skill;
      if (sk === "jet" && jetKeys.has(key)) c += " game-screen__cell--hint";
      else if (sk === "execute") {
        const hit = [...adjEnemy.values()].some((p) => p.col === col && p.row === row);
        if (hit) c += " game-screen__cell--hint";
      } else if (
        sk === "missile" ||
        sk === "sniper" ||
        sk === "flare" ||
        sk === "burn" ||
        sk === "jump"
      ) {
        if (inBounds(col, row, n) && inPlayableArea(col, row, n, shrinkM) && !wallSet.has(key))
          c += " game-screen__cell--hint-soft";
      }
    }
    return c;
  };

  const hideCoordForSelf = (here: GamePlayerView[]) => here.some((p) => p.socketId === myId);

  const animPos = moveAnim?.positions[moveAnim.step];
  const animActor = moveAnim
    ? state.players.find((p) => p.socketId === moveAnim.actorId)
    : undefined;
  const beastRenderPos = beastAnim?.positions[beastAnim.step] ?? state.beast ?? null;

  const ranking = state.ranking;

  const confirmAttackExec = () => {
    if (!attackConfirm) return;
    const { col, row } = attackConfirm;
    const targets = state.players.filter(
      (p) =>
        !p.eliminated &&
        p.col === col &&
        p.row === row &&
        p.socketId !== myId &&
        ((state.teamSize ?? 1) <= 1 || p.teamId !== me?.teamId)
    );
    setAttackConfirm(null);
    let msg = "已发动攻击（该格无敌人）";
    if (targets.length === 1) {
      msg = `命中 ${targets[0]!.nickname}，造成 ${ATTACK_DAMAGE} 点伤害`;
    } else if (targets.length > 1) {
      msg = `命中 ${targets.map((t) => t.nickname).join("、")}，各造成 ${ATTACK_DAMAGE} 点伤害`;
    }
    emitAction({ kind: "attack", col, row }, { onOkMsg: msg });
  };

  const confirmSkillRelease = () => {
    if (!skillAimPending) return;
    const { skill, col, row } = skillAimPending;
    setSkillAimPending(null);
    emitAction({ kind: "skill", skillId: skill, payload: { col, row } }, { onOkMsg: "技能已释放" });
  };

  const cancelSkillAim = () => {
    setSkillAimPending(null);
    setUiMode({ t: "idle" });
  };

  return (
    <div className={`game-screen${isSpectator ? " game-screen--spectator" : ""}`}>
      {playerLeftBanner && (
        <div className="game-screen__leave-banner" role="status">
          {playerLeftBanner}
        </div>
      )}

      <header className="game-screen__top">
        <div className="game-screen__brand">
          <span className="game-screen__title">黑暗森林 · 对战</span>
          <span className="game-screen__meta">
            房间 {state.roomCode} · 地图 {state.gridSize}×{state.gridSize} · 第 {state.roundNumber} 轮
          </span>
        </div>
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            if (state.phase === "playing" && onRetireToLobby) onRetireToLobby();
            else if (state.phase === "ended" && onDismissGameEnd) onDismissGameEnd();
            else onLeaveRoom();
          }}
        >
          离开
        </button>
      </header>

      <button
        type="button"
        className="game-screen__alive-bar"
        onClick={() => setAliveModalOpen(true)}
      >
        <span>当前存活玩家数量：{alivePlayers.length}</span>
        <span className="game-screen__alive-bar__spect">
          当前观战玩家数量：{state.watchingSpectatorCount ?? 0}
        </span>
      </button>

      <div className="game-screen__status">
        {isSpectator ? (
          <>
            <div className="game-screen__turn-order" aria-label="行动顺序">
              顺序：
              {(state.turnOrderNicknames ?? []).map((nick, i) => (
                <span key={`${nick}-${i}`}>
                  {i > 0 ? " → " : ""}
                  <strong>{nick}</strong>
                </span>
              ))}
            </div>
            <div className={"game-screen__turn" + (state.isBeastTurn ? " game-screen__turn--beast" : "")}>
              当前行动：{state.isBeastTurn ? "巨兽的回合" : state.players.find((p) => p.socketId === state.turnOf)?.nickname ?? "…"}
            </div>
          </>
        ) : (
          <>
            <div className="game-screen__stat game-screen__stat--hp" title="生命值">
              <span className="game-screen__stat-icon" aria-hidden>
                ♥
              </span>
              <span>{me?.hp ?? 0}</span>
            </div>
            <div className="game-screen__stat game-screen__stat--sta" title="体力">
              <span className="game-screen__stat-icon" aria-hidden>
                ⚡
              </span>
              <span>{me?.stamina ?? 0}</span>
            </div>
            {(me?.damageBonus ?? 0) > 0 && (
              <div className="game-screen__stat game-screen__stat--bonus" title="伤害加成">
                <span className="game-screen__stat-icon" aria-hidden>
                  +
                </span>
                <span>{me?.damageBonus}</span>
              </div>
            )}
            <div className={"game-screen__turn" + (state.isBeastTurn ? " game-screen__turn--beast" : "")}>
              {state.phase === "ended"
                ? state.winnerId === myId
                  ? "你获胜了"
                  : state.winnerNickname
                    ? `${state.winnerNickname} 获胜`
                    : "游戏结束"
                : state.isBeastTurn
                  ? "巨兽的回合"
                : me?.eliminated
                  ? "你已出局"
                  : state.isMyTurn
                    ? (
                        <>
                          你的回合
                          {myTurnSecondsLeft != null && (
                            <span
                              className={
                                "game-screen__turn-timer" +
                                (myTurnSecondsLeft <= 10 ? " game-screen__turn-timer--urgent" : "")
                              }
                              aria-label={`剩余 ${myTurnSecondsLeft} 秒`}
                            >
                              {" "}
                              · 剩余 {myTurnSecondsLeft}s
                            </span>
                          )}
                        </>
                      )
                    : `等待 ${state.players.find((p) => p.socketId === state.turnOf)?.nickname ?? "…"}`}
            </div>
          </>
        )}
      </div>

      {poisonShrinkBannerActive && (
        <div className="game-screen__poison-shrink-banner" role="status">
          下一回合红色高亮区域将进行毒圈收缩。
        </div>
      )}

      {beastWarningActive && (
        <div className="game-screen__event-banner" role="status">
          下一回合巨兽将出现
        </div>
      )}

      {state.mapEvent && (
        <div
          className={
            "game-screen__event-banner" +
            (state.mapEvent.kind === "rain" ? " game-screen__event-banner--good" : " game-screen__event-banner--danger")
          }
          role="status"
        >
          {state.mapEvent.phase === "warning"
            ? `事件预警：下一轮「${EVENT_LABELS[state.mapEvent.kind]}」将在高亮区域发生。`
            : `事件发生：「${EVENT_LABELS[state.mapEvent.kind]}」正在影响高亮区域。`}
        </div>
      )}

      {attackConfirm && (
        <div className="game-screen__confirm-overlay" role="dialog" aria-modal="true">
          <div className="game-screen__confirm-box">
            <p className="game-screen__confirm-text">
              你确定对 <strong>{attackConfirm.label}</strong> 发起攻击吗？
            </p>
            <p className="game-screen__confirm-hint">
              将消耗 2 点体力；仅当格内有敌对玩家或巨兽时造成伤害，空格为挥空。
            </p>
            <div className="game-screen__confirm-actions">
              <button type="button" className="btn-secondary" onClick={() => setAttackConfirm(null)}>
                取消
              </button>
              <button type="button" className="btn-primary" onClick={confirmAttackExec}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {turnPromptOpen && state.phase === "playing" && state.isMyTurn && (
        <div className="game-screen__confirm-overlay" role="dialog" aria-modal="true">
          <div className="game-screen__confirm-box">
            <p className="game-screen__confirm-text">
              轮到你行动了
            </p>
            <p className="game-screen__confirm-hint">请选择移动、攻击、休息、学习或使用技能。</p>
            <div className="game-screen__confirm-actions game-screen__confirm-actions--center">
              <button type="button" className="btn-primary" onClick={() => setTurnPromptOpen(false)}>
                知道了
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="game-screen__zoom-tools">
        <button
          type="button"
          className="game-screen__zoom-btn"
          aria-label="缩小"
          onClick={() =>
            setZoom((z) => Math.max(MAP_ZOOM_MIN, Math.round((z - 0.1) * 10) / 10))
          }
        >
          −
        </button>
        <span className="game-screen__zoom-readout">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className="game-screen__zoom-btn"
          aria-label="放大"
          onClick={() =>
            setZoom((z) => Math.min(MAP_ZOOM_MAX, Math.round((z + 0.1) * 10) / 10))
          }
        >
          +
        </button>
      </div>

      <div
        className="game-screen__map-viewport"
        ref={viewportRef}
        onPointerDown={onViewportPointerDown}
        style={
          {
            width: mapViewportBasePx,
            height: mapViewportBasePx,
          } as CSSProperties
        }
      >
        <div
          className="game-screen__map-scroll-inner"
          style={{ width: wrapSize, height: wrapSize }}
        >
          <div
            className="game-screen__map-scaled"
            style={
              {
                width: gridPx,
                height: gridPx,
                "--gs": n,
                "--cell-px": `${cellPx}px`,
              } as CSSProperties & { "--gs": number; "--cell-px": string }
            }
          >
            {Array.from({ length: n * n }, (_, i) => {
              const col = i % n;
              const row = Math.floor(i / n);
              const key = `${col},${row}`;
              const isVoid = !inPlayableArea(col, row, n, shrinkM);
              const isWall = wallSet.has(key);
              const isBeast = beastCellSet.has(key);
              const isActiveEvent = state.mapEvent?.phase === "active" && eventCellSet.has(key);
              const fog = !visible.has(key);
              const rawHere = state.players.filter(
                (p) => !p.eliminated && p.col === col && p.row === row
              );
              const hideCoord = isWall || isActiveEvent || hideCoordForSelf(rawHere) || !showGridCoords;
              const displayHere = moveAnim
                ? rawHere.filter((p) => p.socketId !== moveAnim.actorId)
                : rawHere;
              const showAnimActor =
                Boolean(
                  moveAnim &&
                    animPos &&
                    animPos.col === col &&
                    animPos.row === row &&
                    animActor &&
                    !animActor.eliminated
                );

              const fogOk =
                !fog ||
                (uiMode.t === "skillTarget" &&
                  (["missile", "sniper", "flare", "burn", "jump"].includes(uiMode.skill) ||
                    (uiMode.skill === "jet" && jetKeys.has(key)) ||
                    (uiMode.skill === "execute" &&
                      [...adjEnemy.values()].some((p) => p.col === col && p.row === row)))) ||
                isBeast ||
                (uiMode.t === "attack" && attackKeys.has(key)) ||
                (uiMode.t === "move" && reachableKeys.has(key));

              const canUseCell =
                !moveAnim &&
                !isWall &&
                !isVoid &&
                !isSpectator &&
                state.isMyTurn &&
                state.phase === "playing" &&
                !me?.eliminated &&
                ((uiMode.t === "attack" && (attackKeys.has(key) || isBeast)) ||
                  (uiMode.t === "move" && reachableKeys.has(key)) ||
                  uiMode.t === "skillTarget") &&
                fogOk;

              return (
                <button
                  key={key}
                  type="button"
                  className={
                    cellClass(col, row, fog, key) +
                    cellFactionClass(rawHere, isVoid) +
                    cellSelfClass(col, row)
                  }
                  title={
                    isWall ? "墙壁，不可通行" : isVoid ? "毒圈已清除，不可停留" : fog ? "迷雾" : `${colLetter(col)}${row + 1}`
                  }
                  onClick={() => onCellClick(col, row)}
                  disabled={!canUseCell}
                >
                  {isWall && <span className="game-screen__wall-art" aria-hidden />}
                  {isActiveEvent && state.mapEvent && (
                    <span className={`game-screen__event-art game-screen__event-art--${state.mapEvent.kind}`} aria-hidden />
                  )}
                  {!isWall && !isVoid && burningSet.has(key) && (
                    <span className="game-screen__burn-icon" aria-hidden>
                      🔥
                    </span>
                  )}
                  {!hideCoord && (
                    <span
                      className={
                        "game-screen__coord" + (fog ? " game-screen__coord--fog" : "")
                      }
                    >
                      {`${colLetter(col)}${row + 1}`}
                    </span>
                  )}
                  {(displayHere.length > 0 || showAnimActor) && (
                    <div
                      className="game-screen__tokens"
                      style={
                        {
                          ["--token-count" as string]: String(
                            displayHere.length + (showAnimActor ? 1 : 0)
                          ),
                        } as CSSProperties
                      }
                    >
                      {displayHere.map((p) => (
                        <div key={p.socketId} className="game-screen__token-wrap">
                          <span className="game-screen__token-name">{p.nickname}</span>
                          <PlayerAvatarFrame
                            variant="fill"
                            className={
                              "game-screen__token" +
                              ((state.teamSize ?? 1) > 1 && p.teamId != null ? ` game-screen__token--team-${p.teamId % 6}` : "") +
                              (p.socketId === myId ? " game-screen__token--me" : "")
                            }
                            src={p.avatar || DEFAULT_AVATAR}
                            alt=""
                            title={p.nickname}
                            draggable={false}
                          />
                        </div>
                      ))}
                      {showAnimActor && animActor && (
                        <div className="game-screen__token-wrap game-screen__token-wrap--anim">
                          <span className="game-screen__token-name">{animActor.nickname}</span>
                          <PlayerAvatarFrame
                            variant="fill"
                            className={
                              "game-screen__token game-screen__token--anim" +
                              ((state.teamSize ?? 1) > 1 && animActor.teamId != null ? ` game-screen__token--team-${animActor.teamId % 6}` : "") +
                              (animActor.socketId === myId ? " game-screen__token--me" : "")
                            }
                            src={animActor.avatar || DEFAULT_AVATAR}
                            alt=""
                            draggable={false}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
            {state.beast && beastRenderPos && (
              <div
                className={"game-screen__beast" + (beastAnim ? " game-screen__beast--moving" : "")}
                style={
                  {
                    left: `${(beastRenderPos.col / n) * 100}%`,
                    top: `${(beastRenderPos.row / n) * 100}%`,
                    width: `${(2 / n) * 100}%`,
                    height: `${(2 / n) * 100}%`,
                  } as CSSProperties
                }
                aria-label={`巨兽生命 ${state.beast.hp}/${state.beast.maxHp}`}
              >
                <span className="game-screen__beast-face" aria-hidden>
                  <svg viewBox="0 0 100 100" focusable="false">
                    <path className="game-screen__beast-horn" d="M22 28 8 6 34 16Z" />
                    <path className="game-screen__beast-horn" d="M78 28 92 6 66 16Z" />
                    <path className="game-screen__beast-head" d="M13 44C13 21 31 11 50 11s37 10 37 33c0 28-13 44-37 44S13 72 13 44Z" />
                    <path className="game-screen__beast-mane" d="M15 43 5 55l12 4-9 13 16 1 2 14 15-8 9 12 9-12 15 8 2-14 16-1-9-13 12-4-10-12" />
                    <circle className="game-screen__beast-eye" cx="36" cy="43" r="6" />
                    <circle className="game-screen__beast-eye" cx="64" cy="43" r="6" />
                    <path className="game-screen__beast-snout" d="M36 60c4 9 24 9 28 0-2 14-26 14-28 0Z" />
                    <path className="game-screen__beast-fang" d="M42 64 38 78l10-9 4 9 4-9 10 9-4-14" />
                  </svg>
                </span>
                <span className="game-screen__beast-hp">
                  {state.beast.hp}/{state.beast.maxHp}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {uiMode.t === "skillLaser" && state.isMyTurn && (
        <div className="game-screen__laser-panel">
          <p className="game-screen__hint">选择激光方向</p>
          <div className="game-screen__laser-dirs">
            {LASER_DIRS.map(([dc, dr, lab]) => (
              <button
                key={`${dc},${dr}`}
                type="button"
                className="game-screen__dir-btn"
                onClick={() => fireLaser(dc, dr)}
              >
                {lab}
              </button>
            ))}
          </div>
          <button type="button" className="link-btn" onClick={() => setUiMode({ t: "idle" })}>
            取消
          </button>
        </div>
      )}

      {uiMode.t === "skillBounty" && (
        <div className="game-screen__overlay-panel">
          <p className="game-screen__hint">悬赏：选择你能看到的玩家</p>
          <ul className="game-screen__bounty-list">
            {bountyTargets.map((p) => (
              <li key={p.socketId}>
                <button
                  type="button"
                  className="game-screen__bounty-pick"
                  onClick={() => pickBounty(p.socketId)}
                >
                  <PlayerAvatarFrame src={p.avatar || DEFAULT_AVATAR} alt="" width={28} height={28} />
                  <span>{p.nickname}</span>
                </button>
              </li>
            ))}
          </ul>
          {bountyTargets.length === 0 && (
            <p className="game-screen__hint">当前没有可见对手</p>
          )}
          <button type="button" className="link-btn" onClick={() => setUiMode({ t: "idle" })}>
            取消
          </button>
        </div>
      )}

      {uiMode.t === "rest" && (
        <div className="game-screen__overlay-panel game-screen__overlay-panel--rest">
          <p className="game-screen__hint">休息：选择一项或取消</p>
          <div className="game-screen__rest-btns">
            <button
              type="button"
              className="btn-secondary"
              onClick={restHp}
            >
              恢复 1 生命
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={restStamina}
            >
              恢复 3 体力
            </button>
            <button type="button" className="link-btn" onClick={() => setUiMode({ t: "idle" })}>
              取消
            </button>
          </div>
        </div>
      )}

      {uiMode.t === "skillMenu" && (
        <div className="game-screen__skill-modal" role="dialog">
          <div className="game-screen__skill-modal-inner">
            <h3 className="game-screen__skill-title">选择技能</h3>
            <ul className="game-screen__skill-list">
              {mySkills.map((sk) => {
                const meta = state.skillMeta[sk];
                const turns = cd[sk] ?? 0;
                const usable = skillUsable(sk);
                return (
                  <li key={sk}>
                    <button
                      type="button"
                      className="game-screen__skill-item"
                      disabled={!usable || turns > 0}
                      title={SKILL_HELP[sk] ?? meta?.name}
                      onClick={() => {
                        if (sk === "laser") setUiMode({ t: "skillLaser" });
                        else if (sk === "bounty") setUiMode({ t: "skillBounty" });
                        else if (sk === "stealth") fireStealth();
                        else if (
                          sk === "missile" ||
                          sk === "sniper" ||
                          sk === "flare" ||
                          sk === "burn" ||
                          sk === "jump"
                        )
                          setUiMode({ t: "skillTarget", skill: sk });
                        else if (sk === "jet" || sk === "execute")
                          setUiMode({ t: "skillTarget", skill: sk });
                      }}
                    >
                      <span className="game-screen__skill-name">{meta?.name ?? sk}</span>
                      <span className="game-screen__skill-meta">
                        {meta ? `${meta.cost} 体` : ""}
                        {turns > 0 ? ` · 冷却 ${turns} 轮` : ""}
                        {!usable && turns === 0 ? " · 不可用" : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              className="link-btn game-screen__skill-close"
              onClick={() => setUiMode({ t: "idle" })}
            >
              关闭
            </button>
          </div>
        </div>
      )}

      {aliveModalOpen && (
        <div
          className="game-screen__alive-modal"
          role="dialog"
          aria-modal="true"
          onClick={() => setAliveModalOpen(false)}
        >
          <div
            className="game-screen__alive-modal-inner"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>存活玩家</h3>
            <ul className="game-screen__alive-list">
              {alivePlayers.map((p) => (
                <li key={p.socketId} className="game-screen__alive-row">
                  <PlayerAvatarFrame src={p.avatar || DEFAULT_AVATAR} alt="" width={40} height={40} />
                  <span>{p.nickname}</span>
                </li>
              ))}
            </ul>
            <button type="button" className="btn-secondary" onClick={() => setAliveModalOpen(false)}>
              关闭
            </button>
          </div>
        </div>
      )}

      {state.phase === "ended" && ranking && ranking.length > 0 && (
        <div className="game-screen__end-modal" role="dialog" aria-modal="true">
          <div className="game-screen__end-modal-inner">
            <h2 className="game-screen__end-title">
              {!isSpectator && state.winnerId === myId ? "你获胜了！" : "游戏结束"}
            </h2>
            <p className="game-screen__end-sub">排名（最后出局名次靠前）</p>
            <ol className="game-screen__rank-list">
              {ranking.map((r) => (
                <li key={r.socketId} className="game-screen__rank-row">
                  <span className="game-screen__rank-num">#{r.rank}</span>
                  <PlayerAvatarFrame src={r.avatar || DEFAULT_AVATAR} alt="" width={36} height={36} />
                  <span className="game-screen__rank-name">{r.nickname}</span>
                  <span className={`game-screen__rank-result game-screen__rank-result--${r.resultKind ?? "death"}`}>
                    {r.resultText ?? (r.rank === 1 ? "胜利" : "已出局")}
                  </span>
                </li>
              ))}
            </ol>
            <div className="game-screen__end-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setReplayOpen(true)}
              >
                复盘记录
              </button>
              <button
                type="button"
                className="btn-primary game-screen__end-exit"
                onClick={() => onDismissGameEnd?.()}
              >
                返回房间
              </button>
            </div>
          </div>
        </div>
      )}

      {replayOpen && state.replayLog && state.replayLog.length > 0 && (
        <div
          className="game-screen__replay-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => setReplayOpen(false)}
        >
          <div className="game-screen__replay-inner" onClick={(e) => e.stopPropagation()}>
            <div className="game-screen__replay-top">
              <h3>复盘记录</h3>
              <button
                type="button"
                className="game-screen__replay-close-x"
                aria-label="关闭"
                onClick={() => setReplayOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="game-screen__replay-body">
              <ul className="game-screen__replay-list">
                {state.replayLog.map((e: GameReplayEntryView) => (
                  <li key={e.seq} className="game-screen__replay-item">
                    <div className="game-screen__replay-head">
                      <span className="game-screen__replay-seq">#{e.seq + 1}</span>
                      <span className="game-screen__replay-meta">
                        第 {e.roundNumber} 轮 · {e.actorNickname}
                      </span>
                    </div>
                    <p className="game-screen__replay-sum">{e.summary}</p>
                    {e.damage && <p className="game-screen__replay-dmg">{e.damage}</p>}
                    <div className="game-screen__replay-vitals">
                      {Object.entries(e.vitals).map(([sid, v]) => (
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
              <button
                type="button"
                className="btn-secondary game-screen__replay-close-bottom"
                onClick={() => setReplayOpen(false)}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="game-screen__dock">
        {state.phase === "playing" && !isSpectator && damageNotice && (
          <div className="game-screen__damage-notice" role="status">
            {damageNotice}
          </div>
        )}
        {state.phase === "playing" && !isSpectator && !state.isMyTurn && !me?.eliminated && (
          <div className="game-screen__turn-wait-panel" role="status">
            <span>
              当前行动：
              <strong className={state.isBeastTurn ? "game-screen__turn--beast" : ""}>
                {state.isBeastTurn ? "巨兽的回合" : state.currentTurnNickname ?? "…"}
              </strong>
            </span>
            <span>
              下一位：<strong>{state.nextTurnNickname ?? "暂无"}</strong>
            </span>
          </div>
        )}
        {state.phase === "playing" && isSpectator && (
          <div className="game-screen__spectate-dock" aria-label="操作记录">
            <div className="game-screen__spectate-stream-head">操作记录</div>
            <div className="game-screen__spectate-stream" ref={spectatorStreamRef}>
              {spectatorReplayEntries.length === 0 ? (
                <p className="game-screen__spectate-empty">暂无记录，等待操作…</p>
              ) : (
                spectatorReplayEntries.map((e) => (
                  <article key={e.seq} className="game-screen__spectate-card">
                    <div className="game-screen__spectate-card__head">
                      <span className="game-screen__spectate-card__seq">#{e.seq + 1}</span>
                      <span className="game-screen__spectate-card__meta">
                        第 {e.roundNumber} 轮 · <strong>{e.actorNickname}</strong>
                      </span>
                    </div>
                    <p className="game-screen__spectate-card__sum">{e.summary}</p>
                    {e.damage ? <p className="game-screen__spectate-card__dmg">{e.damage}</p> : null}
                    <div className="game-screen__spectate-card__vitals">
                      {Object.entries(e.vitals)
                        .sort(([, a], [, b]) => a.nickname.localeCompare(b.nickname, "zh-CN"))
                        .map(([sid, v]) => (
                          <span key={sid} className="game-screen__spectate-vital-chip">
                            {v.nickname} ♥{v.hp} ⚡{v.stamina}
                          </span>
                        ))}
                    </div>
                  </article>
                ))
              )}
            </div>
          </div>
        )}
        {state.phase === "playing" && !isSpectator && state.isMyTurn && !me?.eliminated && (
          <>
            {skillAimPending && (
              <div className="game-screen__skill-confirm-bar" role="region" aria-label="技能释放确认">
                <p className="game-screen__skill-confirm-text">
                  对锚点格 <strong>{formatCellLabel(skillAimPending.col, skillAimPending.row)}</strong> 释放
                  「{state.skillMeta[skillAimPending.skill]?.name ?? skillAimPending.skill}」？
                  <span className="game-screen__skill-confirm-hint">红色范围为预览（1 秒/次闪烁）</span>
                </p>
                <div className="game-screen__skill-confirm-actions">
                  <button type="button" className="btn-secondary" onClick={cancelSkillAim}>
                    取消
                  </button>
                  <button type="button" className="btn-primary" onClick={confirmSkillRelease}>
                    释放
                  </button>
                </div>
              </div>
            )}
            <div className="game-screen__actions">
              <button type="button" className="btn-secondary" onClick={tryAttackMode}>
                攻击
              </button>
              <button type="button" className="btn-secondary" onClick={tryMoveMode}>
                移动
              </button>
              <button type="button" className="btn-secondary" onClick={tryRestMode}>
                休息
              </button>
              <button type="button" className="btn-secondary" onClick={tryLearn}>
                学习
              </button>
              <button type="button" className="btn-secondary" onClick={trySkillMenu}>
                技能
              </button>
            </div>
            <div className="game-screen__actions game-screen__actions--secondary">
              {uiMode.t === "attack" && (
                <span className="game-screen__mode-tag">绿色区域可攻击；点击有敌人的格子</span>
              )}
              {uiMode.t === "move" && (
                <span className="game-screen__mode-tag">绿色区域可移动（含迷雾）</span>
              )}
              {uiMode.t === "skillTarget" && !skillAimPending && (
                <span className="game-screen__mode-tag">
                  {uiMode.skill === "execute"
                    ? "点击紧邻敌人"
                    : uiMode.skill === "jet"
                      ? "点击喷射目标格"
                      : "点击地图选择锚点，然后在下方确认释放"}
                </span>
              )}
              {skillAimPending && (
                <span className="game-screen__mode-tag">可点击地图更换锚点，或在上方确认/取消</span>
              )}
              <button type="button" className="btn-primary" onClick={endTurn}>
                结束回合
              </button>
              {(uiMode.t === "attack" ||
                uiMode.t === "move" ||
                uiMode.t === "skillTarget") && (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setSkillAimPending(null);
                    setUiMode({ t: "idle" });
                  }}
                >
                  取消选择
                </button>
              )}
            </div>
          </>
        )}
      </footer>
    </div>
  );
}

const SKILL_HELP: Partial<Record<SkillId, string>> = {
  laser: "八个方向发射激光，路径上每名敌人 -4 生命，5 体力，冷却 1 轮",
  missile: "3×3 范围内敌人 -4，6 体力，冷却 1 轮",
  sniper: "单格有敌人则 -6，8 体力，冷却 2 轮",
  flare: "5×5 照明一轮，4 体力，冷却 1 轮",
  burn: "3×3 燃烧两轮，每轮行动 -3，6 体力，冷却 2 轮",
  bounty: "与可见对手互相透视位置三轮，2 体力，冷却 4 轮",
  stealth: "隐身两轮，进攻或其他技能会解除，5 体力，冷却 4 轮",
  jet: "8 格内空格移动，3 体力，冷却 1 轮",
  jump: "跳到任意空格，5 体力，冷却 2 轮",
  execute: "紧邻敌人 -7，5 体力，冷却 2 轮",
};
