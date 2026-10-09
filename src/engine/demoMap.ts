import { createEmptyMap, tileIndex, type Tile, type TileType } from './map';

/**
 * Petite ville de démonstration générée de façon déterministe, pour juger le
 * rendu et la simulation (accessible depuis le menu ⚙︎).
 */
export function createDemoMap(size: number): Tile[] {
  const tiles = createEmptyMap(size);
  const set = (x: number, y: number, type: TileType, density = 0) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const t = tiles[tileIndex(x, y, size)];
    t.type = type;
    t.density = density;
  };
  const get = (x: number, y: number) => tiles[tileIndex(x, y, size)];
  const rand = (x: number, y: number) => {
    const h = Math.imul((x * 73856093) ^ (y * 19349663), 2654435761) >>> 0;
    return (h % 1000) / 1000;
  };

  // Réseau routier : 3 avenues horizontales, 4 verticales.
  for (const y of [12, 20, 28]) for (let x = 8; x <= 42; x++) set(x, y, 'ROAD');
  for (const x of [8, 18, 28, 38]) for (let y = 8; y <= 36; y++) set(x, y, 'ROAD');

  // Quartiers (bornes inclusives).
  const districts: { x0: number; x1: number; y0: number; y1: number; type: TileType; dense: number }[] = [
    { x0: 19, x1: 27, y0: 21, y1: 27, type: 'C', dense: 0.9 }, // centre-ville
    { x0: 19, x1: 27, y0: 13, y1: 19, type: 'R', dense: 0.75 },
    { x0: 9, x1: 17, y0: 13, y1: 19, type: 'R', dense: 0.4 },
    { x0: 9, x1: 17, y0: 21, y1: 27, type: 'R', dense: 0.55 },
    { x0: 29, x1: 37, y0: 13, y1: 19, type: 'C', dense: 0.5 },
    { x0: 29, x1: 37, y0: 21, y1: 27, type: 'R', dense: 0.6 },
    { x0: 9, x1: 27, y0: 29, y1: 35, type: 'I', dense: 0.5 },
    { x0: 29, x1: 37, y0: 29, y1: 35, type: 'R', dense: 0.3 },
  ];

  for (const d of districts) {
    for (let y = d.y0; y <= d.y1; y++) {
      for (let x = d.x0; x <= d.x1; x++) {
        if (get(x, y).type === 'ROAD') continue;
        const r = rand(x, y);
        // Un parc de temps en temps : on laisse l'herbe.
        if (r > 0.93) continue;
        const roll = rand(y, x);
        // Plus on s'approche du centre-ville, plus les immeubles montent.
        const urban = Math.max(0, 1 - Math.hypot(x - 23, y - 24) / 16);
        const score = urban * d.dense + rand(x + 101, y + 7) * 0.35;
        const density = roll < 0.1 ? 0 : score > 0.75 ? 3 : score > 0.42 ? 2 : 1;
        set(x, y, d.type, density);
      }
    }
  }

  // Centrales électriques (portée 15 tuiles) reliées au réseau par des routes.
  for (let y = 5; y <= 9; y++) for (let x = 39; x <= 44; x++) if (get(x, y).type === 'GRASS') set(x, y, 'DIRT');
  for (let x = 39; x <= 44; x++) set(x, 10, 'ROAD');
  set(40, 9, 'ROAD');
  set(42, 9, 'ROAD');
  set(40, 8, 'POWER');
  set(42, 8, 'POWER');
  for (let x = 8; x <= 28; x++) set(x, 36, 'ROAD');
  set(12, 37, 'POWER');
  set(22, 37, 'POWER');
  set(7, 15, 'POWER');
  set(28, 9, 'POWER');
  set(39, 22, 'POWER');
  set(39, 32, 'POWER');
  set(24, 24, 'POWER');

  // Quelques parcelles de terre battue en périphérie.
  for (let y = 38; y <= 41; y++) for (let x = 12; x <= 16; x++) if (rand(x, y) > 0.35) set(x, y, 'DIRT');

  return tiles;
}
