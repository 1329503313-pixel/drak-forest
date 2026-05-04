import { ATTACK_RANGE_CHEBYSHEV } from "@/constants/game";
import type { GameClientState, SkillId } from "@/types/game";

export function cellKey(col: number, row: number): string {
  return `${col},${row}`;
}

export function parseKey(k: string): { col: number; row: number } {
  const [a, b] = k.split(",").map(Number);
  return { col: a!, row: b! };
}

export function inBounds(col: number, row: number, n: number): boolean {
  return col >= 0 && col < n && row >= 0 && row < n;
}

export function inPlayableArea(
  col: number,
  row: number,
  n: number,
  shrinkMargin: number
): boolean {
  const m = shrinkMargin;
  return col >= m && col <= n - 1 - m && row >= m && row <= n - 1 - m;
}

/** 已被清除、不可站立的格子 */
export function keysOutsidePlayable(n: number, shrinkMargin: number): Set<string> {
  const s = new Set<string>();
  for (let c = 0; c < n; c++) {
    for (let r = 0; r < n; r++) {
      if (!inPlayableArea(c, r, n, shrinkMargin)) s.add(cellKey(c, r));
    }
  }
  return s;
}

/** 当前安全区边界一圈（奇数回合预警闪烁） */
export function outerRingKeys(margin: number, n: number): Set<string> {
  const lo = margin;
  const hi = n - 1 - margin;
  if (lo > hi) return new Set();
  const set = new Set<string>();
  for (let c = lo; c <= hi; c++) {
    set.add(cellKey(c, lo));
    set.add(cellKey(c, hi));
  }
  for (let r = lo + 1; r <= hi - 1; r++) {
    set.add(cellKey(lo, r));
    set.add(cellKey(hi, r));
  }
  return set;
}

export function manhattan(
  a: { col: number; row: number },
  b: { col: number; row: number }
): number {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
}

export function chebyshev(
  a: { col: number; row: number },
  b: { col: number; row: number }
): number {
  return Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));
}

/** 允许多人同格，移动只被墙壁阻挡 */
export function blockedCellsForMove(state: GameClientState, _myId: string): Set<string> {
  return new Set([...(state.wallKeys ?? []), ...(state.beast?.cellKeys ?? [])]);
}

function rectCenterKeys(
  centerCol: number,
  centerRow: number,
  half: number,
  n: number
): Set<string> {
  const set = new Set<string>();
  for (let dc = -half; dc <= half; dc++) {
    for (let dr = -half; dr <= half; dr++) {
      const c = centerCol + dc;
      const r = centerRow + dr;
      if (inBounds(c, r, n)) set.add(cellKey(c, r));
    }
  }
  return set;
}

/** 技能命中范围（相对锚点格），用于红框预览 */
export function skillAoeKeys(
  skill: SkillId,
  anchorCol: number,
  anchorRow: number,
  n: number
): Set<string> {
  if (skill === "missile" || skill === "burn") {
    return rectCenterKeys(anchorCol, anchorRow, 1, n);
  }
  if (skill === "flare") {
    return rectCenterKeys(anchorCol, anchorRow, 2, n);
  }
  if (skill === "sniper" || skill === "jump") {
    return new Set([cellKey(anchorCol, anchorRow)]);
  }
  if (
    skill === "shadow_clone" ||
    skill === "nuke" ||
    skill === "landmine" ||
    skill === "sonic_radar"
  ) {
    return new Set([cellKey(anchorCol, anchorRow)]);
  }
  return new Set();
}

/** 激光射线经过的格子（不含起点自身站立格） */
export function laserRayCells(
  meCol: number,
  meRow: number,
  dc: number,
  dr: number,
  n: number
): Array<{ col: number; row: number }> {
  const out: Array<{ col: number; row: number }> = [];
  let c = meCol + dc;
  let r = meRow + dr;
  while (inBounds(c, r, n)) {
    out.push({ col: c, row: r });
    c += dc;
    r += dr;
  }
  return out;
}

