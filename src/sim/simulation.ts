import {
  isMonument,
  isRoadType,
  isZone,
  MONUMENT_TYPES,
  SERVICE_TYPES,
  servesZones,
  type MonumentType,
  type ServiceType,
  type Tile,
} from '../engine/map';
import {
  DEFAULT_FUNDING,
  DEFAULT_ORDINANCES,
  DEFAULT_TAX,
  DEFAULT_TAXES,
  fundingOf,
  GARBAGE_PER_LEVEL,
  INCOME_PER_CITIZEN,
  INCOME_PER_JOB,
  JOBS_C,
  JOBS_I,
  LANDFILL_LIMIT,
  MONUMENT_RADIUS,
  MONUMENT_TOURISM,
  MONUMENT_UNLOCK,
  ORDINANCES,
  RESIDENTS,
  ROAD_ACCESS_RANGE,
  ROAD_CAPACITY,
  SERVICE_RADIUS,
  STRIKE_BELOW,
  UPKEEP,
  WASTE_CAPACITY,
  WORKFORCE_RATIO,
  type Funding,
  type FundingKey,
  type Ordinances,
  type Taxes,
} from './constants';
import { applyPower } from './power';

export type Demand = { r: number; c: number; i: number };

export type Coverage = Record<ServiceType, Float32Array>;

/** Politique municipale : taxes, budget des services, ordonnances. */
export type Policy = { taxes: Taxes; funding: Funding; ordinances: Ordinances };
export const DEFAULT_POLICY: Policy = { taxes: DEFAULT_TAXES, funding: DEFAULT_FUNDING, ordinances: DEFAULT_ORDINANCES };

/** Cartes de données par tuile (0-1), pour les vues thématiques et les effets visuels. */
export type CityMaps = {
  /** Congestion des routes (volume / capacité, peut dépasser 1). */
  traffic: Float32Array;
  pollution: Float32Array;
  crime: Float32Array;
};

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
  coverage: { police: number; fire: number; health: number; education: number; metro: number; bus: number; waste: number };
  fires: number;
  metroRiders: number;
  busRiders: number;
  services: number;
  /** Trajet domicile → travail moyen (en tuiles, embouteillages compris). */
  commute: number;
  /** Congestion moyenne des routes empruntées (%). */
  congestion: number;
  /** Pollution moyenne des quartiers résidentiels (0-100). */
  pollution: number;
  /** Déchets non ramassés (moyenne 0-100). */
  garbage: number;
  /** Remplissage des décharges (%). */
  landfill: number;
  tourism: number;
  /** Services en grève (budget trop faible). */
  strikes: FundingKey[];
};

export type DisasterKind = 'earthquake' | 'flood' | 'tornado' | 'blackout';
export type DisasterEvent = { kind: DisasterKind; x: number; y: number; path?: [number, number][]; damage: number };

export type NewsItem = { icon: string; text: string };

export type SimEvents = {
  newFires: number;
  destroyed: number;
  extinguished: number;
  disasters: DisasterEvent[];
  news: NewsItem[];
};

export type SimInput = {
  tiles: Tile[];
  size: number;
  treasury: number;
  /** Ancien paramètre (taux unique) : utilisé si `policy` est absent. */
  taxRate?: number;
  policy?: Policy;
  demand: Demand;
  disasters?: boolean;
  /** Catastrophe déclenchée à la main depuis le menu. */
  trigger?: DisasterKind | null;
  /** Générateur aléatoire injectable (tests déterministes). */
  random?: () => number;
};

export type SimOutput = {
  tiles: Tile[];
  treasury: number;
  demand: Demand;
  stats: CityStats;
  maps: CityMaps;
  income: number;
  expenses: number;
  events: SimEvents;
};

/** Nombre maximal de bâtiments qui évoluent par mois : la ville pousse progressivement. */
const MAX_CHANGES_PER_TICK = 60;
/** Un bâtiment qui brûle plus de 4 mois est détruit. */
const FIRE_DESTROY_MONTHS = 4;
const POP_MILESTONES = [500, 1000, 2500, 5000, 10000, 20000, 50000, 100000];

const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));

const policyOf = (input: { policy?: Policy; taxRate?: number }): Policy =>
  input.policy ?? {
    ...DEFAULT_POLICY,
    taxes: input.taxRate === undefined ? DEFAULT_TAXES : { R: input.taxRate, C: input.taxRate, I: input.taxRate },
  };

/** Efficacité d'un service selon son budget : 0 en grève, sinon proportionnelle (max 120 %). */
export function fundingFactor(funding: Funding, key: FundingKey | null): number {
  if (!key) return 1;
  const f = funding[key];
  return f < STRIKE_BELOW ? 0 : Math.min(1.2, f / 100);
}

const neighbours4 = (i: number, size: number, n: number) => {
  const x = i % size;
  return [x + 1 < size ? i + 1 : -1, x > 0 ? i - 1 : -1, i + size < n ? i + size : -1, i - size];
};

/**
 * Couverture de chaque service : 1 au pied du bâtiment, décroissante jusqu'à
 * son rayon d'action, multipliée par son budget. Un service sans électricité ou
 * en grève ne fonctionne pas (sauf parcs et arrêts de bus). L'université couvre
 * l'éducation sur un grand rayon.
 */
