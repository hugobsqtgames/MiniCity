import { isZone, SERVICE_TYPES, type ServiceType, type Tile } from '../engine/map';
import {
  DEFAULT_TAX,
  INCOME_PER_CITIZEN,
  JOBS_C,
  JOBS_I,
  RESIDENTS,
  ROAD_ACCESS_RANGE,
  SERVICE_RADIUS,
  UPKEEP,
  WORKFORCE_RATIO,
} from './constants';
import { applyPower } from './power';

export type Demand = { r: number; c: number; i: number };

export type Coverage = Record<ServiceType, Float32Array>;

export type CityStats = {
  population: number;
  workforce: number;
  jobsC: number;
  jobsI: number;
  employed: number;
  /** Chômage en % de la population active. */
  unemployment: number;
  roads: number;
  plants: number;
  zones: number;
  poweredZones: number;
  wateredZones: number;
  /** Satisfaction des habitants (0-100). */
  happiness: number;
  /** Criminalité moyenne des quartiers (0-100). */
  crime: number;
  /** Part des bâtiments couverts par chaque service (0-100). */
  coverage: { police: number; fire: number; health: number; education: number; metro: number };
  fires: number;
  metroRiders: number;
  services: number;
};

export type SimEvents = { newFires: number; destroyed: number; extinguished: number };

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
  events: SimEvents;
};

/** Nombre maximal de bâtiments qui évoluent par mois : la ville pousse progressivement. */
const MAX_CHANGES_PER_TICK = 40;
/** Un bâtiment qui brûle plus de 4 mois est détruit. */
const FIRE_DESTROY_MONTHS = 4;

const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));

/**
 * Couverture de chaque service : 1 au pied du bâtiment, décroissante jusqu'à
 * son rayon d'action. Un service sans électricité ne fonctionne pas (sauf les parcs).
 */
export function computeCoverage(tiles: Tile[], size: number): Coverage {
  const cov = Object.fromEntries(SERVICE_TYPES.map((s) => [s, new Float32Array(size * size)])) as Coverage;
  for (const t of tiles) {
    const type = t.type as ServiceType;
    const radius = SERVICE_RADIUS[type];
    if (!radius || (type !== 'PARK' && !t.powered)) continue;
    const map = cov[type];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = t.x + dx;
        const y = t.y + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.hypot(dx, dy);
        if (d > radius) continue;
        const v = 1 - (d / (radius + 1)) * 0.7;
        const i = y * size + x;
        if (v > map[i]) map[i] = v;
      }
    }
  }
  return cov;
}

