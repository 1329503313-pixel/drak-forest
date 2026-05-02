import type { RoomGameSettings } from "@/types/room";
import type { SkillId } from "@/types/game";
import { SKILL_CATALOG } from "@/constants/skillCatalog";

/** 与服务器 DEFAULT_ROOM_GAME_SETTINGS 对齐；房间未下发 gameSettings 时使用 */
export const DEFAULT_LEARNABLE_SKILL_IDS: SkillId[] = SKILL_CATALOG.map((s) => s.id);

export const DEFAULT_ROOM_GAME_SETTINGS: RoomGameSettings = {
  initialHp: 10,
  initialStamina: 5,
  maxHp: 10,
  maxStamina: 10,
  restHp: 1,
  restStamina: 3,
  attackDamage: 3,
  learnableSkillIds: [...DEFAULT_LEARNABLE_SKILL_IDS],
};