export function computeCoverage(tiles: Tile[], size: number, funding: Funding = DEFAULT_FUNDING): Coverage {
  const cov = Object.fromEntries(SERVICE_TYPES.map((s) => [s, new Float32Array(size * size)])) as Coverage;
  const stamp = (map: Float32Array, cx: number, cy: number, radius: number, strength: number) => {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.hypot(dx, dy);
        if (d > radius) continue;
        const v = (1 - (d / (radius + 1)) * 0.7) * strength;
        const i = y * size + x;
        if (v > map[i]) map[i] = v;
      }
    }
  };
  for (const t of tiles) {
    if (t.flood > 0) continue;
    if (t.type === 'UNIVERSITY' && t.powered) {
      stamp(cov.SCHOOL, t.x, t.y, MONUMENT_RADIUS.UNIVERSITY, fundingFactor(funding, 'education'));
      continue;
    }
    const type = t.type as ServiceType;
    const radius = SERVICE_RADIUS[type];
    if (!radius) continue;
    const needsPower = type !== 'PARK' && type !== 'BUSSTOP';
    if (needsPower && !t.powered) continue;
    if (type === 'LANDFILL' && t.garbage >= 9) continue; // décharge pleine
    const strength = fundingFactor(funding, fundingOf(type));
    if (strength <= 0) continue;
    stamp(cov[type], t.x, t.y, radius, strength);
  }
  return cov;
}

/** Accès routier : BFS multi-sources depuis les routes qui desservent les zones (rue, avenue). */
export function computeRoadAccess(tiles: Tile[], size: number): Uint8Array {
  const dist = new Int8Array(size * size).fill(-1);
  const queue = new Int32Array(size * size);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (servesZones(tiles[i].type)) {
      dist[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    if (dist[i] >= ROAD_ACCESS_RANGE) continue;
    for (const n of neighbours4(i, size, tiles.length)) {
      if (n < 0 || dist[n] !== -1) continue;
      dist[n] = dist[i] + 1;
      queue[tail++] = n;
    }
  }
  const access = new Uint8Array(size * size);
  for (let i = 0; i < access.length; i++) access[i] = dist[i] >= 0 ? 1 : 0;
  return access;
}

/** Route desservante la plus proche d'une tuile (rayon 3), ou -1. */
function accessRoad(tiles: Tile[], size: number, t: Tile): number {
  let best = -1;
  let bestD = Infinity;
  for (let dy = -ROAD_ACCESS_RANGE; dy <= ROAD_ACCESS_RANGE; dy++) {
    for (let dx = -ROAD_ACCESS_RANGE; dx <= ROAD_ACCESS_RANGE; dx++) {
      const d = Math.abs(dx) + Math.abs(dy);
      if (d > ROAD_ACCESS_RANGE || d >= bestD) continue;
      const x = t.x + dx;
      const y = t.y + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      if (servesZones(tiles[y * size + x].type)) {
        best = y * size + x;
        bestD = d;
      }
    }
  }
  return best;
}

/** Tas binaire minimal pour Dijkstra. */
class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, value: number) {
    const k = this.k;
    const v = this.v;
    k.push(key);
    v.push(value);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const k = this.k;
    const v = this.v;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Coût de parcours d'une tuile de route (les grands axes sont plus rapides). */
const ROAD_COST = { ROAD: 1, AVENUE: 0.75, HIGHWAY: 0.45 } as const;

export type TrafficResult = {
  /** Congestion par tuile de route (volume / capacité). */
  congestion: Float32Array;
  /** Trajet moyen par tuile résidentielle (-1 = pas d'emploi accessible). */
  commute: Float32Array;
  /** Part des actifs sans emploi accessible par la route, par tuile résidentielle. */
  jobless: Float32Array;
};

/**
 * Trajets domicile → travail (comme le générateur de trajets de SimCity) :
 * Dijkstra multi-sources depuis les routes qui desservent un emploi, puis chaque
 * quartier envoie ses actifs (hors usagers des transports) vers l'emploi le plus
 * proche par la route. On cumule le volume sur chaque tuile de route.
 */
export function computeTraffic(tiles: Tile[], size: number, transit: Float32Array): TrafficResult {
  const n = tiles.length;
  const dist = new Float32Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const heap = new MinHeap();
  for (const t of tiles) {
    if ((t.type !== 'C' && t.type !== 'I') || t.density === 0 || t.fire > 0) continue;
    const r = accessRoad(tiles, size, t);
    if (r >= 0 && dist[r] > 0) {
      dist[r] = 0;
      parent[r] = r;
      heap.push(0, r);
    }
  }
  while (heap.size) {
    const [d, i] = heap.pop();
    if (d > dist[i]) continue;
    for (const nb of neighbours4(i, size, n)) {
      if (nb < 0) continue;
      const type = tiles[nb].type;
      if (!isRoadType(type)) continue;
      const nd = d + ROAD_COST[type];
      if (nd < dist[nb]) {
        dist[nb] = nd;
        parent[nb] = i;
        heap.push(nd, nb);
      }
    }
  }

  const volume = new Float32Array(n);
  const homes: { idx: number; road: number; workers: number }[] = [];
  for (const t of tiles) {
    if (t.type !== 'R' || t.density === 0 || t.fire > 0) continue;
    const idx = t.y * size + t.x;
    const road = accessRoad(tiles, size, t);
    const workers = RESIDENTS[t.density] * WORKFORCE_RATIO * (1 - transit[idx]);
    homes.push({ idx, road, workers });
    if (road < 0 || dist[road] === Infinity) continue;
    for (let r = road, guard = 0; guard < 400; guard++) {
      volume[r] += workers;
      if (parent[r] === r || parent[r] < 0) break;
      r = parent[r];
    }
  }

  const congestion = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const type = tiles[i].type;
    if (isRoadType(type)) congestion[i] = volume[i] / ROAD_CAPACITY[type];
  }

