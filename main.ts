// Sokoban solver for make.fun's sokoban-solver-01 (21 November 2026 run).
//
// Approach: the levels this competition draws are a hallway with independent
// rooms off it (one door each, boxes that can never leave their room), so the
// level splits into one small push-optimal problem per room and the optima
// add up to the level's push optimum. Each room is solved with an A* search
// over pushes (not moves): a state is the boxes plus the player's reachable
// region, the estimate is the cheapest assignment of boxes to goals by
// walking distance, and dead positions are pruned with a reverse-pull
// liveness table plus a frozen 2x2 test. Rooms are stitched together with
// shortest walks along the hallway. Everything is budgeted by work (a fixed
// number of expanded states), never by the clock, so two runs write the
// same bytes. Only Node built-ins; no network, no files outside /input,
// /output and /bot.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four steps, in one fixed order everywhere so every tie breaks the same way.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const LETTER = ['u', 'd', 'l', 'r'];

// The most states one room's search may expand: work, never the clock.
const MAX_EXPANSIONS = 400_000;

interface Board {
  w: number;
  h: number;
  wall: Uint8Array; // 1 where a wall (or a foreign box) stands
  goals: number[];
  boxes: number[];
  player: number;
}

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on goal, @ player). */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // Nothing leaves the board: the outer frame is wall whatever it shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * Liveness table: the squares a single box can ever be pushed from onto some
 * goal. Computed backwards from the goals: a square q is live when some
 * neighbour q+d is live and the square q-d (where the player would stand to
 * pull the box back from q+d to q) is open floor. A box on a square this
 * table calls dead can never reach a goal, so any state holding one is pruned.
 * The table ignores the other boxes, so it never prunes a winnable state.
 */
function liveSquares(w: number, wall: Uint8Array, goals: number[]): Uint8Array {
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (let k = 0; k < 4; k++) {
      const d = DY[k]! * w + DX[k]!;
      const y = x - d;
      if (y < 0 || y >= wall.length) continue;
      const z = y - d;
      if (z < 0 || z >= wall.length) continue;
      if (!wall[y] && !wall[z] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Walking distances from one square over open floor, ignoring boxes. */
function walkDistances(w: number, wall: Uint8Array, from: number): Int32Array {
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [from];
  dist[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k]! * w + DX[k]!;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || dist[q] >= 0) continue;
      dist[q] = dist[p]! + 1;
      queue.push(q);
    }
  }
  return dist;
}

/**
 * Split a level into its rooms: cut the hallway out of the floor (the
 * player's row, minus the squares a box could ever reach a goal from) and
 * take each connected part that holds boxes. A part holds as many goals as
 * boxes. Null when the level does not split that way.
 */
function splitRooms(level: Board): { boxes: number[]; goals: number[]; done: boolean }[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(w, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { boxes: number[]; goals: number[]; done: boolean }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i]!;
      for (let k = 0; k < 4; k++) {
        const q = p + DY[k]! * w + DX[k]!;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** A small binary heap ordered by (f, deeper g first, earlier insertion). */
class Heap {
  private items: [number, number, number, number][] = [];
  get size(): number {
    return this.items.length;
  }
  private static less(a: [number, number, number, number], b: [number, number, number, number]): boolean {
    return a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  }
  push(e: [number, number, number, number]): void {
    const items = this.items;
    items.push(e);
    let i = items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!Heap.less(items[i]!, items[p]!)) break;
      const t = items[i]!;
      items[i] = items[p]!;
      items[p] = t;
      i = p;
    }
  }
  pop(): [number, number, number, number] {
    const items = this.items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= items.length) break;
        if (c + 1 < items.length && Heap.less(items[c + 1]!, items[c]!)) c++;
        if (!Heap.less(items[c]!, items[i]!)) break;
        const t = items[i]!;
        items[i] = items[c]!;
        items[c] = t;
        i = c;
      }
    }
    return top;
  }
}

/**
 * The squares the player reaches from `from` around walls and the boxes in
 * `occupied`, marked in `seen` with `stamp`; answers the lowest of them.
 * The lowest reachable square names the region: two states with the same
 * boxes and the same lowest square give the player the same pushes.
 */
function floodRegion(
  w: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k]! * w + DX[k]!;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed onto `t` is stuck in a frozen 2x2 block. */
