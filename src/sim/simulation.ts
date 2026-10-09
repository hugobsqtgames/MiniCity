import type { Tile } from '../engine/map';
import {
  DEFAULT_TAX,
  INCOME_PER_CITIZEN,
  JOBS_C,
  JOBS_I,
  RESIDENTS,
  ROAD_ACCESS_RANGE,
  UPKEEP,
} from './constants';
import { applyPower } from './power';

export type Demand = { r: number; c: number; i: number };

export type CityStats = {
  population: number;
  jobsC: number;
  jobsI: number;
  roads: number;
  plants: number;
  poweredZones: number;
  zones: number;
};

export type SimInput = {
  tiles: Tile[];
  size: number;
  treasury: number;
  taxRate: number;
  demand: Demand;
  /** Générateur aléatoire injectable (tests déterministes). */
  random?: () => number;
};

export type SimOutput = {
  tiles: Tile[];
  treasury: number;
  demand: Demand;
  stats: CityStats;
  income: number;
  expenses: number;
};

/** Nombre maximal de bâtiments qui évoluent par mois : la ville pousse progressivement. */
const MAX_CHANGES_PER_TICK = 40;

const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));

export function computeStats(tiles: Tile[]): CityStats {
  const s: CityStats = { population: 0, jobsC: 0, jobsI: 0, roads: 0, plants: 0, poweredZones: 0, zones: 0 };
  for (const t of tiles) {
    switch (t.type) {
      case 'R':
        s.population += RESIDENTS[t.density];
        break;
      case 'C':
        s.jobsC += JOBS_C[t.density];
        break;
      case 'I':
        s.jobsI += JOBS_I[t.density];
        break;
      case 'ROAD':
        s.roads++;
        break;
      case 'POWER':
        s.plants++;
        break;
    }
    if (t.type === 'R' || t.type === 'C' || t.type === 'I') {
      s.zones++;
      if (t.powered) s.poweredZones++;
    }
  }
  return s;
}

/**
 * Demande RCI (entre -1 et 1) :
 *  - R monte quand il y a des emplois (C + I) disponibles ;
 *  - C monte quand la population est élevée ;
 *  - I monte avec la main-d'œuvre disponible.
 * Des impôts élevés font fuir tout le monde.
 */
export function computeDemand(stats: CityStats, taxRate: number): Demand {
  const jobs = stats.jobsC + stats.jobsI;
  const workforce = stats.population * 0.6;
  const taxPenalty = (taxRate - DEFAULT_TAX) * 0.05;
  return {
    r: clamp((jobs - workforce + 60) / (workforce * 0.5 + 80) - taxPenalty),
    c: clamp((stats.population * 0.22 - stats.jobsC + 10) / (stats.jobsC * 0.5 + 40) - taxPenalty * 0.6),
    i: clamp((stats.population * 0.38 - stats.jobsI + 40) / (stats.jobsI * 0.5 + 50) - taxPenalty * 0.6),
  };
}

/** Accès routier : BFS multi-sources depuis toutes les routes (distance Manhattan ≤ ROAD_ACCESS_RANGE). */
export function computeRoadAccess(tiles: Tile[], size: number): Uint8Array {
  const dist = new Int8Array(size * size).fill(-1);
  const queue = new Int32Array(size * size);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i].type === 'ROAD') {
      dist[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    if (dist[i] >= ROAD_ACCESS_RANGE) continue;
    const x = i % size;
    const y = (i - x) / size;
    for (const n of [x + 1 < size ? i + 1 : -1, x > 0 ? i - 1 : -1, y + 1 < size ? i + size : -1, y > 0 ? i - size : -1]) {
      if (n < 0 || dist[n] !== -1) continue;
      dist[n] = dist[i] + 1;
      queue[tail++] = n;
    }
  }
  const access = new Uint8Array(size * size);
  for (let i = 0; i < access.length; i++) access[i] = dist[i] >= 0 ? 1 : 0;
  return access;
}

/** Pollution émise par l'industrie et les centrales, diffusée avec atténuation. */
export function computePollution(tiles: Tile[], size: number): Float32Array {
  const pollution = new Float32Array(size * size);
  for (const t of tiles) {
    const strength = t.type === 'I' ? 7 * Math.max(1, t.density) : t.type === 'POWER' ? 22 : 0;
    if (strength === 0) continue;
    const radius = t.type === 'POWER' ? 6 : 5;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = t.x + dx;
        const y = t.y + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.hypot(dx, dy);
        if (d > radius) continue;
        pollution[y * size + x] += strength * (1 - d / (radius + 1));
      }
    }
  }
  return pollution;
}

