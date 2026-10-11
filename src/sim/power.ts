import { isFacility, isLogistics, isMonument, isPlant, isRoadType, isVenue, isZone, type PlantType, type Tile } from '../engine/map';
import { PLANT_OUTPUT, POWER_RANGE, POWER_USE, seasonOf, WATER_LAKE_BONUS, WATER_RANGE } from './constants';

/** Les réseaux (courant et canalisations) suivent les routes, les zones et les bâtiments contigus. */
const conducts = (t: Tile) => isRoadType(t.type) || isZone(t.type) || isFacility(t.type);
const consumes = (t: Tile) => isZone(t.type) || isFacility(t.type);

/**
 * Flood fill (BFS multi-sources) : part de chaque source et propage de proche
 * en proche à travers les tuiles conductrices, jusqu'à la portée de sa source.
 * `order` liste les tuiles atteintes, des plus proches d'une source aux plus lointaines.
 */
export function floodNetworkOrdered(tiles: Tile[], size: number, sourceRange: (t: Tile) => number): { reached: Uint8Array; order: Int32Array; count: number } {
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
  const order = new Int32Array(size * size);
  let count = 0;
  let head = 0;
  let tail = 0;
  for (const s of sources) {
    queue[tail++] = s;
    order[count++] = s;
  }

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
      if (!reached[n]) order[count++] = n;
      reached[n] = 1;
      if (tail < queue.length) queue[tail++] = n;
    }
  }
  return { reached, order, count };
}

export function floodNetwork(tiles: Tile[], size: number, sourceRange: (t: Tile) => number): Uint8Array {
  return floodNetworkOrdered(tiles, size, sourceRange).reached;
}

/** Rendement saisonnier : le solaire produit peu l'hiver, l'éolien plus. */
export function plantFactor(type: PlantType, month: number): number {
  const season = seasonOf(month);
  if (type === 'SOLAR') return season === 'summer' ? 1.2 : season === 'winter' ? 0.45 : 0.9;
  if (type === 'WIND') return season === 'winter' ? 1.25 : season === 'summer' ? 0.7 : season === 'autumn' ? 1.1 : 1;
  return 1;
}

/** Production d'une centrale ce mois-ci (0 si en panne). */
export const plantOutput = (t: Tile, month: number) => (isPlant(t.type) && t.flood === 0 ? PLANT_OUTPUT[t.type] * plantFactor(t.type, month) : 0);

/** Consommation électrique d'une tuile (MW). */
export function powerUse(t: Tile): number {
  if (isZone(t.type)) return t.density > 0 ? POWER_USE[t.type] * t.density : POWER_USE.lot;
  if (isPlant(t.type)) return 0;
  if (t.type === 'WATER') return POWER_USE.water;
  if (isVenue(t.type)) return POWER_USE.venue;
  if (isLogistics(t.type)) return POWER_USE.logistics;
  if (isMonument(t.type)) return POWER_USE.monument;
  if (t.type === 'PARK' || t.type === 'BUSSTOP') return 0;
  return isFacility(t.type) ? POWER_USE.service : 0;
}

export type PowerGrid = {
  powered: Uint8Array;
  /** Production totale (MW) et consommation demandée / servie. */
  supply: number;
  demand: number;
  served: number;
  /** Consommation hors de portée de toute centrale (MW). */
  outOfRange: number;
};

/**
 * Réseau électrique : chaque centrale en état de marche alimente les tuiles à
 * portée (POWER_RANGE). Dans chaque réseau connexe, la production est répartie
 * des consommateurs les plus proches aux plus lointains : si elle ne suffit pas,
 * les plus éloignés sont délestés.
 */
export function computeGrid(tiles: Tile[], size: number, month = 3): PowerGrid {
  const { reached, order, count } = floodNetworkOrdered(tiles, size, (t) => (isPlant(t.type) && t.flood === 0 ? POWER_RANGE : 0));
  const n = tiles.length;
  // Composantes connexes des tuiles alimentables.
  const comp = new Int32Array(n).fill(-1);
  const pool: number[] = [];
  const stack: number[] = [];
  for (let k = 0; k < count; k++) {
    const s = order[k];
    if (comp[s] >= 0) continue;
    const id = pool.length;
    pool.push(0);
    comp[s] = id;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      pool[id] += plantOutput(tiles[i], month);
      const x = i % size;
      for (const nb of [x + 1 < size ? i + 1 : -1, x > 0 ? i - 1 : -1, i + size < n ? i + size : -1, i - size]) {
        if (nb < 0 || comp[nb] >= 0 || !reached[nb]) continue;
        comp[nb] = id;
        stack.push(nb);
      }
    }
  }
  const supply = pool.reduce((a, b) => a + b, 0);
  const powered = new Uint8Array(n);
  let demand = 0;
  let served = 0;
  for (let k = 0; k < count; k++) {
    const i = order[k];
    const t = tiles[i];
    if (!consumes(t)) {
      powered[i] = 1;
      continue;
    }
    if (isPlant(t.type)) {
      powered[i] = 1;
      continue;
    }
    const use = powerUse(t);
    demand += use;
    const id = comp[i];
    if (pool[id] >= use) {
      pool[id] -= use;
      served += use;
      powered[i] = 1;
    }
  }
  // Consommateurs hors de portée : comptés à part (ce n'est pas un manque de production).
  let outOfRange = 0;
  for (let i = 0; i < n; i++) if (!reached[i] && consumes(tiles[i]) && !isPlant(tiles[i].type)) outOfRange += powerUse(tiles[i]);
  return { powered, supply: Math.round(supply), demand: Math.round(demand), served: Math.round(served), outOfRange: Math.round(outOfRange) };
}

/** Réseau électrique : 1 = tuile alimentée. */
export function computePowerGrid(tiles: Tile[], size: number, month = 3): Uint8Array {
  return computeGrid(tiles, size, month).powered;
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

/**
 * Applique courant puis eau à la carte. Les châteaux d'eau ne pompent que
 * s'ils sont alimentés en électricité ; au bord d'un lac, ils portent plus loin.
 * Seules les tuiles dont l'état change sont recréées : le renderer ne redessine
 * que les morceaux concernés.
 */
export function applyPower(tiles: Tile[], size: number, month = 3): Tile[] {
  const power = computePowerGrid(tiles, size, month);
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
