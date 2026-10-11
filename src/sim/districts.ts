import { isZone, type Tile } from '../engine/map';
import { JOBS_C, JOBS_I, RESIDENTS } from './constants';
import type { CityMaps, Coverage } from './simulation';

/**
 * Quartiers nommés : la carte est découpée en régions organiques (diagramme de
 * Voronoï sur des centres répartis en grille puis décalés, bords bruités).
 * Le découpage ne dépend que de la taille de la carte.
 */

const NAMES = [
  'Belle-Rive',
  'Les Tilleuls',
  'Vieux-Port',
  'Haut-Bois',
  'Saint-Martin',
  'Les Forges',
  'Champ-Fleuri',
  'La Pinède',
  'Montclair',
  'Les Moulins',
  'Rive-Sud',
  'Bellevue',
  'Les Halles',
  'Val-Joli',
  'Clos-Marin',
  'Le Faubourg',
  'Les Lilas',
  'Grand-Pré',
  'La Butte',
  'Port-Neuf',
  'Les Cèdres',
  'Mont-Vert',
  'Le Bourg',
  'Sainte-Claire',
  'Les Vignes',
];

export type District = { id: number; name: string; cx: number; cy: number; hue: number };
export type DistrictMap = { size: number; ids: Uint8Array; list: District[] };

const hash = (a: number, b: number) => {
  let h = Math.imul(a * 374761393 + b * 668265263, 2654435761) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) / 4294967296;
};

const cache = new Map<number, DistrictMap>();

export function districtMap(size: number): DistrictMap {
  const hit = cache.get(size);
  if (hit) return hit;
  const k = size >= 80 ? 4 : 3;
  const cell = size / k;
  const list: District[] = [];
  for (let j = 0; j < k; j++) {
    for (let i = 0; i < k; i++) {
      const id = j * k + i;
      list.push({
        id,
        name: NAMES[(id * 7) % NAMES.length],
        cx: Math.round((i + 0.25 + hash(i, j) * 0.5) * cell),
        cy: Math.round((j + 0.25 + hash(j + 17, i + 3) * 0.5) * cell),
        hue: (id * 137) % 360,
      });
    }
  }
  const ids = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Bords irréguliers : léger bruit ajouté aux distances.
      const nx = x + (hash(Math.floor(x / 3), Math.floor(y / 3)) - 0.5) * 3;
      const ny = y + (hash(Math.floor(y / 3) + 91, Math.floor(x / 3)) - 0.5) * 3;
      let best = 0;
      let bestD = Infinity;
      for (const d of list) {
        const dd = (d.cx - nx) ** 2 + (d.cy - ny) ** 2;
        if (dd < bestD) {
          bestD = dd;
          best = d.id;
        }
      }
      ids[y * size + x] = best;
    }
  }
  const map = { size, ids, list };
  cache.set(size, map);
  return map;
}

export const districtAt = (size: number, x: number, y: number) => districtMap(size).list[districtMap(size).ids[y * size + x]];

/** Satisfaction locale d'une tuile habitée ou commerçante (0-100), ou -1. */
export function localHappiness(t: Tile, i: number, maps: CityMaps, cov: Coverage): number {
  if (!isZone(t.type) || t.type === 'I' || t.density === 0) return -1;
  const v =
    48 +
    (Math.max(0, t.value) - 50) * 0.45 -
    maps.crime[i] * 40 -
    maps.pollution[i] * 0.7 -
    Math.max(0, maps.traffic[i] - 1) * 6 +
    cov.HOSPITAL[i] * 8 +
    cov.SCHOOL[i] * 8 +
    cov.PARK[i] * 6 +
    cov.POLICE[i] * 4 -
    t.garbage * 3 -
    (t.powered ? 0 : 15) -
    (t.water ? 0 : 8);
  return Math.round(Math.max(0, Math.min(100, v)));
}

export type DistrictStats = District & {
  population: number;
  jobs: number;
  happiness: number;
  crime: number;
  pollution: number;
  value: number;
  built: number;
  /** Centre de gravité des bâtiments (pour centrer la caméra). */
  fx: number;
  fy: number;
};

/** Statistiques par quartier (seuls les quartiers habités ou bâtis sont renvoyés). */
export function computeDistrictStats(tiles: Tile[], size: number, maps: CityMaps, cov: Coverage): DistrictStats[] {
  const dm = districtMap(size);
  const acc = dm.list.map((d) => ({ ...d, population: 0, jobs: 0, happiness: 0, crime: 0, pollution: 0, value: 0, built: 0, fx: 0, fy: 0, hN: 0, cN: 0 }));
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (!isZone(t.type) || t.density === 0) continue;
    const a = acc[dm.ids[i]];
    a.built++;
    a.fx += t.x;
    a.fy += t.y;
    a.value += Math.max(0, t.value);
    a.pollution += maps.pollution[i];
    if (t.type === 'R') a.population += RESIDENTS[t.density];
    else a.jobs += t.type === 'C' ? JOBS_C[t.density] : JOBS_I[t.density];
    if (t.type !== 'I') {
      a.crime += maps.crime[i] * 100;
      a.cN++;
      const h = localHappiness(t, i, maps, cov);
      if (h >= 0) {
        a.happiness += h;
        a.hN++;
      }
    }
  }
  return acc
    .filter((a) => a.built > 0)
    .map(({ hN, cN, ...a }) => ({
      ...a,
      happiness: hN ? Math.round(a.happiness / hN) : 50,
      crime: cN ? Math.round(a.crime / cN) : 0,
      pollution: Math.round(Math.min(100, (a.pollution / a.built) * 2)),
      value: Math.round(a.value / a.built),
      fx: Math.round(a.fx / a.built),
      fy: Math.round(a.fy / a.built),
    }))
    .sort((p, q) => q.population + q.jobs - (p.population + p.jobs));
}

/** « à » + nom de quartier : « aux Vignes », « au Faubourg », « à la Pinède », « à Bellevue ». */
export function aLieu(name: string): string {
  if (name.startsWith('Les ')) return `aux ${name.slice(4)}`;
  if (name.startsWith('Le ')) return `au ${name.slice(3)}`;
  if (name.startsWith('La ')) return `à la ${name.slice(3)}`;
  return `à ${name}`;
}

/** « de » + nom de quartier : « des Vignes », « du Faubourg », « de la Pinède », « de Bellevue ». */
export function deLieu(name: string): string {
  if (name.startsWith('Les ')) return `des ${name.slice(4)}`;
  if (name.startsWith('Le ')) return `du ${name.slice(3)}`;
  if (name.startsWith('La ')) return `de la ${name.slice(3)}`;
  return /^[AEIOUÉÈ]/.test(name) ? `d’${name}` : `de ${name}`;
}
