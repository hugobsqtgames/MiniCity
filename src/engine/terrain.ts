import { createEmptyMap, MAX_ELEV, type Tile } from './map';

/** Générateur pseudo-aléatoire déterministe. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bruit de valeur lissé (fractal, 3 octaves) dans [0, 1]. */
function makeNoise(seed: number) {
  const hash = (x: number, y: number) => {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const value = (x: number, y: number) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = smooth(x - x0);
    const fy = smooth(y - y0);
    const a = hash(x0, y0);
    const b = hash(x0 + 1, y0);
    const c = hash(x0, y0 + 1);
    const d = hash(x0 + 1, y0 + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  return (x: number, y: number) => (value(x, y) * 0.55 + value(x * 2.1, y * 2.1) * 0.3 + value(x * 4.3, y * 4.3) * 0.15);
}

/**
 * Carte naturelle : une rivière qui serpente d'un bord à l'autre, des lacs, des
 * plages sur les rives et des forêts. Le centre reste dégagé pour bien démarrer.
 */
export function createTerrainMap(size: number, seed = Date.now() % 100000): Tile[] {
  const tiles = createEmptyMap(size);
  const rand = mulberry32(seed);
  const water = makeNoise(seed + 11);
  const woods = makeNoise(seed + 29);
  const cx = size / 2;
  const cy = size / 2;
  const clear = Math.max(6, size * 0.12);
  const at = (x: number, y: number) => tiles[y * size + x];
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < size && y < size;

  // Lacs : zones de bruit élevé, hors du centre.
  const scale = 7 / size;
  for (const t of tiles) {
    if (Math.hypot(t.x - cx, t.y - cy) < clear + 4) continue;
    if (water(t.x * scale, t.y * scale) > 0.7) t.type = 'LAKE';
  }

  // Rivière : marche vers le bord opposé avec des méandres, largeur 2 à 3.
  const fromLeft = rand() < 0.5;
  let pos = size * (rand() < 0.5 ? 0.22 + rand() * 0.12 : 0.66 + rand() * 0.12);
  const wiggle = rand() * 10;
  for (let s = 0; s < size; s++) {
    pos += Math.sin(s / 6 + wiggle) * 0.7 + (rand() - 0.5) * 0.6;
    pos = Math.max(2, Math.min(size - 3, pos));
    const width = 2 + (Math.sin(s / 9 + wiggle * 2) > 0.4 ? 1 : 0);
    for (let w = 0; w < width; w++) {
      const a = Math.round(pos) + w;
      const [x, y] = fromLeft ? [s, a] : [a, s];
      if (inside(x, y)) at(x, y).type = 'LAKE';
    }
  }

  // Plages : terre en contact avec l'eau.
  for (const t of tiles) {
    if (t.type === 'LAKE') continue;
    let shore = 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = t.x + dx;
      const ny = t.y + dy;
      if (inside(nx, ny) && at(nx, ny).type === 'LAKE') shore++;
    }
    if (shore > 0 && rand() < 0.75) t.type = 'SAND';
  }

  // Relief : collines et montagnes (paliers de 0 à 3), jamais au bord de l'eau ni au centre.
  const hills = makeNoise(seed + 53);
  const hscale = 6 / size;
  const distWater = waterDistance(tiles, size);
  for (const t of tiles) {
    if (t.type === 'LAKE' || t.type === 'SAND') continue;
    const center = Math.hypot(t.x - cx, t.y - cy);
    const h = hills(t.x * hscale + 7, t.y * hscale + 3);
    // Plus on s'éloigne du centre et de l'eau, plus le relief peut monter.
    const room = Math.min(1, Math.max(0, (center - clear) / 10)) * Math.min(1, Math.max(0, (distWater[t.y * size + t.x] - 1) / 4));
    t.elev = Math.max(0, Math.min(MAX_ELEV, Math.floor((h - 0.4) * 13 * room)));
  }
  // Pas de falaise de plus d'un niveau entre deux tuiles voisines (relief en terrasses douces).
  for (let pass = 0; pass < 3; pass++) {
    for (const t of tiles) {
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = t.x + dx;
        const ny = t.y + dy;
        if (inside(nx, ny) && t.elev > at(nx, ny).elev + 1) t.elev = at(nx, ny).elev + 1;
      }
    }
  }

  // Forêts : massifs de bruit élevé, hors du centre et des plages (plus denses en altitude).
  const wscale = 9 / size;
  for (const t of tiles) {
    if (t.type !== 'GRASS' || Math.hypot(t.x - cx, t.y - cy) < clear) continue;
    if (woods(t.x * wscale + 40, t.y * wscale + 40) > 0.62 - t.elev * 0.06) t.type = 'FOREST';
  }
  return tiles;
}

/** Distance (en tuiles, 4-connexité) de chaque tuile à l'eau la plus proche. */
function waterDistance(tiles: Tile[], size: number): Int16Array {
  const dist = new Int16Array(tiles.length).fill(32767);
  const queue: number[] = [];
  tiles.forEach((t, i) => {
    if (t.type === 'LAKE') {
      dist[i] = 0;
      queue.push(i);
    }
  });
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h];
    const x = i % size;
    for (const n of [x + 1 < size ? i + 1 : -1, x > 0 ? i - 1 : -1, i + size < tiles.length ? i + size : -1, i - size]) {
      if (n < 0 || dist[n] <= dist[i] + 1) continue;
      dist[n] = dist[i] + 1;
      queue.push(n);
    }
  }
  return dist;
}