  const commute = new Float32Array(n).fill(-1);
  const jobless = new Float32Array(n);
  for (const h of homes) {
    if (h.road < 0 || dist[h.road] === Infinity) {
      jobless[h.idx] = 1;
      continue;
    }
    // Temps de trajet : chaque tuile coûte plus cher quand elle est saturée.
    let time = 0;
    for (let r = h.road, guard = 0; guard < 400; guard++) {
      const type = tiles[r].type as keyof typeof ROAD_COST;
      time += (ROAD_COST[type] ?? 1) * (1 + Math.max(0, congestion[r] - 1) * 1.5);
      if (parent[r] === r || parent[r] < 0) break;
      r = parent[r];
    }
    commute[h.idx] = time;
  }
  return { congestion, commute, jobless };
}

/** Pollution émise par l'industrie, les centrales, l'incinérateur, l'aéroport et les bouchons. */
export function computePollution(
  tiles: Tile[],
  size: number,
  ordinances: Ordinances = DEFAULT_ORDINANCES,
  congestion?: Float32Array,
): Float32Array {
  const pollution = new Float32Array(size * size);
  const emit = (cx: number, cy: number, strength: number, radius: number) => {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.hypot(dx, dy);
        if (d > radius) continue;
        pollution[y * size + x] += strength * (1 - d / (radius + 1));
      }
    }
  };
  for (const t of tiles) {
    if (t.type === 'I' && t.density > 0) emit(t.x, t.y, 7 * t.density, 5);
    else if (t.type === 'POWER' && t.flood === 0) emit(t.x, t.y, ordinances.energy ? 14 : 22, 6);
    else if (t.type === 'INCINERATOR' && t.powered) emit(t.x, t.y, 18, 6);
    else if (t.type === 'AIRPORT') emit(t.x, t.y, 14, 7);
    else if (congestion && isRoadType(t.type)) {
      const c = congestion[t.y * size + t.x];
      if (c > 0.6) emit(t.x, t.y, Math.min(8, (c - 0.6) * 6), 2);
    }
  }
  // La végétation absorbe : forêts, parcs et plantations.
  const absorb = ordinances.trees ? 0.82 : 1;
  for (const t of tiles) {
    const i = t.y * size + t.x;
    if (t.type === 'FOREST' || t.type === 'PARK') pollution[i] *= 0.5;
    pollution[i] *= absorb;
  }
  return pollution;
}

/** Criminalité d'un quartier : densité, pauvreté (faible valeur foncière), ordonnances, moins la police. */
function crimeAt(t: Tile, police: number, ordinances: Ordinances): number {
  let c = 12 + t.density * 11 + (55 - t.value) * 0.45 - police * 45;
  if (ordinances.gambling) c += 10;
  if (ordinances.watch) c -= 7;
  if (ordinances.curfew) c -= 14;
  return clamp(c, 0, 100);
}

/** Part des actifs d'une tuile qui prennent les transports (métro, bus). */
function transitShares(tiles: Tile[], cov: Coverage, ordinances: Ordinances): Float32Array {
  const metroOk = tiles.filter((t) => t.type === 'METRO' && t.powered).length >= 2;
  const busOk = tiles.filter((t) => t.type === 'BUSSTOP').length >= 2;
  const bonus = ordinances.freeTransit ? 1.35 : 1;
  const share = new Float32Array(tiles.length);
  for (let i = 0; i < tiles.length; i++) {
    const s = (metroOk ? 0.35 * cov.METRO[i] : 0) + (busOk ? 0.22 * cov.BUSSTOP[i] : 0);
    share[i] = Math.min(0.7, s * bonus);
  }
  return share;
}

type Analysis = {
  stats: CityStats;
  maps: CityMaps;
  cov: Coverage;
  traffic: TrafficResult;
  transit: Float32Array;
  pollution: Float32Array;
};

