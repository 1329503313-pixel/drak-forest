export type MatchMode = "solo" | "duo" | "trio" | "squad";

export type MatchModeConfig = {
  mode: MatchMode;
  label: string;
  teamSize: number;
  maxSlots: number;
  rowSize: number;
};

export const MATCH_MODE_CONFIGS: Record<MatchMode, MatchModeConfig> = {
  solo: { mode: "solo", label: "单人混战", teamSize: 1, maxSlots: 8, rowSize: 4 },
  duo: { mode: "duo", label: "两人组队", teamSize: 2, maxSlots: 8, rowSize: 4 },
  trio: { mode: "trio", label: "三人组队", teamSize: 3, maxSlots: 9, rowSize: 3 },
  squad: { mode: "squad", label: "四人组队", teamSize: 4, maxSlots: 8, rowSize: 4 },
};

export function normalizeMatchMode(raw: unknown): MatchMode {
  const s = String(raw ?? "");
  return s === "duo" || s === "trio" || s === "squad" ? s : "solo";
}

export function matchModeConfig(mode: unknown): MatchModeConfig {
  return MATCH_MODE_CONFIGS[normalizeMatchMode(mode)];
}

export function teamIdForSlot(mode: MatchMode, slotIndex: number): number {
  const cfg = matchModeConfig(mode);
  return Math.floor(slotIndex / cfg.teamSize);
}