/** Valeur foncière / attractivité d'une tuile (0-100). */
function landValue(tiles: Tile[], size: number, t: Tile, hasRoad: boolean, pollution: number): number {
  let parks = 0;
  let shops = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = t.x + dx;
      const y = t.y + dy;
      if (x < 0 || y < 0 || x >= size || y >= size || (dx === 0 && dy === 0)) continue;
      const n = tiles[y * size + x];
      if (n.type === 'GRASS') parks++;
      else if (n.type === 'C' && n.density > 0) shops++;
    }
  }
  let v = 35 + (hasRoad ? 10 : 0) + (t.powered ? 15 : 0) + Math.min(15, parks * 1.5) + Math.min(10, shops * 2);
  if (t.type !== 'I') v -= pollution;
  return Math.round(clamp(v, 0, 100));
}

function maxDensity(t: Tile, value: number, population: number): number {
  switch (t.type) {
    case 'R':
      return value >= 62 ? 3 : value >= 40 ? 2 : 1;
    case 'C':
      return value >= 55 && population > 800 ? 3 : value >= 35 && population > 150 ? 2 : 1;
    case 'I':
      return population > 1200 ? 3 : population > 250 ? 2 : 1;
    default:
      return 0;
  }
}

/** Un mois de simulation. Fonction pure : renvoie le nouvel état sans muter l'entrée. */
export function simulateMonth(input: SimInput): SimOutput {
  const { size, taxRate } = input;
  const random = input.random ?? Math.random;

  // 1. Électricité (au cas où la carte aurait changé depuis le dernier tick).
  let tiles = applyPower(input.tiles, size);

  // 2. Demande RCI, lissée pour éviter que les jauges ne sautent.
  const before = computeStats(tiles);
  const target = computeDemand(before, taxRate);
  const demand: Demand = {
    r: input.demand.r * 0.5 + target.r * 0.5,
    c: input.demand.c * 0.5 + target.c * 0.5,
    i: input.demand.i * 0.5 + target.i * 0.5,
  };

  // 3. Évolution des zones (parcours à partir d'un point aléatoire pour ne pas favoriser le coin haut).
  const road = computeRoadAccess(tiles, size);
  const pollution = computePollution(tiles, size);
  const out = tiles.slice();
  let changed = false;
  let changes = 0;
  const n = tiles.length;
  const start = Math.floor(random() * n);

  for (let k = 0; k < n; k++) {
    const idx = (start + k) % n;
    const t = out[idx];
    if (t.type !== 'R' && t.type !== 'C' && t.type !== 'I') continue;

    const hasRoad = road[idx] === 1;
    const value = landValue(out, size, t, hasRoad, pollution[idx]);
    let density = t.density;

    if (changes < MAX_CHANGES_PER_TICK) {
      const d = t.type === 'R' ? demand.r : t.type === 'C' ? demand.c : demand.i;
      const canGrow = hasRoad && t.powered;
      if (canGrow && d > 0 && density < maxDensity(t, value, before.population)) {
        if (random() < d * 0.18 * (0.5 + value / 100)) density++;
      } else if (density > 0 && !canGrow) {
        if (random() < 0.05) density--; // abandon faute de courant ou de route
      } else if (density > 0 && d < -0.25) {
        if (random() < -d * 0.04) density--; // déclin si la demande s'effondre
      }
    }

    if (density !== t.density || value !== t.value) {
      if (density !== t.density) changes++;
      out[idx] = { ...t, density, value };
      changed = true;
    }
  }
  if (changed) tiles = out;

  // 4. Budget : Trésorerie += Population × Taux − Entretien (routes + centrales).
  const stats = computeStats(tiles);
  const income = Math.round(stats.population * (taxRate / 100) * INCOME_PER_CITIZEN);
  const expenses = stats.roads * UPKEEP.ROAD + stats.plants * UPKEEP.POWER;

  return { tiles, demand, stats, income, expenses, treasury: input.treasury + income - expenses };
}
