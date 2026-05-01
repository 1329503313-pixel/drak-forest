export const ALLOWED_GRID_SIZES = [15, 20, 25, 30] as const;
export type AllowedGridSize = (typeof ALLOWED_GRID_SIZES)[number];

export function isAllowedGridSize(n: number): n is AllowedGridSize {
  return (ALLOWED_GRID_SIZES as readonly number[]).includes(n);
}

export function normalizeGridSize(raw: unknown): AllowedGridSize | null {
  const v = Number(raw);
  return isAllowedGridSize(v) ? v : null;
}

export function mapSizeLabel(n: number): string {
  if (n === 15) return "小型地图（15×15）";
  if (n === 20) return "中型地图（20×20）";
  if (n === 25) return "大型地图（25×25）";
  if (n === 30) return "超大型地图（30×30）";
  return `${n}×${n}`;
}