function frozenBlock(
  w: number,
  h: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  goalSet: Uint8Array,
  t: number,
): boolean {
  const tx = t % w;
  const ty = Math.floor(t / w);
  const blocked = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= w || y >= h || wall[y * w + x] === 1 || occupied[y * w + x] === 1;
  const offGoalBox = (x: number, y: number): boolean => {
    const i = y * w + x;
    return x >= 0 && y >= 0 && x < w && y < h && occupied[i] === 1 && goalSet[i] === 0;
  };
  for (const [cx, cy] of [
    [tx, ty],
    [tx - 1, ty],
    [tx, ty - 1],
    [tx - 1, ty - 1],
  ] as const) {
    if (!blocked(cx, cy) || !blocked(cx + 1, cy) || !blocked(cx, cy + 1) || !blocked(cx + 1, cy + 1)) continue;
    if (offGoalBox(cx, cy) || offGoalBox(cx + 1, cy) || offGoalBox(cx, cy + 1) || offGoalBox(cx + 1, cy + 1)) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, lower-case letters. */
function walkTo(
  w: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Uint8Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k]! * w + DX[k]!;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = k;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = LETTER[how[p]!]! + s;
  return s;
}

/** All orderings of n items, as index lists (n is at most 4 here). */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const rec = (): void => {
    if (cur.length === n) {
      out.push([...cur]);
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  };
  rec();
  return out;
}

interface RoomResult {
  pushes: number;
  moves: string;
}

/**
 * Solve one room push-optimally with A* over pushes. `wall` already treats
 * every foreign box as a wall, so the search never leaves this room. The
 * estimate is the cheapest matching of boxes to goals by walking distance
 * (each push moves one box one square, so it never overestimates), and a
 * state is pruned when a box stands on a dead square or freezes into a 2x2
 * block. Null when the budget runs out or the room has no solution.
 */
function solveRoom(board: Board, maxExpansions: number): RoomResult | null {
  const { w, h, wall, goals, boxes, player } = board;
  const n = boxes.length;
  const size = wall.length;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const live = liveSquares(w, wall, goals);
  if (boxes.some((b) => !live[b])) return null;
  const solved = (bs: number[]): boolean => bs.every((b) => goalSet[b] === 1);
  if (solved(boxes)) return { pushes: 0, moves: '' };

  // Walking distance from each goal to every square (boxes ignored).
  const distFromGoal = goals.map((g) => walkDistances(w, wall, g));
  const orders = permutations(n);
  const estimate = (bs: number[]): number => {
    let best = Infinity;
    for (const order of orders) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const d = distFromGoal[order[i]!]![bs[i]!]!;
        if (d < 0) {
          sum = Infinity;
          break;
        }
        sum += d;
      }
      if (sum < best) best = sum;
    }
    return best;
  };

  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  let markStamp = 0;
  const occupied = new Uint8Array(size);
  const keyOf = (bs: number[], low: number): string => bs.join(',') + '|' + low;

  // The states: boxes, player square, parent, and the push that made them.
  const sBoxes: number[][] = [boxes.slice()];
  const sPlayer: number[] = [player];
  const sParent: number[] = [-1];
  const sPushFrom: number[] = [-1];
  const sPushTo: number[] = [-1];
  const sPushDir: number[] = [-1];
  const sG: number[] = [0];
  const bestG = new Map<string, number>();
  for (const b of boxes) occupied[b] = 1;
  const startLow = floodRegion(w, wall, occupied, player, seen, ++stamp, stack);
  for (const b of boxes) occupied[b] = 0;
  bestG.set(keyOf(boxes, startLow), 0);
  const heap = new Heap();
  let seq = 0;
  heap.push([estimate(boxes), 0, seq++, 0]);

  let expanded = 0;
  let found = -1;
  while (heap.size > 0 && expanded < maxExpansions) {
    const [, negG, , s] = heap.pop();
    const g = -negG;
    const bs = sBoxes[s]!;
    // The region's lowest square names the state; skip superseded heap entries.
    const occ = occupiedFor(bs, occupied);
    const hereLow = floodRegion(w, wall, occ, sPlayer[s]!, seen, ++stamp, stack);
    if (bestG.get(keyOf(bs, hereLow)) !== g) continue;
    if (solved(bs)) {
      found = s;
      break;
    }
    expanded++;
    const regionStamp = stamp;
    for (let bi = 0; bi < n; bi++) {
      const b = bs[bi]!;
      for (let k = 0; k < 4; k++) {
        const d = DY[k]! * w + DX[k]!;
        if (seen[b - d] !== regionStamp) continue; // the player cannot stand to push
        const t = b + d;
        if (t < 0 || t >= size || wall[t] || occ[t] || !live[t]) continue;
        occ[b] = 0;
        occ[t] = 1;
        const frozen = frozenBlock(w, h, wall, occ, goalSet, t);
        let next: number[] | null = null;
        let nextKey = '';
        let nextLow = -1;
        if (!frozen) {
          next = bs.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          // A separate marking array: this flood must not disturb the
          // parent region's marks, which the push checks still read.
          nextLow = floodRegion(w, wall, occ, b, mark, ++markStamp, stack);
          nextKey = keyOf(next, nextLow);
        }
        occ[t] = 0;
        occ[b] = 1;
        if (frozen || next === null) continue;
        const g2 = g + 1;
        const prevBest = bestG.get(nextKey);
        if (prevBest !== undefined && prevBest <= g2) continue;
        bestG.set(nextKey, g2);
        const idx = sBoxes.length;
        sBoxes.push(next);
        sPlayer.push(b);
        sParent.push(s);
        sPushFrom.push(b);
        sPushTo.push(t);
        sPushDir.push(k);
        sG.push(g2);
        const h2 = estimate(next);
        if (h2 === Infinity) continue;
        heap.push([g2 + h2, -g2, seq++, idx]);
      }
    }
  }
  if (found < 0) return null;

  // Rebuild the moves: walk to each push, then push, room by room of states.
  const chain: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) chain.push(s);
  chain.reverse();
  let moves = '';
  let p = player;
  let cur = boxes.slice();
  for (const s of chain) {
    const dir = sPushDir[s]!;
    const d = DY[dir]! * w + DX[dir]!;
    const from = sPushFrom[s]!;
    const occ = occupiedFor(cur, occupied);
    const walk = walkTo(w, wall, occ, p, from - d);
    if (walk === null) return null;
    moves += walk + LETTER[dir]!.toUpperCase();
    p = from;
    cur = sBoxes[s]!.slice();
  }
  return { pushes: chain.length, moves };
}

