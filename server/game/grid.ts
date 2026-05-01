export function inBounds(col: number, row: number, n: number): boolean {
  return col >= 0 && col < n && row >= 0 && row < n;
}

export function cellKey(col: number, row: number): string {
  return `${col},${row}`;
}

export function parseKey(k: string): { col: number; row: number } {
  const [a, b] = k.split(",").map(Number);
  return { col: a!, row: b! };
}

/** 列 0 -> A */
export function colLetter(col: number): string {
  return String.fromCharCode("A".charCodeAt(0) + col);
}

/** 行 0 -> 显示为 1 */
export function rowLabel(row: number): number {
  return row + 1;
}

/** 第二列第三行 -> C2：用户定义横向字母、纵向数字为行号 */
export function formatCellLabel(col: number, row: number): string {
  return `${colLetter(col)}${rowLabel(row)}`;
}

export function manhattan(a: { col: number; row: number }, b: { col: number; row: number }): number {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
}

export function chebyshev(a: { col: number; row: number }, b: { col: number; row: number }): number {
  return Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));
}

/** 到地图边缘的最小步数（用于外圈分层） */
export function edgeDistance(col: number, row: number, n: number): number {
  return Math.min(col, row, n - 1 - col, n - 1 - row);
}

export function orthogonalNeighbors(
  col: number,
  row: number,
  n: number
): Array<{ col: number; row: number }> {
  const out: Array<{ col: number; row: number }> = [];
  const ds = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ];
  for (const [dc, dr] of ds) {
    const c = col + dc!;
    const r = row + dr!;
    if (inBounds(c, r, n)) out.push({ col: c, row: r });
  }
  return out;
}

function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function randomFrom<T>(arr: T[]): T | undefined {
  return arr[Math.floor(Math.random() * arr.length)];
}

function wallComponents(walls: Set<string>, n: number): string[][] {
  const unseen = new Set(walls);
  const groups: string[][] = [];
  for (const start of walls) {
    if (!unseen.has(start)) continue;
    const group: string[] = [];
    const q = [parseKey(start)];
    unseen.delete(start);
    for (let i = 0; i < q.length; i++) {
      const cur = q[i]!;
      const k = cellKey(cur.col, cur.row);
      group.push(k);
      for (const nb of orthogonalNeighbors(cur.col, cur.row, n)) {
        const nk = cellKey(nb.col, nb.row);
        if (!unseen.has(nk)) continue;
        unseen.delete(nk);
        q.push(nb);
      }
    }
    groups.push(group);
  }
  return groups;
}

function allProtectedCellsConnected(n: number, walls: Set<string>, protectedKeys: Set<string>): boolean {
  const starts = [...protectedKeys].filter((k) => !walls.has(k));
  if (starts.length === 0) return true;
  const seen = new Set<string>();
  const q = [parseKey(starts[0]!)];
  seen.add(starts[0]!);
  for (let i = 0; i < q.length; i++) {
    const cur = q[i]!;
    for (const nb of orthogonalNeighbors(cur.col, cur.row, n)) {
      const nk = cellKey(nb.col, nb.row);
      if (walls.has(nk) || seen.has(nk)) continue;
      seen.add(nk);
      q.push(nb);
    }
  }
  return starts.every((k) => seen.has(k));
}

function growCluster(
  n: number,
  targetSize: number,
  walls: Set<string>,
  protectedKeys: Set<string>
): string[] | null {
  const available: string[] = [];
  for (let c = 0; c < n; c++) {
    for (let r = 0; r < n; r++) {
      const k = cellKey(c, r);
      if (!walls.has(k) && !protectedKeys.has(k)) available.push(k);
    }
  }
  const seed = randomFrom(available);
  if (!seed) return null;

  const cluster = new Set<string>([seed]);
  const frontier = [parseKey(seed)];

  while (cluster.size < targetSize && frontier.length > 0) {
    const from = frontier[randomInt(0, frontier.length - 1)]!;
    const candidates = orthogonalNeighbors(from.col, from.row, n).filter((nb) => {
      const nk = cellKey(nb.col, nb.row);
      return !walls.has(nk) && !protectedKeys.has(nk) && !cluster.has(nk);
    });
    const next = randomFrom(candidates);
    if (!next) {
      frontier.splice(frontier.indexOf(from), 1);
      continue;
    }
    const nk = cellKey(next.col, next.row);
    cluster.add(nk);
    frontier.push(next);
  }

  return cluster.size >= targetSize ? [...cluster] : null;
}

function addToExistingWalls(
  n: number,
  count: number,
  walls: Set<string>,
  protectedKeys: Set<string>
): boolean {
  for (let i = 0; i < count; i++) {
    const candidates: string[] = [];
    for (const wk of walls) {
      const { col, row } = parseKey(wk);
      for (const nb of orthogonalNeighbors(col, row, n)) {
        const nk = cellKey(nb.col, nb.row);
        if (!walls.has(nk) && !protectedKeys.has(nk)) candidates.push(nk);
      }
    }
    const chosen = randomFrom(candidates);
    if (!chosen) return false;
    walls.add(chosen);
  }
  return true;
}

export function generateWallKeys(
  n: number,
  protectedCells: Array<{ col: number; row: number }>,
  ratio = 0.15
): string[] {
  const target = Math.max(4, Math.round(n * n * ratio));
  const protectedKeys = new Set(protectedCells.map((p) => cellKey(p.col, p.row)));

  for (let attempt = 0; attempt < 80; attempt++) {
    const walls = new Set<string>();

    while (walls.size < target) {
      const remaining = target - walls.size;
      if (remaining < 4) {
        if (!addToExistingWalls(n, remaining, walls, protectedKeys)) break;
        continue;
      }

      const clusterSize = Math.min(remaining, randomInt(4, 8));
      const cluster = growCluster(n, clusterSize, walls, protectedKeys);
      if (!cluster) break;
      for (const k of cluster) walls.add(k);
    }

    if (walls.size !== target) continue;
    if (wallComponents(walls, n).some((group) => group.length < 4)) continue;
    if (!allProtectedCellsConnected(n, walls, protectedKeys)) continue;
    return [...walls];
  }

  return [];
}

/** 激光八个方向 */
export const OCT_DIRS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

export function rayFrom(
  col: number,
  row: number,
  dc: number,
  dr: number,
  n: number
): Array<{ col: number; row: number }> {
  const cells: Array<{ col: number; row: number }> = [];
  let c = col + dc;
  let r = row + dr;
  while (inBounds(c, r, n)) {
    cells.push({ col: c, row: r });
    c += dc;
    r += dr;
  }
  return cells;
}

export function cellsInRectCenter(
  centerCol: number,
  centerRow: number,
  half: number,
  n: number
): Array<{ col: number; row: number }> {
  const out: Array<{ col: number; row: number }> = [];
  for (let dc = -half; dc <= half; dc++) {
    for (let dr = -half; dr <= half; dr++) {
      const c = centerCol + dc;
      const r = centerRow + dr;
      if (inBounds(c, r, n)) out.push({ col: c, row: r });
    }
  }
  return out;
}
