export const GRID_SIZE = 15;
export const DEFAULT_HP = 10;
/** 开局体力 */
export const DEFAULT_START_STAMINA = 5;
/** 体力上限（回合开始 +2、休息 +3 后以此封顶） */
export const DEFAULT_MAX_STAMINA = 10;
export const VISION_RADIUS = 2;
/** 攻击距离：切比雪夫半径（方形邻域） */
export const ATTACK_RANGE = 2;
export const ATTACK_COST = 2;
export const ATTACK_DAMAGE = 3;
export const OUTER_SPAWN_LAYERS = 5; // 最外 5 层：到边距离 0..4
export const MIN_SPAWN_DISTANCE = 7; // Manhattan > 6

/** 每回合行动限时（毫秒） */
export const TURN_LIMIT_MS = 45_000;

export const SKILL_IDS = [
  "laser",
  "missile",
  "sniper",
  "flare",
  "burn",
  "bounty",
  "stealth",
  "jet",
  "jump",
  "execute",
] as const;

export type SkillId = (typeof SKILL_IDS)[number];

export const SKILL_META: Record<
  SkillId,
  { name: string; cost: number; cooldown: number }
> = {
  laser: { name: "激光", cost: 5, cooldown: 1 },
  missile: { name: "导弹", cost: 6, cooldown: 1 },
  sniper: { name: "狙击", cost: 8, cooldown: 2 },
  flare: { name: "照明弹", cost: 4, cooldown: 1 },
  burn: { name: "燃烧弹", cost: 6, cooldown: 2 },
  bounty: { name: "悬赏", cost: 2, cooldown: 4 },
  stealth: { name: "隐身", cost: 5, cooldown: 4 },
  jet: { name: "喷射器", cost: 3, cooldown: 1 },
  jump: { name: "空间跳跃", cost: 5, cooldown: 2 },
  execute: { name: "斩首", cost: 5, cooldown: 2 },
};

export const ALL_SKILLS_POOL: SkillId[] = [...SKILL_IDS];
