import { isService, isZone, type Tile } from '../engine/map';
import { POWER_RANGE, WATER_RANGE } from './constants';

/** Les réseaux (courant et canalisations) suivent les routes, les zones et les bâtiments contigus. */
const conducts = (t: Tile) => t.type === 'ROAD' || t.type === 'POWER' || isZone(t.type) || isService(t.type);
const consumes = (t: Tile) => t.type === 'POWER' || isZone(t.type) || isService(t.type);

/**
 * Flood fill (BFS multi-sources) : part de chaque source et propage de proche
 * en proche à travers les tuiles conductrices, jusqu'à `range` tuiles.
 */
export function floodNetwork(tiles: Tile[], size: number, isSource: (t: Tile) => boolean, range: number): Uint8Array {
  const reached = new Uint8Array(size * size);
  const dist = new Int16Array(size * size).fill(-1);
  const queue = new Int32Array(size * size);
  let head = 0;
  let tail = 0;

  for (let i = 0; i < tiles.length; i++) {
    if (isSource(tiles[i])) {
      dist[i] = 0;
      reached[i] = 1;
      queue[tail++] = i;
    }
  }

  while (head < tail) {
    const i = queue[head++];
    if (dist[i] >= range) continue;
    const x = i % size;
    const y = (i - x) / size;
    const neighbours = [
      x + 1 < size ? i + 1 : -1,
      x > 0 ? i - 1 : -1,
      y + 1 < size ? i + size : -1,
      y > 0 ? i - size : -1,
    ];
    for (const n of neighbours) {
      if (n < 0 || dist[n] !== -1 || !conducts(tiles[n])) continue;
      dist[n] = dist[i] + 1;
      reached[n] = 1;
      queue[tail++] = n;
    }
  }
  return reached;
}

/** Réseau électrique : part de chaque centrale (portée POWER_RANGE). */
export function computePowerGrid(tiles: Tile[], size: number): Uint8Array {
  return floodNetwork(tiles, size, (t) => t.type === 'POWER', POWER_RANGE);
}

/**
 * Applique courant puis eau à la carte. Les châteaux d'eau ne pompent que
 * s'ils sont alimentés en électricité. Seules les tuiles dont l'état change
 * sont recréées : le renderer ne redessine que les morceaux concernés.
 */
export function applyPower(tiles: Tile[], size: number): Tile[] {
  const power = computePowerGrid(tiles, size);
  const water = floodNetwork(tiles, size, (t) => t.type === 'WATER' && power[t.y * size + t.x] === 1, WATER_RANGE);
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
