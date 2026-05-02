import type { MatchMode } from "@/constants/matchModes";

export type SkillId =
  | "laser"
  | "missile"
  | "sniper"
  | "flare"
  | "burn"
  | "bounty"
  | "stealth"
  | "jet"
  | "jump"
  | "execute"
  | "shadow_clone"
  | "golden_bell"
  | "blade_escape"
  | "nuke"
  | "landmine"
  | "sonic_radar";

export type GamePlayerView = {
  socketId: string;
  slotIndex: number;
  /** 阵营：0 = 席位 0–2，1 = 席位 3–5 */
  teamId?: number;
  nickname: string;
  avatar: string;
  hp: number;
  stamina?: number;
  col: number | null;
  row: number | null;
  gridLabel: string | null;
  skills: string[];
  stealthActive: boolean;
  eliminated: boolean;
  skipNextTurn?: boolean;
  damageBonus?: number;
};

export type MapEventKind = "volcano" | "earthquake" | "rain";

export type MapEventView = {
  kind: MapEventKind;
  phase: "warning" | "active";
  centerCol: number;
  centerRow: number;
  roundNumber: number;
  cellKeys: string[];
};

export type BeastView = {
  col: number;
  row: number;
  hp: number;
  maxHp: number;
  cellKeys: string[];
  spawnedRound: number;
};

export type BeastActionView = {
  damageEvents?: GameReplayEntryView["damageEvents"];
};

export type GameReplayEntryView = {
  seq: number;
  roundNumber: number;
  actorId: string;
  actorNickname: string;
  summary: string;
  damage?: string;
  damageEvents?: Array<{
    sourceId: string;
    sourceNickname: string;
    targetId: string;
    targetNickname: string;
    amount: number;
    operation?: string;
    deathCause?: string;
  }>;
  vitals: Record<string, { nickname: string; hp: number; stamina: number }>;
};

export type GameClientState = {
  roomCode: string;
  gridSize: number;
  matchMode?: MatchMode;
  matchModeLabel?: string;
  teamSize?: number;
  /** 本局休息上限与普攻伤害（来自房间设置） */
  gameRules?: {
    maxHp: number;
    maxStamina: number;
    restHp: number;
    restStamina: number;
    attackDamage: number;
  };
  roundNumber: number;
  /** 毒圈：仅 [margin, grid-1-margin]² 内可站立；偶数回合外圈消失并淘汰 */
  shrinkMargin?: number;
  /** 不可通行墙壁格子，格式为 "col,row" */
  wallKeys?: string[];
  /** 本轮毒圈预警格子，下一轮收缩 */
  poisonWarningKeys?: string[];
  turnOf: string;
  isMyTurn: boolean;
  isBeastTurn?: boolean;
  turnDeadlineAt?: number | null;
  phase: "playing" | "ended";
  players: GamePlayerView[];
  visibleCells: string[];
  turnFlags?: {
    didAttack: boolean;
    learnCount: number;
    skillIdsUsed: string[];
    didRest: boolean;
    didMove: boolean;
  };
  skillMeta: Record<string, { name: string; cost: number; cooldown: number }>;
  winnerId?: string | null;
  winnerNickname?: string | null;
  /** 本人技能剩余冷却（轮数），未出现在键中则表示可用 */
  mySkillCooldowns?: Partial<Record<string, number>>;
  /** 游戏结束时排名：1=获胜者，2=最后出局，… */
  ranking?: Array<{
    rank: number;
    socketId: string;
    nickname: string;
    avatar: string;
    resultText?: string;
    resultKind?: "win" | "death";
  }>;
  /** 燃烧区域覆盖的格子（3×3 并集） */
  burningCellKeys?: string[];
  mapEvent?: MapEventView | null;
  beast?: BeastView | null;
  /** 断线重连用（仅本人可见） */
  myResumeToken?: string;
  /** 观战模式 */
  isSpectator?: boolean;
  /** 本局内出局但未结束：观战视角 */
  isEliminatedSpectator?: boolean;
  /** 当前行动顺序（昵称） */
  turnOrderNicknames?: string[];
  /** 当前行动玩家昵称 */
  currentTurnNickname?: string;
  /** 下一位行动玩家昵称 */
  nextTurnNickname?: string;
  /** 观战：最近一条操作摘要 */
  spectatorLastSummary?: string;
  /** 复盘记录 */
  replayLog?: GameReplayEntryView[];
  /** 已进入观战的人数（与对局内玩家共享） */
  watchingSpectatorCount?: number;
  /** 核弹预警锚点格（全局可见） */
  nukeWarningKeys?: string[];
  /** 本人可见的同阵营地雷格 */
  allyLandmineKeys?: string[];
  /** 声波雷达锚点与侦测区格子 */
  sonicRadarCells?: Array<{ id: string; col: number; row: number; hp: number; zoneKeys: string[] }>;
  /** 影分身棋子（外观与主人一致） */
  shadowClones?: Array<{
    id: string;
    col: number;
    row: number;
    ownerSocketId: string;
    nickname: string;
    avatar: string;
  }>;
};

export type ClientGameAction =
  | { kind: "move"; path: Array<{ col: number; row: number }> }
  | { kind: "attack"; col: number; row: number }
  | { kind: "rest"; mode: "hp" | "stamina" }
  | { kind: "learn"; confirmOverwrite?: boolean }
  | { kind: "skill"; skillId: SkillId; payload: Record<string, unknown> }
  | { kind: "endTurn" };