/** Analyse complète de la ville (statistiques + cartes), sans la faire évoluer. */
export function analyzeCity(tiles: Tile[], size: number, policy: Policy = DEFAULT_POLICY): Analysis {
  const { funding, ordinances, taxes } = policy;
  const cov = computeCoverage(tiles, size, funding);
  const transit = transitShares(tiles, cov, ordinances);
  const traffic = computeTraffic(tiles, size, transit);
  const pollution = computePollution(tiles, size, ordinances, traffic.congestion);
  const crimeMap = new Float32Array(tiles.length);

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
  let rTiles = 0;
  let commuteSum = 0;
  let commuteN = 0;
  let joblessWorkers = 0;
  let garbageSum = 0;
  let metroRiders = 0;
  let busRiders = 0;
  const covSum = { police: 0, fire: 0, health: 0, education: 0, metro: 0, bus: 0, waste: 0 };

  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (t.fire > 0) fires++;
    if (isRoadType(t.type)) roads++;
    else if (t.type === 'POWER') plants++;
    else if (!isZone(t.type) && t.type !== 'GRASS' && t.type !== 'DIRT' && t.type !== 'LAKE' && t.type !== 'SAND' && t.type !== 'FOREST') {
      services++;
    }
    if (!isZone(t.type)) continue;
    zones++;
    if (t.powered) poweredZones++;
    if (t.water) wateredZones++;
    if (t.density === 0 || t.fire > 0) continue;

    built++;
    garbageSum += t.garbage;
    if (t.type === 'R') {
      const residents = RESIDENTS[t.density];
      population += residents;
      const m = cov.METRO[i] > 0 ? transit[i] * (0.35 * cov.METRO[i]) / Math.max(0.001, 0.35 * cov.METRO[i] + 0.22 * cov.BUSSTOP[i]) : 0;
      metroRiders += Math.round(residents * WORKFORCE_RATIO * m);
      busRiders += Math.round(residents * WORKFORCE_RATIO * (transit[i] - m));
      pollutionR += pollution[i];
      rTiles++;
      if (traffic.commute[i] >= 0) {
        commuteSum += traffic.commute[i];
        commuteN++;
      }
      joblessWorkers += residents * WORKFORCE_RATIO * traffic.jobless[i];
    } else if (t.type === 'C') jobsC += JOBS_C[t.density];
    else jobsI += JOBS_I[t.density];

    covSum.police += cov.POLICE[i] > 0 ? 1 : 0;
    covSum.fire += cov.FIRE[i] > 0 ? 1 : 0;
    covSum.health += cov.HOSPITAL[i] > 0 ? 1 : 0;
    covSum.education += cov.SCHOOL[i] > 0 ? 1 : 0;
    covSum.metro += cov.METRO[i] > 0 ? 1 : 0;
    covSum.bus += cov.BUSSTOP[i] > 0 ? 1 : 0;
    covSum.waste += cov.LANDFILL[i] > 0 || cov.INCINERATOR[i] > 0 ? 1 : 0;
    if (t.type !== 'I') {
      const c = crimeAt(t, cov.POLICE[i], ordinances);
      crimeMap[i] = c / 100;
      crimeSum += c;
    }
  }

  const workforce = Math.round(population * WORKFORCE_RATIO);
  // Les actifs sans emploi accessible par la route ne comptent pas comme employés.
  const reachable = Math.max(0, workforce - joblessWorkers);
  const employed = Math.round(Math.min(reachable, jobsC + jobsI));
  const unemployment = workforce > 0 ? Math.round(((workforce - employed) / workforce) * 100) : 0;
  const pct = (v: number) => (built > 0 ? Math.round((v / built) * 100) : 0);
  const coverage = {
    police: pct(covSum.police),
    fire: pct(covSum.fire),
    health: pct(covSum.health),
    education: pct(covSum.education),
    metro: pct(covSum.metro),
    bus: pct(covSum.bus),
    waste: pct(covSum.waste),
  };
  const crime = built > 0 ? Math.round(crimeSum / built) : 0;
  const avgPollution = rTiles > 0 ? pollutionR / rTiles : 0;
  const commute = commuteN > 0 ? commuteSum / commuteN : 0;
  let congSum = 0;
  let congN = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (traffic.congestion[i] > 0) {
      congSum += Math.min(2, traffic.congestion[i]);
      congN++;
    }
  }
  const congestion = congN > 0 ? Math.round((congSum / congN) * 100) : 0;
  const garbage = built > 0 ? Math.round((garbageSum / built / 9) * 100) : 0;

  const monuments = MONUMENT_TYPES.filter((m) => tiles.some((t) => t.type === m && t.powered));
  const tourism = Math.round(monuments.reduce((s, m) => s + MONUMENT_TOURISM[m], 0) * (population > 0 ? 1 : 0));
  const landfills = tiles.filter((t) => t.type === 'LANDFILL');
  const landfill = landfills.length ? Math.round((landfills.reduce((s, t) => s + t.garbage, 0) / (landfills.length * 9)) * 100) : 0;
  const strikes = (Object.keys(funding) as FundingKey[]).filter((k) => funding[k] < STRIKE_BELOW);
  const avgTax = (taxes.R + taxes.C + taxes.I) / 3;

  // Satisfaction : services, emploi, trajets, sécurité, environnement, impôts, monuments.
  const happiness =
    population === 0
      ? 50
      : Math.round(
          clamp(
            45 +
              coverage.police * 0.07 +
              coverage.fire * 0.05 +
              coverage.health * 0.09 +
              coverage.education * 0.09 +
              coverage.metro * 0.03 +
              coverage.bus * 0.02 -
              crime * 0.3 -
              unemployment * 0.45 -
              avgPollution * 0.45 -
              Math.max(0, commute - 14) * 0.6 -
              Math.max(0, congestion - 80) * 0.08 -
              garbage * 0.25 -
              (avgTax - DEFAULT_TAX) * 2.5 -
              fires * 2 -
              strikes.length * 4 +
              (ordinances.smoking ? 3 : 0) -
              (ordinances.curfew ? 6 : 0) +
              (monuments.includes('STADIUM') ? 6 : 0) +
              (monuments.includes('LANDMARK') ? 3 : 0),
            0,
            100,
          ),
        );

  return {
    stats: {
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
      busRiders,
      services,
      commute: Math.round(commute * 10) / 10,
      congestion,
      pollution: Math.round(Math.min(100, avgPollution * 2)),
      garbage,
      landfill,
      tourism,
      strikes,
    },
    maps: { traffic: traffic.congestion, pollution, crime: crimeMap },
    cov,
    traffic,
    transit,
    pollution,
  };
}

