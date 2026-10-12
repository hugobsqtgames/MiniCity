/**
 * Outils de tests aléatoires (fuzz) : génération de villes au hasard et
 * vérification des invariants de la carte, des statistiques et de la sauvegarde.
 * Utilisé par fuzz.test.ts (quelques centaines de cas) et par les campagnes
 * longues lancées à la main (des milliers de cas).
 */
import {
  createEmptyMap,
  isRoadType,
  isZone,
  MAX_ELEV,
  MONUMENT_TYPES,
  PLANT_TYPES,
  ROAD_TYPES,
  SERVICE_TYPES,
  LOGISTICS_TYPES,
  TOURISM_TYPES,
  VENUE_TYPES,
  type Tile,
  type TileType,
} from '../engine/map';
import { createTerrainMap, mulberry32 } from '../engine/terrain';
import { TOOLS, type ToolId } from '../sim/constants';
import type { CityStats } from '../sim/simulation';

export const ALL_TYPES: TileType[] = [
  'GRASS',
  'DIRT',
  'LAKE',
  'SAND',
  'FOREST',
  'R',
  'C',
  'I',
  'RAIL',
  ...ROAD_TYPES,
  ...SERVICE_TYPES,
  ...MONUMENT_TYPES,
  ...VENUE_TYPES,
  ...PLANT_TYPES,
  ...LOGISTICS_TYPES,
  ...TOURISM_TYPES,
];
export const ALL_TOOLS: ToolId[] = TOOLS.map((t) => t.id);

