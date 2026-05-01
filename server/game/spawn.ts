import { MIN_SPAWN_DISTANCE, OUTER_SPAWN_LAYERS } from "./constants.js";
import { edgeDistance, inBounds, manhattan } from "./grid.js";

export function outerRingCandidateCells(n: number): Array<{ col: number; row: number }> {
  const out: Array<{ col: number; row: number }> = [];
  for (let c = 0; c < n; c++) {
    for (let r = 0; r < n; r++) {
      if (edgeDistance(c, r, n) < OUTER_SPAWN_LAYERS) {
        out.push({ col: c, row: r });
      }
    }
  }
  return out;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * 为 n 名玩家在候选格中选取出生点，两两 Manhattan 距离 >= MIN_SPAWN_DISTANCE
 */
export function pickSpawnPositions(
  playerCount: number,
  gridSize: number,
  candidates?: Array<{ col: number; row: number }>
): Array<{ col: number; row: number }> | null {
  const pool = candidates ?? outerRingCandidateCells(gridSize);
  if (pool.length < playerCount) return null;

  const tryPick = (): Array<{ col: number; row: number }> | null => {
    const order = shuffle(pool);
    const picks: Array<{ col: number; row: number }> = [];
    for (const cell of order) {
      if (picks.length >= playerCount) break;
      const ok = picks.every((p) => manhattan(p, cell) >= MIN_SPAWN_DISTANCE);
      if (ok) picks.push(cell);
    }
    return picks.length === playerCount ? picks : null;
  };

  for (let attempt = 0; attempt < 80; attempt++) {
    const res = tryPick();
    if (res) return res;
  }
  return null;
}

export function randomEmptyCell(
  occupied: Set<string>,
  keyFn: (c: number, r: number) => string,
  gridSize: number
): { col: number; row: number } | null {
  const free: Array<{ col: number; row: number }> = [];
  for (let c = 0; c < gridSize; c++) {
    for (let r = 0; r < gridSize; r++) {
      const k = keyFn(c, r);
      if (!occupied.has(k)) free.push({ col: c, row: r });
    }
  }
  if (free.length === 0) return null;
  return free[Math.floor(Math.random() * free.length)]!;
}