/** Statistiques seules (compatibilité). */
export function computeStats(tiles: Tile[], size: number, taxRate = DEFAULT_TAX, policy?: Policy): CityStats {
  return analyzeCity(tiles, size, policy ?? policyOf({ taxRate })).stats;
}

/**
 * Demande RCI (entre -1 et 1) :
 *  - R monte quand il y a des emplois (C + I) disponibles et que les habitants sont heureux ;
 *  - C monte quand la population est élevée (et avec l'aéroport) ;
 *  - I monte avec la main-d'œuvre disponible.
 * Chaque zone réagit à sa propre taxe.
 */
export function computeDemand(stats: CityStats, taxes: Taxes | number, ordinances: Ordinances = DEFAULT_ORDINANCES, monuments: MonumentType[] = []): Demand {
  const tx = typeof taxes === 'number' ? { R: taxes, C: taxes, I: taxes } : taxes;
  const jobs = stats.jobsC + stats.jobsI;
  const workforce = stats.workforce;
  const mood = stats.population > 0 ? (stats.happiness - 50) / 150 : 0;
  const airport = monuments.includes('AIRPORT') ? 0.15 : 0;
  return {
    r: clamp((jobs - workforce + 60) / (workforce * 0.5 + 80) - (tx.R - DEFAULT_TAX) * 0.05 + mood),
    c: clamp(
      (stats.population * 0.22 - stats.jobsC + 10) / (stats.jobsC * 0.5 + 40) -
        (tx.C - DEFAULT_TAX) * 0.05 +
        airport -
        (ordinances.smoking ? 0.08 : 0) +
        (stats.tourism > 0 ? 0.05 : 0),
    ),
    i: clamp((stats.population * 0.38 - stats.jobsI + 40) / (stats.jobsI * 0.5 + 50) - (tx.I - DEFAULT_TAX) * 0.05 + airport * 0.6),
  };
}

/** Valeur foncière / attractivité d'une tuile (0-100). */
function landValue(tiles: Tile[], size: number, t: Tile, idx: number, hasRoad: boolean, a: Analysis, ordinances: Ordinances, landmarks: Tile[]): number {
  let parks = 0;
  let shops = 0;
  let waterfront = false;
  let forest = 0;
  let jam = 0;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const x = t.x + dx;
      const y = t.y + dy;
      if (x < 0 || y < 0 || x >= size || y >= size || (dx === 0 && dy === 0)) continue;
      const near = Math.abs(dx) <= 2 && Math.abs(dy) <= 2;
      const ni = y * size + x;
      const n = tiles[ni];
      if (n.type === 'LAKE') waterfront = true;
      if (!near) continue;
      if (n.type === 'GRASS') parks++;
      else if (n.type === 'FOREST') forest++;
      else if (n.type === 'C' && n.density > 0) shops++;
      else if (isRoadType(n.type) && Math.abs(dx) + Math.abs(dy) <= 1) jam = Math.max(jam, a.traffic.congestion[ni]);
    }
  }
  const cov = a.cov;
  let v =
    28 +
    (hasRoad ? 8 : 0) +
    (t.powered ? 8 : 0) +
    (t.water ? 8 : 0) +
    (waterfront ? 9 : 0) +
    Math.min(8, parks * 0.8 + forest * 1.5) +
    Math.min(8, shops * 2) +
    cov.PARK[idx] * 12 +
    cov.SCHOOL[idx] * 10 +
    cov.HOSPITAL[idx] * 6 +
    cov.POLICE[idx] * 5 +
    cov.METRO[idx] * 12 +
    cov.BUSSTOP[idx] * 5 +
    (ordinances.trees ? 4 : 0) -
    Math.max(0, jam - 1) * 8 -
    t.garbage * 3 -
    (a.maps.crime[idx] * 100) * 0.15;
  for (const lm of landmarks) {
    const d = Math.hypot(lm.x - t.x, lm.y - t.y);
    if (d <= MONUMENT_RADIUS.LANDMARK) v += 15 * (1 - d / (MONUMENT_RADIUS.LANDMARK + 1));
  }
  if (t.type !== 'I') v -= a.pollution[idx] * 0.6;
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

// ---------------------------------------------------------------------------
// Catastrophes
// ---------------------------------------------------------------------------

const destroyTile = (t: Tile): Tile =>
  t.lake ? { ...t, type: 'LAKE', density: 0, fire: 0, garbage: 0, flood: 0 } : { ...t, type: 'DIRT', density: 0, fire: 0, garbage: 0, flood: 0 };
const destructible = (t: Tile) =>
  (isZone(t.type) && t.density > 0) || t.type === 'POWER' || (SERVICE_TYPES as string[]).includes(t.type) || isMonument(t.type) || isRoadType(t.type);

