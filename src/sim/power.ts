import { isMonument, isRoadType, isService, isZone, type Tile } from '../engine/map';
import { POWER_RANGE, WATER_LAKE_BONUS, WATER_RANGE } from './constants';

/** Les réseaux (courant et canalisations) suivent les routes, les zones et les bâtiments contigus. */
const conducts = (t: Tile) =>
  isRoadType(t.type) || t.type === 'POWER' || isZone(t.type) || isService(t.type) || isMonument(t.type);
const consumes = (t: Tile) => t.type === 'POWER' || isZone(t.type) || isService(t.type) || isMonument(t.type);

/**
 * Flood fill (BFS multi-sources) : part de chaque source et propage de proche
 * en proche à travers les tuiles conductrices, jusqu'à la portée de sa source.
 */
export function floodNetwork(tiles: Tile[], size: number, sourceRange: (t: Tile) => number): Uint8Array {
  const reached = new Uint8Array(size * size);
  const left = new Int16Array(size * size).fill(-1);
  // File de priorité simplifiée : on traite d'abord les sources de plus grande portée.
  const sources: number[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const r = sourceRange(tiles[i]);
    if (r > 0) {
      left[i] = r;
      reached[i] = 1;
      sources.push(i);
    }
  }
  sources.sort((a, b) => left[b] - left[a]);
  const queue = new Int32Array(size * size * 2);
  let head = 0;
  let tail = 0;
  for (const s of sources) queue[tail++] = s;

  while (head < tail) {
    const i = queue[head++];
    if (left[i] <= 0) continue;
    const x = i % size;
    const y = (i - x) / size;
    const neighbours = [
      x + 1 < size ? i + 1 : -1,
      x > 0 ? i - 1 : -1,
      y + 1 < size ? i + size : -1,
      y > 0 ? i - size : -1,
    ];
    for (const n of neighbours) {
      if (n < 0 || left[n] >= left[i] - 1 || !conducts(tiles[n])) continue;
      left[n] = left[i] - 1;
      reached[n] = 1;
      if (tail < queue.length) queue[tail++] = n;
    }
  }
  return reached;
}

const nearLake = (tiles: Tile[], size: number, t: Tile) =>
  [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ].some(([dx, dy]) => {
    const nx = t.x + dx;
    const ny = t.y + dy;
    return nx >= 0 && ny >= 0 && nx < size && ny < size && tiles[ny * size + nx].type === 'LAKE';
  });

/** Réseau électrique : part de chaque centrale en état de marche (portée POWER_RANGE). */
export function computePowerGrid(tiles: Tile[], size: number): Uint8Array {
  return floodNetwork(tiles, size, (t) => (t.type === 'POWER' && t.flood === 0 ? POWER_RANGE : 0));
}

/**
 * Applique courant puis eau à la carte. Les châteaux d'eau ne pompent que
 * s'ils sont alimentés en électricité ; au bord d'un lac, ils portent plus loin.
 * Seules les tuiles dont l'état change sont recréées : le renderer ne redessine
 * que les morceaux concernés.
 */
export function applyPower(tiles: Tile[], size: number): Tile[] {
  const power = computePowerGrid(tiles, size);
  const water = floodNetwork(tiles, size, (t) =>
    t.type === 'WATER' && t.flood === 0 && power[t.y * size + t.x] === 1
      ? WATER_RANGE + (nearLake(tiles, size, t) ? WATER_LAKE_BONUS : 0)
      : 0,
  );
  let out: Tile[] | null = null;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const c = consumes(t);
    const p = c && power[i] === 1;
    const w = c && water[i] === 1;
    if (t.powered !== p || t.water !== w) {
      out ??= tiles.slice();
      out[i] = { ...t, powered: p, water: w };
    }
  }
  return out ?? tiles;
}