export function computeStats(tiles: Tile[], size: number, taxRate = DEFAULT_TAX, precomputed?: Coverage): CityStats {
  const cov = precomputed ?? computeCoverage(tiles, size);
  let population = 0;
  let jobsC = 0;
  let jobsI = 0;
  let roads = 0;
  let plants = 0;
  let zones = 0;
  let poweredZones = 0;
  let wateredZones = 0;
  let fires = 0;
  let services = 0;
  let built = 0;
  let crimeSum = 0;
  let pollutionR = 0;
  const covSum = { police: 0, fire: 0, health: 0, education: 0, metro: 0 };
  let metroRiders = 0;

  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (t.fire > 0) fires++;
    if (t.type === 'ROAD') roads++;
    else if (t.type === 'POWER') plants++;
    else if (!isZone(t.type) && t.type !== 'GRASS' && t.type !== 'DIRT') services++;
    if (!isZone(t.type)) continue;
    zones++;
    if (t.powered) poweredZones++;
    if (t.water) wateredZones++;
    if (t.density === 0 || t.fire > 0) continue;

    built++;
    if (t.type === 'R') {
      const residents = RESIDENTS[t.density];
      population += residents;
      // Les habitants proches d'une station prennent le métro.
      metroRiders += Math.round(residents * 0.35 * cov.METRO[i]);
      pollutionR += pollutionAt(tiles, size, t);
    } else if (t.type === 'C') jobsC += JOBS_C[t.density];
    else jobsI += JOBS_I[t.density];

    covSum.police += cov.POLICE[i] > 0 ? 1 : 0;
    covSum.fire += cov.FIRE[i] > 0 ? 1 : 0;
    covSum.health += cov.HOSPITAL[i] > 0 ? 1 : 0;
    covSum.education += cov.SCHOOL[i] > 0 ? 1 : 0;
    covSum.metro += cov.METRO[i] > 0 ? 1 : 0;
    if (t.type !== 'I') crimeSum += crimeAt(t, cov.POLICE[i]);
  }

  // Une seule station ne forme pas de ligne : il en faut au moins deux.
  const stations = tiles.filter((t) => t.type === 'METRO' && t.powered).length;
  if (stations < 2) metroRiders = 0;

  const workforce = Math.round(population * WORKFORCE_RATIO);
  const employed = Math.min(workforce, jobsC + jobsI);
  const unemployment = workforce > 0 ? Math.round(((workforce - employed) / workforce) * 100) : 0;
  const pct = (n: number) => (built > 0 ? Math.round((n / built) * 100) : 0);
  const coverage = {
    police: pct(covSum.police),
    fire: pct(covSum.fire),
    health: pct(covSum.health),
    education: pct(covSum.education),
    metro: pct(covSum.metro),
  };
  const crime = built > 0 ? Math.round(crimeSum / built) : 0;
  const rTiles = tiles.filter((t) => t.type === 'R' && t.density > 0).length;
  const avgPollution = rTiles > 0 ? pollutionR / rTiles : 0;

  // Satisfaction : services, emploi, sécurité, environnement et impôts.
  const happiness = population === 0
    ? 50
    : Math.round(
        clamp(
          45 +
            coverage.police * 0.08 +
            coverage.fire * 0.06 +
            coverage.health * 0.1 +
            coverage.education * 0.1 +
            coverage.metro * 0.04 -
            crime * 0.3 -
            unemployment * 0.5 -
            avgPollution * 0.5 -
            (taxRate - DEFAULT_TAX) * 2.5 -
            fires * 3,
          0,
          100,
        ),
      );

  return {
    population,
    workforce,
    jobsC,
    jobsI,
    employed,
    unemployment,
    roads,
    plants,
    zones,
    poweredZones,
    wateredZones,
    happiness,
    crime,
    coverage,
    fires,
    metroRiders,
    services,
  };
}

/** Criminalité d'un quartier : densité, pauvreté (faible valeur foncière), moins la police. */
function crimeAt(t: Tile, police: number): number {
  return clamp(12 + t.density * 11 + (55 - t.value) * 0.45 - police * 45, 0, 100);
}

function pollutionAt(tiles: Tile[], size: number, t: Tile): number {
  let p = 0;
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = t.x + dx;
      const y = t.y + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const n = tiles[y * size + x];
      if (n.type === 'I' && n.density > 0) p += n.density * (1 - Math.hypot(dx, dy) / 6);
      else if (n.type === 'POWER') p += 4 * (1 - Math.hypot(dx, dy) / 6);
    }
  }
  return Math.max(0, p);
}

/**
 * Demande RCI (entre -1 et 1) :
 *  - R monte quand il y a des emplois (C + I) disponibles et que les habitants sont heureux ;
 *  - C monte quand la population est élevée ;
 *  - I monte avec la main-d'œuvre disponible.
 * Des impôts élevés font fuir tout le monde.
 */