function earthquake(out: Tile[], size: number, random: () => number): DisasterEvent {
  const x = Math.floor(random() * size);
  const y = Math.floor(random() * size);
  let damage = 0;
  for (let i = 0; i < out.length; i++) {
    const t = out[i];
    const d = Math.hypot(t.x - x, t.y - y);
    if (d > 12 || !destructible(t)) continue;
    const p = 0.25 * (1 - d / 13);
    if (random() < p) {
      out[i] = random() < 0.3 && isZone(t.type) ? { ...t, fire: 1 } : destroyTile(t);
      damage++;
    }
  }
  return { kind: 'earthquake', x, y, damage };
}

function tornado(out: Tile[], size: number, random: () => number): DisasterEvent {
  let x = Math.floor(random() * size);
  let y = Math.floor(random() * size);
  const path: [number, number][] = [];
  let damage = 0;
  let dir = random() * Math.PI * 2;
  for (let s = 0; s < 22; s++) {
    path.push([x, y]);
    if (x >= 0 && y >= 0 && x < size && y < size) {
      const i = y * size + x;
      if (destructible(out[i]) && random() < 0.7) {
        out[i] = destroyTile(out[i]);
        damage++;
      }
    }
    dir += (random() - 0.5) * 0.9;
    x = Math.round(x + Math.cos(dir) * 1.2);
    y = Math.round(y + Math.sin(dir) * 1.2);
  }
  return { kind: 'tornado', x: path[0][0], y: path[0][1], path, damage };
}

function flood(out: Tile[], size: number, random: () => number): DisasterEvent | null {
  const shores = out.filter((t) => t.type === 'LAKE');
  if (!shores.length) return null;
  const c = shores[Math.floor(random() * shores.length)];
  let damage = 0;
  for (let i = 0; i < out.length; i++) {
    const t = out[i];
    if (t.type === 'LAKE' || t.lake || Math.hypot(t.x - c.x, t.y - c.y) > 7) continue;
    // Seules les tuiles proches de l'eau sont inondées.
    let wet = false;
    for (let dy = -2; dy <= 2 && !wet; dy++) {
      for (let dx = -2; dx <= 2 && !wet; dx++) {
        const nx = t.x + dx;
        const ny = t.y + dy;
        if (nx >= 0 && ny >= 0 && nx < size && ny < size && out[ny * size + nx].type === 'LAKE') wet = true;
      }
    }
    if (wet) {
      out[i] = { ...t, flood: 3 + Math.floor(random() * 3) };
      damage++;
    }
  }
  return { kind: 'flood', x: c.x, y: c.y, damage };
}

function blackout(out: Tile[], random: () => number): DisasterEvent | null {
  const plants = out.map((t, i) => [t, i] as const).filter(([t]) => t.type === 'POWER' && t.flood === 0);
  if (!plants.length) return null;
  const [t, i] = plants[Math.floor(random() * plants.length)];
  out[i] = { ...t, flood: 3 };
  return { kind: 'blackout', x: t.x, y: t.y, damage: 1 };
}

export const DISASTER_LABELS: Record<DisasterKind, { icon: string; label: string }> = {
  earthquake: { icon: '🌍', label: 'Séisme' },
  flood: { icon: '🌊', label: 'Inondation' },
  tornado: { icon: '🌪️', label: 'Tornade' },
  blackout: { icon: '⚡', label: 'Panne de centrale' },
};

// ---------------------------------------------------------------------------
// Un mois de simulation
// ---------------------------------------------------------------------------