/** Fill `occupied` with the boxes `bs` (reusing one scratch array) and return it. */
function occupiedFor(bs: number[], occupied: Uint8Array): Uint8Array {
  occupied.fill(0);
  for (const b of bs) occupied[b] = 1;
  return occupied;
}

/** The player's square after playing `moves` (case aside) from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * Solve a whole level: split it into rooms, solve each room in turn with the
 * other rooms' boxes standing as walls (on their goals once their room is
 * done), and stitch the rooms' moves with the walks between them. Falls back
 * to one search over the whole level when it does not split. Empty moves
 * when any part gives up (a valid, unanswered solution scores 0, same as a
 * wrong one, and never risks an illegal step).
 */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const rooms = splitRooms(level);
  if (rooms === null) {
    const whole = solveRoom(level, MAX_EXPANSIONS);
    return whole === null ? '' : whole.moves;
  }
  let moves = '';
  let player = level.player;
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Board = { w: level.w, h: level.h, wall, goals: room.goals, boxes: room.boxes, player };
    const solved = solveRoom(sub, MAX_EXPANSIONS);
    if (solved === null) return '';
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return moves;
}

/** Replay `moves` on the level; true only when every step is legal and every box ends on a goal. */
function replaysSolved(text: string, moves: string): boolean {
  const level = parseLevel(text);
  const { w, wall } = level;
  const goalSet = new Uint8Array(wall.length);
  for (const g of level.goals) goalSet[g] = 1;
  const box = new Uint8Array(wall.length);
  for (const b of level.boxes) box[b] = 1;
  let player = level.player;
  for (const ch of moves) {
    const lower = ch.toLowerCase();
    const k = lower === 'u' ? 0 : lower === 'd' ? 1 : lower === 'l' ? 2 : lower === 'r' ? 3 : -1;
    if (k < 0) return false;
    const d = DY[k]! * w + DX[k]!;
    const next = player + d;
    if (next < 0 || next >= wall.length || wall[next]) return false;
    if (box[next]) {
      const beyond = next + d;
      if (beyond < 0 || beyond >= wall.length || wall[beyond] || box[beyond]) return false;
      box[next] = 0;
      box[beyond] = 1;
    }
    player = next;
  }
  for (let i = 0; i < box.length; i++) if (box[i] && !goalSet[i]) return false;
  return true;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    const text = readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8');
    moves = solveLevel(text);
    if (moves !== '' && !replaysSolved(text, moves)) moves = '';
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  const out = join(OUTPUT_DIR, id, 'solution.txt');
  writeFileSync(out, `${moves}\n`);
  chmodSync(out, 0o644);
}