export function computeDemand(stats: CityStats, taxRate: number): Demand {
  const jobs = stats.jobsC + stats.jobsI;
  const workforce = stats.workforce;
  const taxPenalty = (taxRate - DEFAULT_TAX) * 0.05;
  const mood = stats.population > 0 ? (stats.happiness - 50) / 150 : 0;
  return {
    r: clamp((jobs - workforce + 60) / (workforce * 0.5 + 80) - taxPenalty + mood),
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

/** Valeur foncière / attractivité d'une tuile (0-100). */
function landValue(tiles: Tile[], size: number, t: Tile, idx: number, hasRoad: boolean, cov: Coverage): number {
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
  let v =
    30 +
    (hasRoad ? 8 : 0) +
    (t.powered ? 8 : 0) +
    (t.water ? 8 : 0) +
    Math.min(10, parks * 1) +
    Math.min(8, shops * 2) +
    cov.PARK[idx] * 12 +
    cov.SCHOOL[idx] * 10 +
    cov.HOSPITAL[idx] * 6 +
    cov.POLICE[idx] * 5 +
    cov.METRO[idx] * 12;
  if (t.type !== 'I') v -= pollutionAt(tiles, size, t) * 3;
  return Math.round(clamp(v, 0, 100));
}

function maxDensity(t: Tile, value: number, population: number): number {
  // Sans eau courante, impossible de dépasser le niveau 1.
  if (!t.water) return 1;
  switch (t.type) {
    case 'R':
      return value >= 62 ? 3 : 2;
    case 'C':
      return value >= 55 && population > 800 ? 3 : population > 150 ? 2 : 1;
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
  const events: SimEvents = { newFires: 0, destroyed: 0, extinguished: 0 };

  // 1. Réseaux (au cas où la carte aurait changé depuis le dernier tick).
  let tiles = applyPower(input.tiles, size);
  const cov = computeCoverage(tiles, size);

  // 2. Demande RCI, lissée pour éviter que les jauges ne sautent.
  const before = computeStats(tiles, size, taxRate, cov);
  const target = computeDemand(before, taxRate);
  const demand: Demand = {
    r: input.demand.r * 0.5 + target.r * 0.5,
    c: input.demand.c * 0.5 + target.c * 0.5,
    i: input.demand.i * 0.5 + target.i * 0.5,
  };

  // 3. Évolution des zones et incendies (parcours depuis un point aléatoire).
  const road = computeRoadAccess(tiles, size);
  const out = tiles.slice();
  let changed = false;
  let changes = 0;
  const n = tiles.length;
  const start = Math.floor(random() * n);

  for (let k = 0; k < n; k++) {
    const idx = (start + k) % n;
    const t = out[idx];
    if (!isZone(t.type)) continue;

    // Incendies : la caserne éteint le feu, sinon il s'étend puis détruit le bâtiment.
    if (t.fire > 0) {
      const fireCov = cov.FIRE[idx];
      if (fireCov > 0 && random() < 0.45 + fireCov * 0.4) {
        out[idx] = { ...t, fire: 0 };
        events.extinguished++;
      } else if (t.fire + 1 >= FIRE_DESTROY_MONTHS) {
        out[idx] = { ...t, type: 'DIRT', density: 0, fire: 0, powered: false, water: false, value: 0 };
        events.destroyed++;
      } else {
        out[idx] = { ...t, fire: t.fire + 1 };
        for (const nb of [idx + 1, idx - 1, idx + size, idx - size]) {
          const o = out[nb];
          if (o && isZone(o.type) && o.density > 0 && o.fire === 0 && random() < 0.12) {
            out[nb] = { ...o, fire: 1 };
            events.newFires++;
          }
        }
      }
      changed = true;
      continue;
    }

    const hasRoad = road[idx] === 1;
    const value = landValue(out, size, t, idx, hasRoad, cov);
    let density = t.density;
    let fire = 0;

    if (density > 0) {
      const risk = 0.00022 * density * (t.type === 'I' ? 3 : t.type === 'C' ? 1.5 : 1) * (1 - 0.85 * cov.FIRE[idx]);
      if (random() < risk) {
        fire = 1;
        events.newFires++;
      }
    }

    if (!fire && changes < MAX_CHANGES_PER_TICK) {
      const d = t.type === 'R' ? demand.r : t.type === 'C' ? demand.c : demand.i;
      const canGrow = hasRoad && t.powered;
      const cap = maxDensity(t, value, before.population);
      if (canGrow && d > 0 && density < cap) {
        if (random() < d * 0.18 * (0.5 + value / 100)) density++;
      } else if (density > 0 && !canGrow) {
        if (random() < 0.05) density--; // abandon faute de courant ou de route
      } else if (density > cap) {
        if (random() < 0.04) density--; // plus d'eau : les immeubles se vident
      } else if (density > 0 && d < -0.25) {
        if (random() < -d * 0.04) density--; // déclin si la demande s'effondre
      }
    }

    if (density !== t.density || value !== t.value || fire !== t.fire) {
      if (density !== t.density) changes++;
      out[idx] = { ...t, density, value, fire };
      changed = true;
    }
  }
  if (changed) tiles = applyPower(out, size);

  // 4. Budget : Trésorerie += Population × Taux − Entretien (routes, centrales, services).
  const stats = computeStats(tiles, size, taxRate, events.destroyed > 0 ? undefined : cov);
  const income = Math.round(stats.population * (taxRate / 100) * INCOME_PER_CITIZEN);
  let expenses = 0;
  for (const t of tiles) expenses += UPKEEP[t.type] ?? 0;

  return { tiles, demand, stats, income, expenses, treasury: input.treasury + income - expenses, events };
}