/** Un mois de simulation. Fonction pure : renvoie le nouvel état sans muter l'entrée. */
export function simulateMonth(input: SimInput): SimOutput {
  const { size } = input;
  const policy = policyOf(input);
  const { taxes, funding, ordinances } = policy;
  const random = input.random ?? Math.random;
  const events: SimEvents = { newFires: 0, destroyed: 0, extinguished: 0, disasters: [], news: [] };

  // 1. Réseaux (au cas où la carte aurait changé depuis le dernier tick).
  let tiles = applyPower(input.tiles, size);
  const before = analyzeCity(tiles, size, policy);
  const monumentsBefore = MONUMENT_TYPES.filter((m) => tiles.some((t) => t.type === m && t.powered));

  // 2. Demande RCI, lissée pour éviter que les jauges ne sautent.
  const target = computeDemand(before.stats, taxes, ordinances, monumentsBefore);
  const demand: Demand = {
    r: input.demand.r * 0.5 + target.r * 0.5,
    c: input.demand.c * 0.5 + target.c * 0.5,
    i: input.demand.i * 0.5 + target.i * 0.5,
  };

  // 3. Déchets : production des quartiers, ramassage par les décharges et l'incinérateur.
  const wasteF = fundingFactor(funding, 'waste');
  const recyclingCenters = tiles.filter((t) => t.type === 'RECYCLING' && t.powered).length;
  const recycleCut = Math.min(0.6, (ordinances.recycling ? 0.25 : 0) + recyclingCenters * WASTE_CAPACITY.RECYCLING * wasteF);
  const landfills = tiles.filter((t) => t.type === 'LANDFILL' && t.powered && t.garbage < 9);
  const incinerators = tiles.filter((t) => t.type === 'INCINERATOR' && t.powered);
  const capacity = (landfills.length * WASTE_CAPACITY.LANDFILL + incinerators.length * WASTE_CAPACITY.INCINERATOR) * wasteF;
  let produced = 0;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (isZone(t.type) && t.density > 0 && (before.cov.LANDFILL[i] > 0 || before.cov.INCINERATOR[i] > 0)) {
      produced += GARBAGE_PER_LEVEL[t.type] * t.density * (1 - recycleCut);
    }
  }
  const collectRatio = produced > 0 ? Math.min(1, capacity / produced) : 1;
  const dumped = Math.min(capacity, produced);

  // 4. Évolution des zones, incendies, déchets (parcours depuis un point aléatoire).
  const road = computeRoadAccess(tiles, size);
  const landmarks = tiles.filter((t) => t.type === 'LANDMARK' && t.powered);
  const out = tiles.slice();
  let changes = 0;
  const n = tiles.length;
  const start = Math.floor(random() * n);
  const fireF = (i: number) => before.cov.FIRE[i];

  for (let k = 0; k < n; k++) {
    const idx = (start + k) % n;
    let t = out[idx];

    // Hors service (inondation, panne) : décompte des mois restants.
    if (t.flood > 0) {
      t = { ...t, flood: t.flood - 1, density: isZone(t.type) && t.density > 0 && random() < 0.15 ? t.density - 1 : t.density };
      out[idx] = t;
      continue;
    }
    if (!isZone(t.type)) continue;

    // Incendies : la caserne éteint le feu, sinon il s'étend puis détruit le bâtiment.
    if (t.fire > 0) {
      const cov = fireF(idx);
      if (cov > 0 && random() < 0.45 + cov * 0.4) {
        out[idx] = { ...t, fire: 0 };
        events.extinguished++;
      } else if (t.fire + 1 >= FIRE_DESTROY_MONTHS) {
        out[idx] = { ...t, type: 'DIRT', density: 0, fire: 0, powered: false, water: false, value: 0, garbage: 0 };
        events.destroyed++;
      } else {
        out[idx] = { ...t, fire: t.fire + 1 };
        for (const nb of neighbours4(idx, size, n)) {
          const o = nb >= 0 ? out[nb] : null;
          if (o && isZone(o.type) && o.density > 0 && o.fire === 0 && random() < 0.12) {
            out[nb] = { ...o, fire: 1 };
            events.newFires++;
          }
        }
      }
      continue;
    }

    const hasRoad = road[idx] === 1;
    const value = landValue(out, size, t, idx, hasRoad, before, ordinances, landmarks);
    let density = t.density;
    let fire = 0;

    // Déchets : ramassés si un service passe, sinon ils s'accumulent.
    let garbage = t.garbage;
    if (density > 0) {
      const covered = before.cov.LANDFILL[idx] > 0 || before.cov.INCINERATOR[idx] > 0;
      const rate = GARBAGE_PER_LEVEL[t.type as 'R' | 'C' | 'I'] * density * (1 - recycleCut);
      if (covered && random() < collectRatio) garbage = Math.max(0, garbage - 2);
      else if (random() < Math.min(0.9, rate * 0.12)) garbage = Math.min(9, garbage + 1);
    } else garbage = 0;

    if (density > 0) {
      const risk = 0.00022 * density * (t.type === 'I' ? 3 : t.type === 'C' ? 1.5 : 1) * (1 - 0.85 * fireF(idx));
      if (random() < risk) {
        fire = 1;
        events.newFires++;
      }
    }

    if (!fire && changes < MAX_CHANGES_PER_TICK) {
      const d = t.type === 'R' ? demand.r : t.type === 'C' ? demand.c : demand.i;
      const canGrow = hasRoad && t.powered && garbage < 7;
      const cap = maxDensity(t, value, before.stats.population);
      if (canGrow && d > 0 && density < cap) {
        if (random() < d * 0.18 * (0.5 + value / 100)) density++;
      } else if (density > 0 && !canGrow) {
        if (random() < 0.05) density--; // abandon faute de courant, de route ou à cause des ordures
      } else if (density > cap) {
        if (random() < 0.04) density--; // plus d'eau : les immeubles se vident
      } else if (density > 0 && d < -0.25) {
        if (random() < -d * 0.04) density--; // déclin si la demande s'effondre
      }
    }

    if (density !== t.density || value !== t.value || fire !== t.fire || garbage !== t.garbage) {
      if (density !== t.density) changes++;
      out[idx] = { ...t, density, value, fire, garbage };
    }
  }

  // Remplissage des décharges : chaque niveau (sur 9) correspond à LANDFILL_LIMIT / 9 tonnes.
  if (landfills.length && dumped > 0) {
    const share = (landfills.length * WASTE_CAPACITY.LANDFILL) / (landfills.length * WASTE_CAPACITY.LANDFILL + incinerators.length * WASTE_CAPACITY.INCINERATOR);
    const perLandfill = (dumped * share) / landfills.length;
    for (const lf of landfills) {
      const i = lf.y * size + lf.x;
      const cur = out[i];
      if (random() < perLandfill / (LANDFILL_LIMIT / 9)) {
        out[i] = { ...cur, garbage: Math.min(9, cur.garbage + 1) };
        if (out[i].garbage >= 9) events.news.push({ icon: '🗑️', text: 'Une décharge est pleine : construisez-en une autre ou un incinérateur.' });
      }
    }
  }

  // 5. Catastrophes (aléatoires si activées, ou déclenchées depuis le menu).
  const chance = input.disasters ? 1 : 0;
  const roll = (p: number) => random() < p * chance;
  const kinds: DisasterKind[] = [];
  if (input.trigger) kinds.push(input.trigger);
  else {
    if (roll(0.004)) kinds.push('earthquake');
    if (roll(0.004)) kinds.push('tornado');
    if (roll(0.006)) kinds.push('flood');
    if (roll(0.006)) kinds.push('blackout');
  }
  for (const kind of kinds) {
    const ev =
      kind === 'earthquake' ? earthquake(out, size, random) : kind === 'tornado' ? tornado(out, size, random) : kind === 'flood' ? flood(out, size, random) : blackout(out, random);
    if (!ev) continue;
    events.disasters.push(ev);
    const L = DISASTER_LABELS[kind];
    events.news.push({ icon: L.icon, text: `${L.label} ! ${ev.damage} tuile(s) touchée(s) près de (${ev.x}, ${ev.y}).` });
  }

  tiles = applyPower(out, size);

  // 6. Budget : impôts R/C/I + tourisme − entretien (au prorata du budget) − ordonnances.
  const after = analyzeCity(tiles, size, policy);
  const stats = after.stats;
  const taxIncome =
    stats.population * (taxes.R / 100) * INCOME_PER_CITIZEN +
    (stats.jobsC * (taxes.C / 100) + stats.jobsI * (taxes.I / 100)) * INCOME_PER_JOB;
  let ordinanceCost = 0;
  for (const o of ORDINANCES) if (ordinances[o.id]) ordinanceCost += (o.costPer100 * stats.population) / 100;
  const income = Math.round(taxIncome + stats.tourism + Math.max(0, -ordinanceCost));
  let expenses = 0;
  for (const t of tiles) {
    const base = UPKEEP[t.type] ?? 0;
    if (!base) continue;
    const key = fundingOf(t.type);
    expenses += base * (key ? funding[key] / 100 : 1);
  }
  expenses = Math.round(expenses + Math.max(0, ordinanceCost));

  // 7. Journal : paliers de population, monuments débloqués, alertes.
  const p0 = before.stats.population;
  const p1 = stats.population;
  for (const m of POP_MILESTONES) if (p0 < m && p1 >= m) events.news.push({ icon: '🎉', text: `La ville franchit les ${groupDigits(m)} habitants !` });
  for (const m of MONUMENT_TYPES) {
    if (p0 < MONUMENT_UNLOCK[m] && p1 >= MONUMENT_UNLOCK[m]) events.news.push({ icon: '🏛️', text: `Nouveau monument disponible : ${MONUMENT_NAMES[m]}.` });
  }
  if (events.newFires > 0) events.news.push({ icon: '🔥', text: `Incendie signalé (${events.newFires} foyer${events.newFires > 1 ? 's' : ''}).` });
  if (events.destroyed > 0) events.news.push({ icon: '💥', text: `${events.destroyed} bâtiment(s) détruit(s) par le feu.` });
  for (const s of stats.strikes) if (!before.stats.strikes.includes(s) || random() < 0.1) events.news.push({ icon: '✊', text: `Grève : ${STRIKE_TEXT[s]}` });

  return {
    tiles,
    demand,
    stats,
    maps: after.maps,
    income,
    expenses,
    treasury: input.treasury + income - expenses,
    events,
  };
}

