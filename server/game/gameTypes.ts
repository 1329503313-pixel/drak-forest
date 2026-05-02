import type { SkillId } from "./constants.js";

/** 仅电脑玩家；用于局内体力/视野/A.I. 档位 */
export type BotDifficulty = "easy" | "medium" | "hard";
import type { MatchMode } from "../matchModes.js";

export type TurnFlags = {
  didAttack: boolean;
  learnCount: number;
  skillIdsUsed: SkillId[];
  didRest: boolean;
  didMove: boolean;
};

export type BurningZone = {
  centerCol: number;
  centerRow: number;
  ownerId: string;
  roundsLeft: number;
};

export type FlareZone = {
  centerCol: number;
  centerRow: number;
  ownerId: string;
};

export type BountyPair = {
  aId: string;
  bId: string;
  roundsLeft: number;
};

export type ShadowCloneState = {
  id: string;
  ownerId: string;
  col: number;
  row: number;
  roundsLeft: number;
};

export type PendingNukeState = {
  id: string;
  ownerId: string;
  col: number;
  row: number;
  placedRound: number;
};

export type LandmineState = {
  id: string;
  ownerId: string;
  col: number;
  row: number;
};

export type SonicRadarState = {
  id: string;
  ownerId: string;
  col: number;
  row: number;
  roundsLeft: number;
  hp: number;
};

export type MapEventKind = "volcano" | "earthquake" | "rain";

export type MapEventState = {
  kind: MapEventKind;
  phase: "warning" | "active";
  centerCol: number;
  centerRow: number;
  roundNumber: number;
};

export type BeastState = {
  col: number;
  row: number;
  hp: number;
  maxHp: number;
  spawnedRound: number;
  lastActedRound: number;
};

export type GameReplayEntry = {
  seq: number;
  roundNumber: number;
  actorId: string;
  actorNickname: string;
  summary: string;
  /** 本操作造成的伤害简述（若有） */
  damage?: string;
  /** 本操作的实际扣血明细 */
  damageEvents?: Array<{
    sourceId: string;
    sourceNickname: string;
    targetId: string;
    targetNickname: string;
    amount: number;
    operation?: string;
    deathCause?: string;
  }>;
  /** 本条记录之后各存活玩家生命与体力 */
  vitals: Record<string, { nickname: string; hp: number; stamina: number }>;
};

export type GamePlayer = {
  socketId: string;
  /** 游戏账号主键（客户端注册），对局记录与资料绑定 */
  gameAccountId: string;
  slotIndex: number;
  teamId: number;
  nickname: string;
  avatar: string;
  col: number;
  row: number;
  hp: number;
  stamina: number;
  skills: SkillId[];
  /** 玩家自己的回合序号，每次轮到该玩家行动时 +1 */
  turnSerial: number;
  /** 某技能上次使用时的 turnSerial，用于冷却 */
  lastSkillAtTurn: Partial<Record<SkillId, number>>;
  stealthActive: boolean;
  /** 客户端展示：是否在悬赏相互透视中 */
  bountyPartnerId: string | null;
  /** 断线重连凭证（开局生成） */
  resumeToken: string;
  /** 断线时刻 ms；在局且未 null 表示暂离可重连 */
  disconnectedAt: number | null;
  /** 下一次行动是否因地震跳过 */
  skipNextTurn: boolean;
  /** 本局永久伤害加成 */
  damageBonus: number;
  /** 出局后展示在结算/对局记录中的死因 */
  deathCause: string | null;
  /** 电脑难度（仅 socketId 为 bot: 前缀时有效） */
  botDifficulty?: BotDifficulty;
  /** 金钟罩：在该轮内每次受到伤害 -3（含来自玩家的伤害），下一轮有效 */
  goldenBellForRound: number | null;
  /** 被金钟罩反隐：该轮结束前持续被全员透视位置 */
  markedExposeUntilRound: number | null;
};

/** 单局规则（由房间设置推导，影响引擎数值） */
export type GameSessionRules = {
  maxHp: number;
  maxStamina: number;
  restHp: number;
  restStamina: number;
  attackDamage: number;
  learnableSkills: SkillId[];
};

export type GameSession = {
  roomCode: string;
  /** 地图边长：15 / 20 / 25 / 30 */
  gridSize: number;
  /** 本局数值与技能池 */
  rules: GameSessionRules;
  matchMode: MatchMode;
  matchModeLabel: string;
  teamSize: number;
  /** 本局唯一 id，用于对局记录落库 */
  matchId: string;
  /** 已离开对局界面回房间，不再接收局内 game:state */
  retiredToLobby?: Set<string>;
  /** 开局时记录的席位 slotIndex -> socketId */
  slotAssignments: Record<number, string>;
  turnOrder: string[];
  turnIndex: number;
  roundNumber: number;
  /** 当前玩家回合截止时间戳；巨兽回合或非进行中可为空 */
  turnDeadlineAt: number | null;
  /** 回合计时版本，每次玩家回合开始递增，避免过期计时器生效 */
  turnTimerSeq: number;
  /** 毒圈：仅 col/row 在 [margin, grid-1-margin] 内为可站/可选格；偶数回合消去外圈后 +1 */
  shrinkMargin: number;
  /** 不可通行墙壁格子，格式为 "col,row" */
  wallKeys: string[];
  /** 本轮毒圈预警格子，下一轮收缩 */
  poisonWarningKeys: string[];
  /** 当前地图事件：预警或触发中 */
  mapEvent: MapEventState | null;
  /** 第七轮开始出现的巨兽 */
  beast: BeastState | null;
  /** 巨兽独立行动回合是否正在等待执行 */
  beastTurnPending: boolean;
  players: Map<string, GamePlayer>;
  burningZones: BurningZone[];
  flareZones: FlareZone[];
  bountyPairs: BountyPair[];
  shadowClones: ShadowCloneState[];
  pendingNukes: PendingNukeState[];
  landmines: LandmineState[];
  sonicRadars: SonicRadarState[];
  /** 当前行动回合内的标记 */
  turnFlags: Map<string, TurnFlags>;
  phase: "playing" | "ended";
  winnerId: string | null;
  /** 淘汰顺序：先出局者在数组前，胜者与最后出局者在结算时用 */
  eliminationOrder: string[];
  /** 复盘：每条为一次操作后的快照 */
  replayLog: GameReplayEntry[];
};
