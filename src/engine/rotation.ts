import type { Tile } from './map';

/**
 * Rotation de la vue par quarts de tour (comme dans SimCity 2000).
 * La simulation travaille toujours en coordonnées d'origine ; seul l'affichage
 * utilise des coordonnées "vue". Une rotation d'un quart de tour (r = 1) envoie
 * la tuile (x, y) en (N - 1 - y, x).
 */

/** Tuile d'origine -> tuile vue. */
export function toView(x: number, y: number, size: number, r: number): [number, number] {
  'worklet';
  let a = x;
  let b = y;
  for (let k = 0; k < ((r % 4) + 4) % 4; k++) {
    const nx = size - 1 - b;
    b = a;
    a = nx;
  }
  return [a, b];
}

/** Tuile vue -> tuile d'origine. */
export function fromView(x: number, y: number, size: number, r: number): [number, number] {
  'worklet';
  return toView(x, y, size, 4 - (((r % 4) + 4) % 4));
}

/** Point continu de la grille (centre de tuile = x + 0.5) d'origine -> vue. */
export function pointToView(gx: number, gy: number, size: number, r: number): [number, number] {
  'worklet';
  let a = gx;
  let b = gy;
  for (let k = 0; k < ((r % 4) + 4) % 4; k++) {
    const nx = size - b;
    b = a;
    a = nx;
  }
  return [a, b];
}

/** Point continu vue -> origine. */
export function pointFromView(gx: number, gy: number, size: number, r: number): [number, number] {
  'worklet';
  return pointToView(gx, gy, size, 4 - (((r % 4) + 4) % 4));
}

/** Vecteur (direction) d'origine -> vue. */
export function vectorToView(ux: number, uy: number, r: number): [number, number] {
  'worklet';
  let a = ux;
  let b = uy;
  for (let k = 0; k < ((r % 4) + 4) % 4; k++) {
    const nx = -b;
    b = a;
    a = nx;
  }
  return [a, b];
}

/**
 * Carte tournée pour l'affichage. Les tuiles tournées sont mises en cache par
 * objet d'origine : une modification ne recrée que les tuiles concernées, ce qui
 * garde le rendu incrémental par blocs.
 */
export class RotatedTiles {
  private caches: WeakMap<Tile, Tile>[] = [new WeakMap(), new WeakMap(), new WeakMap(), new WeakMap()];

  get(tiles: Tile[], size: number, r: number): Tile[] {
    const rot = ((r % 4) + 4) % 4;
    if (rot === 0) return tiles;
    const cache = this.caches[rot];
    const out: Tile[] = new Array(tiles.length);
    for (const t of tiles) {
      let v = cache.get(t);
      if (!v) {
        const [x, y] = toView(t.x, t.y, size, rot);
        v = { ...t, x, y };
        cache.set(t, v);
      }
      out[v.y * size + v.x] = v;
    }
    return out;
  }
}

/** Réindexe un tableau de valeurs par tuile (ordre d'origine) dans l'ordre de la vue. */
export function remapToView(values: Float32Array, size: number, r: number): Float32Array {
  const rot = ((r % 4) + 4) % 4;
  if (rot === 0) return values;
  const out = new Float32Array(values.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [vx, vy] = toView(x, y, size, rot);
      out[vy * size + vx] = values[y * size + x];
    }
  }
  return out;
}