export const MONUMENT_NAMES: Record<MonumentType, string> = {
  STADIUM: 'Stade',
  UNIVERSITY: 'Université',
  AIRPORT: 'Aéroport',
  LANDMARK: 'Tour emblématique',
};

const STRIKE_TEXT: Record<FundingKey, string> = {
  police: 'les policiers manquent de moyens.',
  fire: 'les pompiers ne répondent plus.',
  health: 'les hôpitaux sont fermés.',
  education: 'les écoles ferment leurs portes.',
  transport: 'métro et bus à l’arrêt, routes non entretenues.',
  utilities: 'les agents des réseaux débrayent.',
  waste: 'les éboueurs ne passent plus.',
};

/** Plainte typique des habitants selon le principal problème de la ville (journal, bulles). */
export function topComplaint(stats: CityStats, taxes: Taxes): NewsItem | null {
  const issues: [number, NewsItem][] = [
    [stats.congestion - 70, { icon: '🚗', text: 'Les habitants râlent contre les bouchons.' }],
    [stats.crime - 25, { icon: '🚨', text: 'Inquiétude face à la hausse de la criminalité.' }],
    [stats.pollution - 30, { icon: '🏭', text: 'L’air devient irrespirable près des usines.' }],
    [stats.garbage - 20, { icon: '🗑️', text: 'Les poubelles débordent dans plusieurs quartiers.' }],
    [stats.unemployment - 12, { icon: '💼', text: 'Le chômage inquiète : il manque des emplois.' }],
    [(taxes.R + taxes.C + taxes.I) / 3 - 12, { icon: '💸', text: 'Les impôts sont jugés trop élevés.' }],
    [stats.commute - 20, { icon: '⏱️', text: 'Les trajets domicile-travail sont trop longs.' }],
  ];
  issues.sort((a, b) => b[0] - a[0]);
  return issues[0][0] > 0 ? issues[0][1] : null;
}

/** 15400 -> "15 400" (sans dépendre d'Intl). */
function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