export type Rand = () => number;
export const pick = <T,>(r: Rand, list: readonly T[]): T => list[Math.floor(r() * list.length)];
export const int = (r: Rand, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

/** Carte « chaos » : n'importe quel type n'importe où, attributs au hasard (dans leurs bornes). */
export function chaosMap(r: Rand, size: number): Tile[] {
  const tiles = createEmptyMap(size);
  for (const t of tiles) {
    const type = pick(r, ALL_TYPES);
    t.type = type;
    t.density = isZone(type) ? int(r, 0, 3) : 0;
    t.fire = r() < 0.05 ? int(r, 1, 3) : 0;
    t.garbage = int(r, 0, 9);
    t.flood = r() < 0.05 ? int(r, 1, 5) : 0;
    t.rad = r() < 0.03 ? int(r, 1, 9) : 0;
    t.elev = type === 'LAKE' ? 0 : int(r, 0, MAX_ELEV);
    t.line = isRoadType(type) && type !== 'HIGHWAY' ? int(r, 0, type === 'AVENUE' ? 3 : 2) & (type === 'AVENUE' ? 3 : 2) : 0;
    t.spec = type === 'I' && t.density > 0 ? int(r, 0, 3) : 0;
    t.lake = (isRoadType(type) && r() < 0.05) || (type === 'LAKE' && r() < 0.2);
    if (t.lake) t.elev = 0;
    t.value = r() < 0.05 ? -1 : int(r, 0, 100);
  }
  return tiles;
}

/** Ville « réaliste » : terrain naturel puis des centaines d'outils appliqués au hasard. */
export function builtMap(r: Rand, size: number, ops: number, apply: (tiles: Tile[], tool: ToolId, x: number, y: number) => Tile[] | null): Tile[] {
  let tiles = createTerrainMap(size, Math.floor(r() * 1e6));
  for (let k = 0; k < ops; k++) {
    const tool = pick(r, ALL_TOOLS);
    const x = int(r, 0, size - 1);
    const y = int(r, 0, size - 1);
    // Des lignes de routes de temps en temps, sinon la ville ne pousse pas.
    if (r() < 0.25) {
      const len = int(r, 3, 12);
      const horiz = r() < 0.5;
      const road = pick(r, ['road', 'road', 'avenue', 'rail', 'tram'] as ToolId[]);
      for (let s = 0; s < len; s++) {
        const nx = horiz ? Math.min(size - 1, x + s) : x;
        const ny = horiz ? y : Math.min(size - 1, y + s);
        tiles = apply(tiles, road, nx, ny) ?? tiles;
      }
      continue;
    }
    tiles = apply(tiles, tool, x, y) ?? tiles;
  }
  return tiles;
}

/** Vérifie les invariants d'une carte ; renvoie la liste des problèmes (vide = OK). */
export function tileProblems(tiles: Tile[], size: number): string[] {
  const out: string[] = [];
  if (tiles.length !== size * size) return [`taille ${tiles.length} ≠ ${size * size}`];
  const types = new Set(ALL_TYPES);
  for (let i = 0; i < tiles.length && out.length < 8; i++) {
    const t = tiles[i];
    const where = `(${i % size},${Math.floor(i / size)}) ${t.type}`;
    if (t.x !== i % size || t.y !== Math.floor(i / size)) out.push(`${where} : coordonnées ${t.x},${t.y}`);
    if (!types.has(t.type)) out.push(`${where} : type inconnu`);
    const ints: [keyof Tile, number, number][] = [
      ['density', 0, 3],
      ['fire', 0, 9],
      ['garbage', 0, 9],
      ['flood', 0, 9],
      ['rad', 0, 9],
      ['elev', 0, MAX_ELEV],
      ['line', 0, 3],
      ['spec', 0, 3],
    ];
    for (const [k, lo, hi] of ints) {
      const v = t[k] as number;
      if (!Number.isInteger(v) || v < lo || v > hi) out.push(`${where} : ${k}=${v}`);
    }
    if (!Number.isFinite(t.value)) out.push(`${where} : valeur ${t.value}`);
    if (t.density > 0 && !isZone(t.type)) out.push(`${where} : densité ${t.density} hors zone`);
    if (t.line && !isRoadType(t.type)) out.push(`${where} : ligne ${t.line} hors route`);
    if (t.line & 1 && t.type !== 'AVENUE') out.push(`${where} : tram hors avenue`);
    if (t.line & 2 && t.type === 'HIGHWAY') out.push(`${where} : passage à niveau sur autoroute`);
    if (t.spec && t.type !== 'I') out.push(`${where} : spécialité hors industrie`);
    if (t.lake && t.type !== 'LAKE' && !isRoadType(t.type)) out.push(`${where} : lac sous un bâtiment`);
    if ((t.type === 'LAKE' || t.lake) && t.elev !== 0) out.push(`${where} : eau en altitude`);
    if (typeof t.powered !== 'boolean' || typeof t.water !== 'boolean') out.push(`${where} : réseaux non booléens`);
  }
  return out;
}

/** Vérifie que toutes les statistiques sont des nombres finis et bornés. */
export function statsProblems(s: CityStats): string[] {
  const out: string[] = [];
  const walk = (o: unknown, path: string) => {
    if (typeof o === 'number') {
      if (!Number.isFinite(o)) out.push(`${path} = ${o}`);
    } else if (Array.isArray(o)) o.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
  };
  walk(s, 'stats');
  const pct: (keyof CityStats)[] = ['happiness', 'crime', 'pollution', 'garbage', 'unemployment', 'educationLevel', 'waterPollution', 'epidemic'];
  for (const k of pct) {
    const v = s[k] as number;
    if (v < 0 || v > 100) out.push(`${k} hors 0-100 : ${v}`);
  }
  for (const [k, v] of Object.entries(s.coverage)) if (v < 0 || v > 100) out.push(`coverage.${k} = ${v}`);
  if (s.population < 0 || s.jobsC < 0 || s.jobsI < 0) out.push('population ou emplois négatifs');
  if (s.employed > s.workforce) out.push(`employés ${s.employed} > actifs ${s.workforce}`);
  if (s.hotelGuests > s.tourists) out.push('plus de clients d’hôtel que de touristes');
  if (s.specJobs.reduce((a, b) => a + b, 0) !== s.jobsI) out.push(`emplois spécialisés ${s.specJobs} ≠ ${s.jobsI}`);
  if (s.power.served > s.power.demand + 0.01 || s.power.served > s.power.supply + 0.01) out.push(`électricité servie ${s.power.served} incohérente`);
  return out;
}

export const rng = (seed: number) => mulberry32(seed);
