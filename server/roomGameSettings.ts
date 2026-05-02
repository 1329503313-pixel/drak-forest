import {
  ALL_SKILLS_POOL,
  DEFAULT_HP,
  DEFAULT_MAX_STAMINA,
  DEFAULT_START_STAMINA,
  ATTACK_DAMAGE,
  type SkillId,
} from "./game/constants.js";
import type { GameSessionRules } from "./game/gameTypes.js";

/** 与客户端同步的房间对局参数（开局前由房主配置） */
export type RoomGameSettings = {
  initialHp: number;
  initialStamina: number;
  maxHp: number;
  maxStamina: number;
  restHp: number;
  restStamina: number;
  attackDamage: number;
  /** 允许在学习中抽到的技能 */
  learnableSkillIds: SkillId[];
};

export const DEFAULT_ROOM_GAME_SETTINGS: RoomGameSettings = {
  initialHp: DEFAULT_HP,
  initialStamina: DEFAULT_START_STAMINA,
  maxHp: DEFAULT_HP,
  maxStamina: DEFAULT_MAX_STAMINA,
  restHp: 1,
  restStamina: 3,
  attackDamage: ATTACK_DAMAGE,
  learnableSkillIds: [...ALL_SKILLS_POOL],
};

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

const POOL_SET = new Set<SkillId>(ALL_SKILLS_POOL);

export function normalizeRoomGameSettings(raw?: Partial<RoomGameSettings>): RoomGameSettings {
  const d = DEFAULT_ROOM_GAME_SETTINGS;
  let initialHp = clampInt(Number(raw?.initialHp ?? d.initialHp), 1, 500);
  let initialStamina = clampInt(Number(raw?.initialStamina ?? d.initialStamina), 0, 500);
  let maxHp = clampInt(Number(raw?.maxHp ?? d.maxHp), 1, 500);
  let maxStamina = clampInt(Number(raw?.maxStamina ?? d.maxStamina), 0, 500);

  if (initialHp > maxHp) maxHp = initialHp;
  if (initialStamina > maxStamina) maxStamina = initialStamina;
  if (maxHp < initialHp) maxHp = initialHp;
  if (maxStamina < initialStamina) maxStamina = initialStamina;

  const restHp = clampInt(Number(raw?.restHp ?? d.restHp), 0, 100);
  const restStamina = clampInt(Number(raw?.restStamina ?? d.restStamina), 0, 100);
  const attackDamage = clampInt(Number(raw?.attackDamage ?? d.attackDamage), 1, 100);

  const incoming = Array.isArray(raw?.learnableSkillIds) ? raw.learnableSkillIds : d.learnableSkillIds;
  let learnableSkillIds = incoming.filter((id): id is SkillId => POOL_SET.has(id as SkillId));
  if (learnableSkillIds.length === 0) learnableSkillIds = [...ALL_SKILLS_POOL];

  return {
    initialHp,
    initialStamina,
    maxHp,
    maxStamina,
    restHp,
    restStamina,
    attackDamage,
    learnableSkillIds,
  };
}

export function toGameSessionRules(s: RoomGameSettings): GameSessionRules {
  return {
    maxHp: s.maxHp,
    maxStamina: s.maxStamina,
    restHp: s.restHp,
    restStamina: s.restStamina,
    attackDamage: s.attackDamage,
    learnableSkills: [...s.learnableSkillIds],
  };
}