/** 攻击距离内全部格子（含迷雾），用于绿色高亮；点击仍须在敌方可打击位置 */
export function attackRangeKeys(meCol: number, meRow: number, n: number): Set<string> {
  const set = new Set<string>();
  for (let c = 0; c < n; c++) {
    for (let r = 0; r < n; r++) {
      if (chebyshev({ col: meCol, row: meRow }, { col: c, row: r }) > ATTACK_RANGE_CHEBYSHEV)
        continue;
      if (c === meCol && r === meRow) continue;
      set.add(cellKey(c, r));
    }
  }
  return set;
}

type BfsPrev = Map<string, string | null>;

export function reachableOrthogonalCells(
  startCol: number,
  startRow: number,
  maxCost: number,
  n: number,
  blocked: Set<string>
): { reachable: Set<string>; prev: BfsPrev } {
  const reachable = new Set<string>();
  const prev = new Map<string, string | null>();
  const dist = new Map<string, number>();
  const startK = cellKey(startCol, startRow);
  const q: Array<{ col: number; row: number }> = [{ col: startCol, row: startRow }];
  prev.set(startK, null);
  dist.set(startK, 0);
  reachable.add(startK);

  const dirs = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ];
  let qi = 0;
  while (qi < q.length) {
    const cur = q[qi++]!;
    const ck = cellKey(cur.col, cur.row);
    const d = dist.get(ck)!;
    if (d >= maxCost) continue;
    for (const [dc, dr] of dirs) {
      const nc = cur.col + dc!;
      const nr = cur.row + dr!;
      if (!inBounds(nc, nr, n)) continue;
      const nk = cellKey(nc, nr);
      if (nk !== startK && blocked.has(nk)) continue;
      const nd = d + 1;
      if (nd > maxCost) continue;
      if (!dist.has(nk)) {
        dist.set(nk, nd);
        prev.set(nk, ck);
        reachable.add(nk);
        q.push({ col: nc, row: nr });
      }
    }
  }
  return { reachable, prev };
}

export function buildPathFromBfs(
  goalCol: number,
  goalRow: number,
  startCol: number,
  startRow: number,
  prev: BfsPrev
): Array<{ col: number; row: number }> | null {
  const goalK = cellKey(goalCol, goalRow);
  const startK = cellKey(startCol, startRow);
  if (!prev.has(goalK)) return null;
  const out: Array<{ col: number; row: number }> = [];
  let cur: string | null = goalK;
  while (cur && cur !== startK) {
    out.push(parseKey(cur));
    cur = prev.get(cur) ?? null;
  }
  if (cur !== startK) return null;
  out.reverse();
  return out;
}

export function jetReachableKeys(
  meCol: number,
  meRow: number,
  n: number,
  blocked: Set<string>
): Set<string> {
  const set = new Set<string>();
  for (let c = 0; c < n; c++) {
    for (let r = 0; r < n; r++) {
      if (chebyshev({ col: meCol, row: meRow }, { col: c, row: r }) > 8) continue;
      const k = cellKey(c, r);
      if (k === cellKey(meCol, meRow)) continue;
      if (blocked.has(k)) continue;
      set.add(k);
    }
  }
  return set;
}

/** 以自身为中心 3×3（距自身不超过 1 格）内的可斩首目标 */
export function adjacentEnemyAt(
  state: GameClientState,
  myId: string,
  meCol: number,
  meRow: number
): Map<string, { col: number; row: number }> {
  const m = new Map<string, { col: number; row: number }>();
  const me = state.players.find((p) => p.socketId === myId);
  for (const p of state.players) {
    if (p.eliminated || p.socketId === myId) continue;
    if ((state.teamSize ?? 1) > 1 && p.teamId === me?.teamId) continue;
    if (p.col == null || p.row == null) continue;
    const dc = Math.abs(p.col - meCol);
    const dr = Math.abs(p.row - meRow);
    if (Math.max(dc, dr) <= 1) {
      m.set(p.socketId, { col: p.col, row: p.row });
    }
  }
  return m;
}
