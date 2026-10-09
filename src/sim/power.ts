import type { Tile, TileType } from '../engine/map';
import { POWER_RANGE } from './constants';

/** Tuiles qui transportent le courant : les lignes suivent les routes et les zones contiguës. */
const CONDUCTS: Record<TileType, boolean> = {
  GRASS: false,
  DIRT: false,
  ROAD: true,
  R: true,
  C: true,
  I: true,
  POWER: true,
};

/**
 * Flood fill (BFS multi-sources) : part de chaque centrale et propage
 * `powered = true` de proche en proche, jusqu'à POWER_RANGE tuiles.
 */
export function computePowerGrid(tiles: Tile[], size: number): Uint8Array {
  const powered = new Uint8Array(size * size);
  const dist = new Int16Array(size * size).fill(-1);
  const queue = new Int32Array(size * size);
  let head = 0;
  let tail = 0;

  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i].type === 'POWER') {
      dist[i] = 0;
      powered[i] = 1;
      queue[tail++] = i;
    }
  }

  while (head < tail) {
    const i = queue[head++];
    if (dist[i] >= POWER_RANGE) continue;
    const x = i % size;
    const y = (i - x) / size;
    const neighbours = [
      x + 1 < size ? i + 1 : -1,
      x > 0 ? i - 1 : -1,
      y + 1 < size ? i + size : -1,
      y > 0 ? i - size : -1,
    ];
    for (const n of neighbours) {
      if (n < 0 || dist[n] !== -1 || !CONDUCTS[tiles[n].type]) continue;
      dist[n] = dist[i] + 1;
      powered[n] = 1;
      queue[tail++] = n;
    }
  }
  return powered;
}

/**
 * Applique le réseau électrique à la carte. Seules les tuiles dont l'état change
 * sont recréées : le renderer ne redessine que les morceaux de carte concernés.
 */
export function applyPower(tiles: Tile[], size: number): Tile[] {
  const grid = computePowerGrid(tiles, size);
  let out: Tile[] | null = null;
  for (let i = 0; i < tiles.length; i++) {
    const p = grid[i] === 1 && tiles[i].type !== 'ROAD' && tiles[i].type !== 'GRASS' && tiles[i].type !== 'DIRT';
    if (tiles[i].powered !== p) {
      out ??= tiles.slice();
      out[i] = { ...tiles[i], powered: p };
    }
  }
  return out ?? tiles;
}
