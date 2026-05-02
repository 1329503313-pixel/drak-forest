import type { MatchMode } from "@/constants/matchModes";
import type { SkillId } from "@/types/game";

export type BotDifficulty = "easy" | "medium" | "hard";

/** 与服务器 roomGameSettings 对齐；开局前房主配置 */
export type RoomGameSettings = {
  initialHp: number;
  initialStamina: number;
  maxHp: number;
  maxStamina: number;
  restHp: number;
  restStamina: number;
  attackDamage: number;
  learnableSkillIds: SkillId[];
};

export type PlayerPublic = {
  socketId: string;
  gameAccountId: string;
  nickname: string;
  avatar: string;
  /** 固定席位索引，从 0 开始 */
  slotIndex: number;
  /** 服务端：是否为电脑玩家 */
  isBot?: boolean;
  botDifficulty?: BotDifficulty;
};

/** 大厅观战席上展示的观战者（开局后进游戏为观战视角） */
export type SpectatorSeatPublic = {
  socketId: string;
  gameAccountId: string;
  nickname: string;
  avatar: string;
};

export type RoomState = {
  code: string;
  hostId: string;
  /** 房间固定席位数（席位上换位，不可自由坐标） */
  maxSlots: number;
  matchMode: MatchMode;
  matchModeLabel: string;
  teamSize: number;
  rowSize: number;
  players: PlayerPublic[];
  /** 大厅观战席（固定 4 格，与 spectatorSlots 数组下标对应） */
  spectatorSlots?: (SpectatorSeatPublic | null)[];
  /** 开局地图边长（房主未开局前可改） */
  gridSize?: number;
  /** 地图尺寸展示文案 */
  mapSizeLabel?: string;
  /** 服务端：当前是否有进行中的对局 */
  gameInProgress?: boolean;
  /** 开局参数（全员同步） */
  gameSettings?: RoomGameSettings;
  /** 加入时若对局进行中，先以访客进房，需点「观战」 */
  waitingToSpectate?: boolean;
};
