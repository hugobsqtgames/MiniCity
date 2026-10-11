import {
  isFacility,
  isLogistics,
  isRail,
  isPlant,
  isRoadType,
  isVenue,
  isZone,
  MONUMENT_TYPES,
  SERVICE_TYPES,
  servesZones,
  LINE_TRAM,
  type MonumentType,
  type ServiceType,
  type Tile,
  type VenueType,
} from '../engine/map';
import {
  DEFAULT_FUNDING,
  DEFAULT_ORDINANCES,
  DEFAULT_TAX,
  DEFAULT_TAXES,
  EXPORT_NEEDED_AT,
  fundingOf,
  GARBAGE_PER_LEVEL,
  HOTEL_ROOMS,
  PARKING_NEEDED_AT,
  RESORT_VISITORS,
  SPEND_PER_VISITOR,
  INCOME_PER_CITIZEN,
  INCOME_PER_JOB,
  JOBS_C,
  JOBS_I,
  LANDFILL_LIMIT,
  LOGISTICS_CAPACITY,
  MONUMENT_RADIUS,
  MONUMENT_TOURISM,
  MONUMENT_UNLOCK,
  ORDINANCES,
  PLANT_POLLUTION,
  RESIDENTS,
  ROAD_ACCESS_RANGE,
  ROAD_CAPACITY,
  SERVICE_RADIUS,
  STRIKE_BELOW,
  seasonOf,
  UPKEEP,
  VENUE_TOURISM,
  WASTE_CAPACITY,
  WORKFORCE_RATIO,
  type Funding,
  type FundingKey,
  type Ordinances,
  type Taxes,
} from './constants';
import { aLieu, districtMap } from './districts';
import { applyPower, computeGrid } from './power';

export type Demand = { r: number; c: number; i: number };

/** Couverture par service, plus le tramway (TRAM) et l'enseignement supérieur (UNI). */
export type Coverage = Record<ServiceType | 'TRAM' | 'UNI', Float32Array>;

/** Politique municipale : taxes, budget des services, ordonnances. */
export type Policy = { taxes: Taxes; funding: Funding; ordinances: Ordinances };
export const DEFAULT_POLICY: Policy = { taxes: DEFAULT_TAXES, funding: DEFAULT_FUNDING, ordinances: DEFAULT_ORDINANCES };

/** Cartes de données par tuile (0-1), pour les vues thématiques et les effets visuels. */
export type CityMaps = {
  /** Congestion des routes (volume / capacité, peut dépasser 1). */
  traffic: Float32Array;
  pollution: Float32Array;
  crime: Float32Array;
  /** Pollution de l'eau (0-1) : lacs et rives. */
  water: Float32Array;
  /** Épidémie en cours (0-1) par tuile. */
  health: Float32Array;
};

/** Épidémie : quartier touché, gravité (0-100), durée écoulée. */
export type Epidemic = { district: number; severity: number; months: number };

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
  /** Électricité : production, besoin et consommation servie (MW). */
  power: { supply: number; demand: number; served: number; outOfRange: number };
  /** Industrie : emplois industriels et capacité d'export (port, gare de fret). */
  exports: { jobs: number; capacity: number; connected: number };
  /** Événements du mois (matchs, concerts, festivals…) : bonus de satisfaction. */
  eventBonus: number;
  /** Niveau d'éducation moyen des habitants (0-100) : école 40 %, lycée 35 %, université 25 %. */
  educationLevel: number;
  /** Emplois industriels par spécialité : classique, agriculture, bois, haute technologie. */
  specJobs: [number, number, number, number];
  /** Pollution moyenne des lacs (0-100). */
  waterPollution: number;
  /** Touristes accueillis ce mois-ci, et ceux qui ont trouvé un hôtel. */
  tourists: number;
  hotelGuests: number;
  /** Usagers du tramway et du train. */
  tramRiders: number;
  trainRiders: number;
  /** Commerces bloqués au niveau 2 faute de parking. */
  parkingShortage: number;
  /** Gravité de l'épidémie en cours (0 si aucune). */
  epidemic: number;
  /** Gares reliées entre elles par la voie ferrée. */
  linkedStations: number;
};

export type Weather = 'clear' | 'cloudy' | 'rain' | 'storm' | 'fog' | 'snow' | 'heat';
export const WEATHER_LABELS: Record<Weather, { icon: string; label: string }> = {
  clear: { icon: '☀️', label: 'Beau temps' },
  cloudy: { icon: '⛅', label: 'Nuageux' },
  rain: { icon: '🌧️', label: 'Pluie' },
  storm: { icon: '⛈️', label: 'Orage' },
  fog: { icon: '🌫️', label: 'Brouillard' },
  snow: { icon: '🌨️', label: 'Neige' },
  heat: { icon: '🥵', label: 'Canicule' },
};

/** Météo du mois, tirée selon la saison. */
export function rollWeather(month: number, random: () => number): Weather {
  const r = random();
  switch (seasonOf(month)) {
    case 'winter':
      return r < 0.45 ? 'snow' : r < 0.65 ? 'cloudy' : r < 0.8 ? 'fog' : 'clear';
    case 'spring':
      return r < 0.35 ? 'rain' : r < 0.5 ? 'cloudy' : r < 0.55 ? 'storm' : 'clear';
    case 'summer':
      return r < 0.25 ? 'heat' : r < 0.35 ? 'storm' : r < 0.45 ? 'cloudy' : 'clear';
    default:
      return r < 0.3 ? 'rain' : r < 0.5 ? 'fog' : r < 0.7 ? 'cloudy' : 'clear';
  }
}

export type CityEventKind = 'match' | 'concert' | 'festival' | 'market' | 'christmas' | 'fireworks';
export type CityEvent = { kind: CityEventKind; x: number; y: number; venue: VenueType | 'PARK'; bonus: number; tourism: number };
export const EVENT_LABELS: Record<CityEventKind, { icon: string; label: string }> = {
  match: { icon: '⚽', label: 'Match au stade' },
  concert: { icon: '🎸', label: 'Concert' },
  festival: { icon: '🎡', label: 'Festival d’été' },
  market: { icon: '🧺', label: 'Jour de marché' },
  christmas: { icon: '🎄', label: 'Marché de Noël' },
  fireworks: { icon: '🎆', label: 'Feu d’artifice du 14 juillet' },
};
/** Coût d'un événement organisé à la main depuis la fiche d'un lieu. */
export const EVENT_COST = 800;

/**
 * Programme des événements du mois : matchs, concerts, festivals l'été,
 * marché de Noël en décembre, feu d'artifice en juillet. `forced` = lieux où
 * le maire a organisé un événement.
 */
export function planEvents(tiles: Tile[], month: number, weather: Weather, random: () => number, forced: { x: number; y: number }[] = []): CityEvent[] {
  const out: CityEvent[] = [];
  const m = ((month % 12) + 12) % 12;
  const wet = weather === 'rain' || weather === 'storm' || weather === 'snow';
  const isForced = (t: Tile) => forced.some((f) => f.x === t.x && f.y === t.y);
  let biggest: Tile | null = null;
  for (const t of tiles) {
    if (!isVenue(t.type) || !t.powered || t.flood > 0) continue;
    const force = isForced(t);
    const p = (base: number) => force || random() < base;
    if (t.type === 'STADIUM' && p(0.5)) out.push({ kind: 'match', x: t.x, y: t.y, venue: 'STADIUM', bonus: 3, tourism: 450 });
    else if (t.type === 'ARENA' && p(0.4)) out.push({ kind: 'concert', x: t.x, y: t.y, venue: 'ARENA', bonus: 2, tourism: 300 });
    else if (t.type === 'FAIR' && p(m >= 5 && m <= 7 ? (wet ? 0.35 : 0.8) : 0.12))
      out.push({ kind: 'festival', x: t.x, y: t.y, venue: 'FAIR', bonus: 3, tourism: 380 });
    else if (t.type === 'MARKET') {
      if (m === 11) out.push({ kind: 'christmas', x: t.x, y: t.y, venue: 'MARKET', bonus: 4, tourism: 420 });
      else if (p(0.35)) out.push({ kind: 'market', x: t.x, y: t.y, venue: 'MARKET', bonus: 1, tourism: 90 });
    }
    if (!biggest || (t.type === 'STADIUM' && biggest.type !== 'STADIUM')) biggest = t;
  }
  // Feu d'artifice du 14 juillet, au-dessus du plus grand lieu (ou d'un parc).
  if (m === 6) {
    const spot = biggest ?? tiles.find((t) => t.type === 'PARK');
    if (spot) out.push({ kind: 'fireworks', x: spot.x, y: spot.y, venue: biggest ? (biggest.type as VenueType) : 'PARK', bonus: 3, tourism: 200 });
  }
  return out;
}

export type DisasterKind = 'earthquake' | 'flood' | 'tornado' | 'blackout' | 'meltdown' | 'wildfire' | 'meteor' | 'monster' | 'epidemic';
export type DisasterEvent = { kind: DisasterKind; x: number; y: number; path?: [number, number][]; damage: number };

export type NewsItem = { icon: string; text: string };

export type SimEvents = {
  newFires: number;
  destroyed: number;
  extinguished: number;
  /** Bâtiments reconstruits sur un terrain sinistré. */
  rebuilt: number;
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
  /** Mois simulé (pour la saison, la météo et les événements). */
  month?: number;
  /** Lieux où le maire a organisé un événement ce mois-ci. */
  forcedEvents?: { x: number; y: number }[];
  /** Catastrophes « fun » (météorite, monstre) autorisées au hasard. */
  funDisasters?: boolean;
  /** Épidémie en cours. */
  epidemic?: Epidemic | null;
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
  weather: Weather;
  cityEvents: CityEvent[];
  /** Analyse de fin de mois (pour les conseillers et les quartiers). */
  analysis: Analysis;
  epidemic: Epidemic | null;
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
  const cov = Object.fromEntries([...SERVICE_TYPES, 'TRAM', 'UNI'].map((s) => [s, new Float32Array(size * size)])) as Coverage;
  const stations = connectedStations(tiles, size);
  // Tramway : une ligne d'au moins 4 tuiles dessert ses abords (rayon 3).
  const tram = tiles.filter((t) => t.type === 'AVENUE' && t.line & LINE_TRAM);
  const transportF = fundingFactor(funding, 'transport');
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
    if (t.flood > 0 || t.rad > 0) continue;
    if (t.type === 'UNIVERSITY' && t.powered) {
      stamp(cov.SCHOOL, t.x, t.y, MONUMENT_RADIUS.UNIVERSITY, fundingFactor(funding, 'education'));
      stamp(cov.UNI, t.x, t.y, MONUMENT_RADIUS.UNIVERSITY, fundingFactor(funding, 'education'));
      continue;
    }
    // Une gare isolée (sans autre gare reliée par la voie ferrée) ne sert à rien.
    if (t.type === 'STATION' && !stations.has(t.y * size + t.x)) continue;
    const type = t.type as ServiceType;
    const radius = SERVICE_RADIUS[type];
    if (!radius) continue;
    const needsPower = type !== 'PARK' && type !== 'BUSSTOP' && type !== 'PARKING';
    if (needsPower && !t.powered) continue;
    if (type === 'LANDFILL' && t.garbage >= 9) continue; // décharge pleine
    const strength = fundingFactor(funding, fundingOf(type));
    if (strength <= 0) continue;
    stamp(cov[type], t.x, t.y, radius, strength);
  }
  if (tram.length >= 4 && transportF > 0) for (const t of tram) if (t.flood === 0) stamp(cov.TRAM, t.x, t.y, 3, transportF);
  return cov;
}

/** Gares reliées à au moins une autre gare par la voie ferrée (indices de tuiles). */
export function connectedStations(tiles: Tile[], size: number): Set<number> {
  const n = tiles.length;
  const comp = new Int32Array(n).fill(-1);
  const ok = new Set<number>();
  const stack: number[] = [];
  let id = 0;
  for (let i = 0; i < n; i++) {
    if (tiles[i].type !== 'STATION' || comp[i] >= 0) continue;
    const found: number[] = [];
    comp[i] = id;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      if (tiles[j].type === 'STATION') found.push(j);
      for (const nb of neighbours4(j, size, n)) {
        if (nb < 0 || comp[nb] >= 0 || !isRail(tiles[nb])) continue;
        comp[nb] = id;
        stack.push(nb);
      }
    }
    if (found.length >= 2) for (const s of found) ok.add(s);
    id++;
  }
  return ok;
}

/** Niveau d'éducation d'une tuile (0-1) : école 40 %, lycée 35 %, université 25 %. */
export const educationAt = (cov: Coverage, i: number) => Math.min(1, cov.SCHOOL[i] * 0.4 + cov.HIGHSCHOOL[i] * 0.35 + cov.UNI[i] * 0.25);

/**
 * Pollution de l'eau : les eaux usées des quartiers non raccordés à une station
 * d'épuration et les rejets industriels se déversent dans les lacs voisins.
 */
export function computeWaterPollution(tiles: Tile[], size: number, cov: Coverage): Float32Array {
  const n = tiles.length;
  const lake = new Float32Array(n);
  const R = 6;
  let any = false;
  for (const t of tiles) if (t.type === 'LAKE') any = true;
  if (!any) return lake;
  for (const t of tiles) {
    if (!isZone(t.type) || t.density === 0) continue;
    const i = t.y * size + t.x;
    const treated = cov.TREATMENT[i];
    const ind = t.type === 'I' ? (t.spec === 3 ? 0.5 : t.spec === 1 ? 2 : 3) : 0.6;
    const load = ind * t.density * (1 - treated * 0.9);
    if (load <= 0) continue;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = t.x + dx;
        const y = t.y + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const j = y * size + x;
        if (tiles[j].type !== 'LAKE') continue;
        const d = Math.hypot(dx, dy);
        if (d <= R) lake[j] += load * (1 - d / (R + 1));
      }
    }
  }
  // Normalisation, puis les rives prennent la pollution du lac le plus sale à 2 cases.
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.min(1, lake[i] / 25);
  for (let i = 0; i < n; i++) {
    if (tiles[i].type === 'LAKE') continue;
    const x = i % size;
    const y = (i - x) / size;
    let m = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const j = ny * size + nx;
        if (tiles[j].type === 'LAKE' && out[j] > m) m = out[j];
      }
    }
    out[i] = m * 0.8;
  }
  return out;
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
  /** Chemins : prochaine tuile de route vers l'emploi le plus proche (= elle-même à l'arrivée). */
  parent: Int32Array;
  /** Quartiers résidentiels : tuile, route d'accès, actifs en voiture. */
  homes: { idx: number; road: number; workers: number }[];
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
  return { congestion, commute, jobless, parent, homes };
}

/** Pollution par niveau d'une usine selon sa spécialité (classique, agriculture, bois, haute technologie). */
const SPEC_POLLUTION = [7, 2, 4, 1.5];

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
    if (t.type === 'I' && t.density > 0) emit(t.x, t.y, SPEC_POLLUTION[t.spec] * t.density, 5);
    else if (isPlant(t.type) && t.flood === 0 && PLANT_POLLUTION[t.type] > 0) emit(t.x, t.y, PLANT_POLLUTION[t.type] * (ordinances.energy ? 0.65 : 1), 6);
    else if (t.type === 'PORT') emit(t.x, t.y, 9, 4);
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
    const s = (metroOk ? 0.35 * cov.METRO[i] : 0) + (busOk ? 0.22 * cov.BUSSTOP[i] : 0) + 0.28 * cov.TRAM[i] + 0.3 * cov.STATION[i];
    share[i] = Math.min(0.75, s * bonus);
  }
  return share;
}

export type Analysis = {
  stats: CityStats;
  maps: CityMaps;
  cov: Coverage;
  traffic: TrafficResult;
  transit: Float32Array;
  pollution: Float32Array;
  /** Tuiles industrielles reliées par la route à un port ou une gare de fret. */
  exportOk: Uint8Array;
};

/**
 * Export industriel : les usines doivent être reliées par la route (même réseau
 * routier) à un port ou une gare de fret, dont la capacité est limitée.
 */
function computeExports(tiles: Tile[], size: number, transportF: number) {
  const n = tiles.length;
  const comp = new Int32Array(n).fill(-1);
  let id = 0;
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (comp[i] >= 0 || !isRoadType(tiles[i].type)) continue;
    comp[i] = id;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      for (const nb of neighbours4(j, size, n)) {
        if (nb < 0 || comp[nb] >= 0 || !isRoadType(tiles[nb].type)) continue;
        comp[nb] = id;
        stack.push(nb);
      }
    }
    id++;
  }
  const hubs = new Set<number>();
  let capacity = 0;
  for (let i = 0; i < n; i++) {
    const t = tiles[i];
    if (!isLogistics(t.type) || !t.powered || t.flood > 0) continue;
    capacity += LOGISTICS_CAPACITY[t.type] * transportF;
    for (const nb of neighbours4(i, size, n)) if (nb >= 0 && comp[nb] >= 0) hubs.add(comp[nb]);
  }
  const ok = new Uint8Array(n);
  let jobs = 0;
  let connected = 0;
  for (let i = 0; i < n; i++) {
    const t = tiles[i];
    if (t.type !== 'I') continue;
    const r = accessRoad(tiles, size, t);
    if (r >= 0 && hubs.has(comp[r])) {
      ok[i] = 1;
      if (t.density > 0) connected += JOBS_I[t.density];
    }
    if (t.density > 0) jobs += JOBS_I[t.density];
  }
  return { ok, jobs, capacity: Math.round(capacity), connected };
}

/** Analyse complète de la ville (statistiques + cartes), sans la faire évoluer. */
export function analyzeCity(tiles: Tile[], size: number, policy: Policy = DEFAULT_POLICY, month = 3, cityEvents: CityEvent[] = [], epidemic: Epidemic | null = null): Analysis {
  const { funding, ordinances, taxes } = policy;
  const cov = computeCoverage(tiles, size, funding);
  const grid = computeGrid(tiles, size, month);
  const exp = computeExports(tiles, size, fundingFactor(funding, 'transport'));
  const transit = transitShares(tiles, cov, ordinances);
  const traffic = computeTraffic(tiles, size, transit);
  const pollution = computePollution(tiles, size, ordinances, traffic.congestion);
  const crimeMap = new Float32Array(tiles.length);
  const waterMap = computeWaterPollution(tiles, size, cov);
  const healthMap = new Float32Array(tiles.length);
  if (epidemic && epidemic.severity > 0) {
    const ids = districtMap(size).ids;
    for (let i = 0; i < tiles.length; i++) if (ids[i] === epidemic.district) healthMap[i] = epidemic.severity / 100;
  }
  let eduSum = 0;
  const specJobs: [number, number, number, number] = [0, 0, 0, 0];
  let tramRiders = 0;
  let trainRiders = 0;
  let parkingShortage = 0;
  let parkingNeeded = false;

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
    else if (isPlant(t.type)) plants++;
    else if (isFacility(t.type)) services++;
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
      // Usagers répartis entre les modes selon leur poids dans la part modale de la tuile.
      const rail = 0.3 * cov.STATION[i];
      const tramS = 0.28 * cov.TRAM[i];
      const tot = 0.35 * cov.METRO[i] + 0.22 * cov.BUSSTOP[i] + tramS + rail;
      if (tot > 0) {
        const riders = residents * WORKFORCE_RATIO * transit[i];
        metroRiders += Math.round((riders * 0.35 * cov.METRO[i]) / tot);
        busRiders += Math.round((riders * 0.22 * cov.BUSSTOP[i]) / tot);
        tramRiders += Math.round((riders * tramS) / tot);
        trainRiders += Math.round((riders * rail) / tot);
      }
      pollutionR += pollution[i];
      rTiles++;
      if (traffic.commute[i] >= 0) {
        commuteSum += traffic.commute[i];
        commuteN++;
      }
      joblessWorkers += residents * WORKFORCE_RATIO * traffic.jobless[i];
      eduSum += educationAt(cov, i) * residents;
    } else if (t.type === 'C') {
      jobsC += JOBS_C[t.density];
      if (t.density >= 2 && cov.PARKING[i] === 0) parkingNeeded = true;
    } else {
      jobsI += JOBS_I[t.density];
      specJobs[t.spec] += JOBS_I[t.density];
    }

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
  let venueTourism = 0;
  let stadiums = 0;
  for (const t of tiles) {
    if (!isVenue(t.type) || !t.powered) continue;
    venueTourism += VENUE_TOURISM[t.type];
    if (t.type === 'STADIUM') stadiums++;
  }
  const eventTourism = cityEvents.reduce((s, e) => s + e.tourism, 0);
  const eventBonus = Math.min(10, cityEvents.reduce((s, e) => s + e.bonus, 0));
  // Tourisme : plages aménagées et attractions attirent des visiteurs ; sans
  // chambre d'hôtel, ce ne sont que des touristes d'un jour qui dépensent moitié moins.
  let resorts = 0;
  let hotels = 0;
  for (const t of tiles) {
    if (t.type === 'RESORT' && t.flood === 0) resorts += Math.max(0.3, 1 - waterMap[t.y * size + t.x]);
    else if (t.type === 'HOTEL' && t.powered && t.flood === 0) hotels++;
  }
  const attractions = monuments.reduce((s, m) => s + MONUMENT_TOURISM[m], 0) + venueTourism + eventTourism + resorts * RESORT_VISITORS * SPEND_PER_VISITOR;
  const tourists = population > 0 ? Math.round(attractions / SPEND_PER_VISITOR) : 0;
  const hotelGuests = Math.min(tourists, hotels * HOTEL_ROOMS);
  const tourism = Math.round((hotelGuests + (tourists - hotelGuests) * 0.5) * SPEND_PER_VISITOR);
  // Parkings : au-delà d'une certaine taille, les commerces denses en ont besoin.
  if (population >= PARKING_NEEDED_AT && parkingNeeded) {
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (t.type === 'C' && t.density >= 2 && cov.PARKING[i] === 0) parkingShortage++;
    }
  }
  let lakeSum = 0;
  let lakeN = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i].type === 'LAKE') {
      lakeSum += waterMap[i];
      lakeN++;
    }
  }
  const waterPollution = lakeN ? Math.round((lakeSum / lakeN) * 100) : 0;
  const severity = epidemic?.severity ?? 0;
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
              Math.min(6, stadiums * 4) +
              (monuments.includes('LANDMARK') ? 3 : 0) +
              eventBonus -
              severity * 0.12 -
              waterPollution * 0.05 -
              (grid.demand > grid.served + 1 && population > 0 ? Math.min(8, ((grid.demand - grid.served) / grid.demand) * 20) : 0),
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
      power: { supply: grid.supply, demand: grid.demand, served: grid.served, outOfRange: grid.outOfRange },
      exports: { jobs: exp.jobs, capacity: exp.capacity, connected: exp.connected },
      eventBonus,
      educationLevel: population > 0 ? Math.round((eduSum / population) * 100) : 0,
      specJobs,
      waterPollution,
      tourists,
      hotelGuests,
      tramRiders,
      trainRiders,
      parkingShortage,
      epidemic: Math.round(severity),
      linkedStations: connectedStations(tiles, size).size,
    },
    maps: { traffic: traffic.congestion, pollution, crime: crimeMap, water: waterMap, health: healthMap },
    cov,
    traffic,
    transit,
    pollution,
    exportOk: exp.ok,
  };
}

/** Statistiques seules (compatibilité). */
export function computeStats(tiles: Tile[], size: number, taxRate = DEFAULT_TAX, policy?: Policy): CityStats {
  // (mois par défaut : printemps)
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
    i: clamp((stats.population * 0.38 - stats.jobsI + 40) / (stats.jobsI * 0.5 + 50) - (tx.I - DEFAULT_TAX) * 0.05 + airport * 0.6 - exportPenalty(stats)),
  };
}

/** Une grande ville dont l'industrie ne peut pas exporter voit la demande industrielle chuter. */
export function exportPenalty(stats: CityStats): number {
  if (!stats.exports || stats.population < EXPORT_NEEDED_AT || stats.exports.jobs === 0) return 0;
  const shortage = 1 - Math.min(1, Math.min(stats.exports.capacity, stats.exports.connected) / stats.exports.jobs);
  return shortage * 0.6;
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
    (ordinances.trees ? 4 : 0) +
    // Les hauteurs offrent une belle vue ; une eau polluée fait fuir.
    t.elev * 3 -
    a.maps.water[idx] * 15 -
    a.maps.health[idx] * 10 -
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

function maxDensity(t: Tile, value: number, population: number, exportOk = true, edu = 1, parkingOk = true): number {
  if (t.rad > 0) return 0;
  // Sans eau courante, impossible de dépasser le niveau 1.
  if (!t.water) return 1;
  switch (t.type) {
    case 'R':
      return value >= 62 ? 3 : 2;
    case 'C': {
      // Les tours de bureaux ont besoin d'employés diplômés et, en grande ville, d'un parking.
      const tower = value >= 55 && population > 800 && (population < PARKING_NEEDED_AT || parkingOk) && (population < 1500 || edu >= 0.3);
      return tower ? 3 : population > 150 ? 2 : 1;
    }
    case 'I':
      // La haute technologie exporte par la route ou par internet ; l'agriculture reste basse.
      if (t.spec === 1) return Math.min(2, population > 250 ? 2 : 1);
      // Une usine qui ne peut pas exporter reste un petit atelier.
      if (!exportOk && t.spec !== 3 && population >= EXPORT_NEEDED_AT) return 1;
      return population > 1200 ? 3 : population > 250 ? 2 : 1;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Catastrophes
// ---------------------------------------------------------------------------

/** Détruit une tuile. Une zone garde son zonage : le quartier se reconstruira tout seul. */
const destroyTile = (t: Tile): Tile =>
  t.lake
    ? { ...t, type: 'LAKE', density: 0, fire: 0, garbage: 0, flood: 0 }
    : isZone(t.type)
      ? { ...t, density: 0, fire: 0, garbage: 0, value: -1 }
      : { ...t, type: 'DIRT', density: 0, fire: 0, garbage: 0, flood: 0 };
const destructible = (t: Tile) => (isZone(t.type) && t.density > 0) || isFacility(t.type) || isRoadType(t.type);

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
    // Les hauteurs restent au sec.
    if (t.type === 'LAKE' || t.lake || t.elev >= 1 || Math.hypot(t.x - c.x, t.y - c.y) > 7) continue;
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

function meltdown(out: Tile[], size: number, random: () => number): DisasterEvent | null {
  const plants = out.filter((t) => t.type === 'NUCLEAR');
  if (!plants.length) return null;
  const c = plants[Math.floor(random() * plants.length)];
  let damage = 0;
  for (let i = 0; i < out.length; i++) {
    const t = out[i];
    const d = Math.hypot(t.x - c.x, t.y - c.y);
    if (d > 7 || t.type === 'LAKE') continue;
    const rad = Math.max(1, Math.round(9 - d));
    if (t === c) out[i] = { ...t, type: 'DIRT', density: 0, fire: 0, flood: 0, rad: 9 };
    else out[i] = { ...t, rad: Math.max(t.rad, rad), density: isZone(t.type) ? 0 : t.density, fire: 0 };
    damage++;
  }
  return { kind: 'meltdown', x: c.x, y: c.y, damage };
}

function blackout(out: Tile[], random: () => number): DisasterEvent | null {
  const plants = out.map((t, i) => [t, i] as const).filter(([t]) => (t.type === 'POWER' || t.type === 'NUCLEAR') && t.flood === 0);
  if (!plants.length) return null;
  const [t, i] = plants[Math.floor(random() * plants.length)];
  out[i] = { ...t, flood: 3 };
  return { kind: 'blackout', x: t.x, y: t.y, damage: 1 };
}

/** Feu de forêt : démarre dans un massif et se propage aux arbres voisins. */
function wildfire(out: Tile[], random: () => number): DisasterEvent | null {
  const forests = out.filter((t) => t.type === 'FOREST' && t.fire === 0);
  if (!forests.length) return null;
  const c = forests[Math.floor(random() * forests.length)];
  let damage = 0;
  for (let i = 0; i < out.length; i++) {
    const t = out[i];
    if (t.type === 'FOREST' && Math.hypot(t.x - c.x, t.y - c.y) <= 2.2) {
      out[i] = { ...t, fire: 1 };
      damage++;
    }
  }
  return { kind: 'wildfire', x: c.x, y: c.y, damage };
}

/** Météorite : un cratère au point d'impact, des incendies tout autour. */
function meteor(out: Tile[], size: number, random: () => number): DisasterEvent {
  const x = 3 + Math.floor(random() * Math.max(1, size - 6));
  const y = 3 + Math.floor(random() * Math.max(1, size - 6));
  let damage = 0;
  for (let i = 0; i < out.length; i++) {
    const t = out[i];
    const d = Math.hypot(t.x - x, t.y - y);
    if (d > 4.5 || t.type === 'LAKE') continue;
    if (d <= 1.6) {
      // Le cratère : un trou de terre brûlée, sans bâtiment ni route.
      out[i] = { ...t, type: t.lake ? 'LAKE' : 'DIRT', density: 0, fire: 0, garbage: 0, flood: 0, line: 0, spec: 0, elev: 0, value: isZone(t.type) ? -1 : 0 };
      damage++;
    } else if (d <= 2.8 && destructible(t)) {
      out[i] = destroyTile(t);
      damage++;
    } else if ((isZone(t.type) && t.density > 0) || t.type === 'FOREST') {
      if (random() < 0.5) {
        out[i] = { ...t, fire: 1 };
        damage++;
      }
    }
  }
  return { kind: 'meteor', x, y, damage };
}

/** Monstre géant : il traverse la ville en ligne presque droite et piétine tout. */
function monster(out: Tile[], size: number, random: () => number): DisasterEvent {
  // Il sort d'un lac s'il y en a un, sinon d'un bord de la carte.
  const lakes = out.filter((t) => t.type === 'LAKE');
  const from = lakes.length ? lakes[Math.floor(random() * lakes.length)] : { x: 0, y: Math.floor(random() * size) };
  let x = from.x;
  let y = from.y;
  let dir = Math.atan2(size / 2 - y, size / 2 - x) + (random() - 0.5) * 0.6;
  const path: [number, number][] = [];
  let damage = 0;
  for (let s = 0; s < 34; s++) {
    path.push([x, y]);
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const i = ny * size + nx;
      const t = out[i];
      if (destructible(t) && random() < 0.75) {
        out[i] = random() < 0.25 && isZone(t.type) && t.density > 0 ? { ...t, fire: 1 } : destroyTile(t);
        damage++;
      }
    }
    dir += (random() - 0.5) * 0.35;
    x = Math.round(x + Math.cos(dir) * 1.3);
    y = Math.round(y + Math.sin(dir) * 1.3);
    if (x < -2 || y < -2 || x > size + 1 || y > size + 1) break;
  }
  return { kind: 'monster', x: path[0][0], y: path[0][1], path, damage };
}

export const DISASTER_LABELS: Record<DisasterKind, { icon: string; label: string }> = {
  wildfire: { icon: '🌲', label: 'Feu de forêt' },
  meteor: { icon: '☄️', label: 'Météorite' },
  monster: { icon: '🦖', label: 'Monstre géant' },
  epidemic: { icon: '🦠', label: 'Épidémie' },
  earthquake: { icon: '🌍', label: 'Séisme' },
  flood: { icon: '🌊', label: 'Inondation' },
  tornado: { icon: '🌪️', label: 'Tornade' },
  blackout: { icon: '⚡', label: 'Panne de centrale' },
  meltdown: { icon: '☢️', label: 'Accident nucléaire' },
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
  const events: SimEvents = { newFires: 0, destroyed: 0, extinguished: 0, rebuilt: 0, disasters: [], news: [] };
  const month = input.month ?? 3;
  const season = seasonOf(month);
  const weather = rollWeather(month, random);
  const transportF = fundingFactor(funding, 'transport');
  // Neige : sans chasse-neige (budget transports ≥ 80 %), la ville est paralysée.
  const snowJam = weather === 'snow' && funding.transport < 80;

  // 1. Réseaux (au cas où la carte aurait changé depuis le dernier tick).
  let tiles = applyPower(input.tiles, size, month);
  const before = analyzeCity(tiles, size, policy, month, [], input.epidemic ?? null);
  const dIds = districtMap(size).ids;
  const epi = input.epidemic && input.epidemic.severity > 0 ? input.epidemic : null;
  let forestBurnt = 0;
  let forestFires = 0;
  const cityEvents = planEvents(tiles, month, weather, random, input.forcedEvents);
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

    // Contamination : les zones restent vides, la radioactivité baisse d'un cran par an.
    if (t.rad > 0) {
      if (month % 12 === 0) out[idx] = { ...t, rad: t.rad - 1, density: 0 };
      else if (t.density > 0) out[idx] = { ...t, density: 0 };
      continue;
    }

    // Hors service (inondation, panne) : décompte des mois restants.
    if (t.flood > 0) {
      t = { ...t, flood: t.flood - 1, density: isZone(t.type) && t.density > 0 && random() < 0.15 ? t.density - 1 : t.density };
      out[idx] = t;
      continue;
    }
    // Forêts : la canicule et la foudre allument des feux qui se propagent d'arbre en arbre.
    if (t.type === 'FOREST') {
      if (t.fire > 0) {
        const cov = fireF(idx);
        if (cov > 0 && random() < 0.3 + cov * 0.45) out[idx] = { ...t, fire: 0 };
        else if (weather === 'rain' && random() < 0.5) out[idx] = { ...t, fire: 0 };
        else if (t.fire + 1 >= 3) {
          out[idx] = { ...t, type: 'DIRT', fire: 0 };
          forestBurnt++;
        } else {
          out[idx] = { ...t, fire: t.fire + 1 };
          const spread = weather === 'heat' ? 0.5 : weather === 'rain' || weather === 'snow' ? 0.08 : 0.3;
          for (const nb of neighbours4(idx, size, n)) {
            const o = nb >= 0 ? out[nb] : null;
            if (!o || o.fire > 0) continue;
            if (o.type === 'FOREST' && random() < spread) out[nb] = { ...o, fire: 1 };
            else if (isZone(o.type) && o.density > 0 && random() < 0.08) {
              out[nb] = { ...o, fire: 1 };
              events.newFires++;
            }
          }
        }
      } else if (input.disasters && (weather === 'heat' || weather === 'storm') && random() < (weather === 'heat' ? 0.00035 : 0.00015)) {
        out[idx] = { ...t, fire: 1 };
        forestFires++;
      }
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
        // Le bâtiment brûle, mais la parcelle reste zonée : il sera reconstruit.
        // (valeur -1 = parcelle sinistrée, à reconstruire en priorité)
        out[idx] = { ...t, density: 0, fire: 0, value: -1, garbage: 0 };
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
      const climate = weather === 'heat' ? 2.5 : weather === 'rain' || weather === 'snow' ? 0.4 : weather === 'storm' ? 1.5 : 1;
      const risk = 0.00022 * density * climate * (t.type === 'I' ? 3 : t.type === 'C' ? 1.5 : 1) * (1 - 0.85 * fireF(idx));
      if (random() < risk) {
        fire = 1;
        events.newFires++;
      }
    }

    if (!fire && changes < MAX_CHANGES_PER_TICK) {
      const d = t.type === 'R' ? demand.r : t.type === 'C' ? demand.c : demand.i;
      const canGrow = hasRoad && t.powered && garbage < 7;
      const edu = educationAt(before.cov, idx);
      const cap = maxDensity(t, value, before.stats.population, before.exportOk[idx] === 1, edu, before.cov.PARKING[idx] > 0);
      // Une parcelle sinistrée (déjà bâtie avant) se reconstruit en priorité.
      const ruined = density === 0 && t.value < 0 && d > -0.3;
      if (canGrow && (d > 0 || ruined) && density < cap) {
        if (random() < (ruined ? 0.35 : d * 0.18 * (0.5 + value / 100))) {
          if (ruined) events.rebuilt++;
          density++;
        }
      } else if (density > 0 && !canGrow) {
        if (random() < 0.05) density--; // abandon faute de courant, de route ou à cause des ordures
      } else if (density > cap) {
        if (random() < 0.04) density--; // plus d'eau : les immeubles se vident
      } else if (density > 0 && d < -0.25) {
        if (random() < -d * 0.04) density--; // déclin si la demande s'effondre
      }
      // Épidémie : des habitants quittent le quartier touché.
      if (epi && density > 0 && t.type === 'R' && dIds[idx] === epi.district && random() < epi.severity / 900) density--;
    }
    // Spécialité industrielle : choisie à la construction de l'usine, oubliée quand elle disparaît.
    let spec = t.spec;
    if (t.type === 'I') {
      if (density === 0) spec = 0;
      else if (t.density === 0) spec = chooseSpec(out, size, t, educationAt(before.cov, idx), before.stats.population);
    }

    // La parcelle reste marquée « sinistrée » tant qu'elle n'est pas reconstruite.
    const nextValue = t.value < 0 && density === 0 ? -1 : value;
    if (density !== t.density || nextValue !== t.value || fire !== t.fire || garbage !== t.garbage || spec !== t.spec) {
      if (density !== t.density) changes++;
      out[idx] = { ...t, density, value: nextValue, fire, garbage, spec };
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
    if (roll(0.0015)) kinds.push('meltdown');
    // Les orages favorisent les inondations.
    if (weather === 'storm' && roll(0.03)) kinds.push('flood');
    if (weather === 'heat' && roll(0.02)) kinds.push('wildfire');
    if (input.funDisasters && roll(0.002)) kinds.push('meteor');
    if (input.funDisasters && roll(0.0015)) kinds.push('monster');
  }
  let epidemic: Epidemic | null = epi ? { ...epi } : null;
  for (const kind of kinds) {
    if (kind === 'epidemic') {
      epidemic = startEpidemic(before, size, random) ?? epidemic;
      if (epidemic && !epi) {
        const d = districtMap(size).list[epidemic.district];
        events.disasters.push({ kind, x: d.cx, y: d.cy, damage: 0 });
        events.news.push({ icon: '🦠', text: `Épidémie ${aLieu(d.name)} ! Couvrez le quartier avec des hôpitaux.` });
      }
      continue;
    }
    const ev =
      kind === 'earthquake'
        ? earthquake(out, size, random)
        : kind === 'tornado'
          ? tornado(out, size, random)
          : kind === 'flood'
            ? flood(out, size, random)
            : kind === 'meltdown'
              ? meltdown(out, size, random)
              : kind === 'wildfire'
                ? wildfire(out, random)
                : kind === 'meteor'
                  ? meteor(out, size, random)
                  : kind === 'monster'
                    ? monster(out, size, random)
                    : blackout(out, random);
    if (!ev) continue;
    events.disasters.push(ev);
    const L = DISASTER_LABELS[kind];
    events.news.push({ icon: L.icon, text: `${L.label} ! ${ev.damage} tuile(s) touchée(s) près de (${ev.x}, ${ev.y}).` });
  }

  // Épidémies : naissent dans les quartiers mal soignés ou près d'une eau polluée,
  // reculent quand les hôpitaux couvrent le quartier.
  if (!epidemic && !input.trigger && input.disasters && before.stats.population >= 300) {
    const p = 0.002 + (before.stats.waterPollution / 100) * 0.01 + (1 - before.stats.coverage.health / 100) * 0.004;
    if (random() < p) {
      epidemic = startEpidemic(before, size, random);
      if (epidemic) {
        const d = districtMap(size).list[epidemic.district];
        events.disasters.push({ kind: 'epidemic', x: d.cx, y: d.cy, damage: 0 });
        events.news.push({ icon: '🦠', text: `Épidémie ${aLieu(d.name)} ! Couvrez le quartier avec des hôpitaux.` });
      }
    }
  } else if (epidemic && epi) {
    const care = districtHealth(before, size, epidemic.district);
    const sev = epidemic.severity + (care >= 0.5 ? -30 * care : 12 - care * 10) + (before.stats.waterPollution > 30 ? 4 : 0);
    epidemic = { ...epidemic, severity: Math.min(100, Math.round(sev)), months: epidemic.months + 1 };
    if (epidemic.severity <= 0 || epidemic.months >= 10) {
      events.news.push({ icon: '💉', text: 'L’épidémie est terminée. Les habitants respirent.' });
      epidemic = null;
    }
  }
  if (forestFires > 0) events.news.push({ icon: '🌲', text: `Feu de forêt ! ${forestFires} foyer(s) dans les bois.` });
  if (forestBurnt > 0) events.news.push({ icon: '🔥', text: `${forestBurnt} parcelle(s) de forêt partie(s) en fumée.` });

  tiles = applyPower(out, size, month);

  // 6. Budget : impôts R/C/I + tourisme − entretien (au prorata du budget) − ordonnances.
  const after = analyzeCity(tiles, size, policy, month, cityEvents, epidemic);
  const stats = after.stats;
  if (snowJam && stats.population > 0) {
    stats.happiness = Math.max(0, stats.happiness - 5);
    stats.commute = Math.round(stats.commute * 13) / 10;
  }
  if (weather === 'heat' && stats.population > 0) stats.happiness = Math.max(0, stats.happiness - 2);
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
    // L'hiver, chauffer les bâtiments publics coûte plus cher.
    const heating = season === 'winter' && key === 'utilities' ? 1.2 : 1;
    expenses += base * heating * (key ? funding[key] / 100 : 1);
  }
  void transportF;
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
  if (events.rebuilt > 0) events.news.push({ icon: '🏗️', text: `Reconstruction : ${events.rebuilt} bâtiment(s) relevé(s).` });
  for (const e of cityEvents) events.news.push({ icon: EVENT_LABELS[e.kind].icon, text: `${EVENT_LABELS[e.kind].label} : +${e.tourism} $ de tourisme.` });
  if (snowJam) events.news.push({ icon: '🌨️', text: 'Routes enneigées : sans chasse-neige (budget transports ≥ 80 %), la ville tourne au ralenti.' });
  if (weather === 'heat') events.news.push({ icon: '🥵', text: 'Canicule : risque d’incendie élevé.' });
  if (stats.power.demand > stats.power.served + 1 && stats.power.supply > 0) events.news.push({ icon: '🔌', text: `Délestage : ${stats.power.demand - stats.power.served} MW non servis. Construisez des centrales.` });
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
    weather,
    cityEvents,
    analysis: after,
    epidemic,
  };
}

/** Choisit la spécialité d'une nouvelle usine selon son environnement. */
function chooseSpec(tiles: Tile[], size: number, t: Tile, edu: number, population: number): number {
  if (edu >= 0.55 && population >= 1000) return 3;
  let forest = 0;
  let urban = 0;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const x = t.x + dx;
      const y = t.y + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const o = tiles[y * size + x];
      if (o.type === 'FOREST') forest++;
      else if ((o.type === 'R' || o.type === 'C') && o.density > 0) urban++;
    }
  }
  if (forest >= 4) return 2;
  if (urban === 0) return 1;
  return 0;
}

/** Couverture santé moyenne des habitations d'un quartier (0-1). */
function districtHealth(a: Analysis, size: number, district: number): number {
  const ids = districtMap(size).ids;
  let sum = 0;
  let count = 0;
  for (const h of a.traffic.homes) {
    if (ids[h.idx] !== district) continue;
    sum += a.cov.HOSPITAL[h.idx] > 0 ? 1 : 0;
    count++;
  }
  return count ? sum / count : 0;
}

/** Démarre une épidémie dans le quartier le plus peuplé parmi les moins bien soignés. */
function startEpidemic(a: Analysis, size: number, random: () => number): Epidemic | null {
  const dm = districtMap(size);
  const pop = new Float32Array(dm.list.length);
  for (const h of a.traffic.homes) pop[dm.ids[h.idx]] += h.workers + 1;
  const score = dm.list.map((d) => pop[d.id] * (1.2 - districtHealth(a, size, d.id)));
  const candidates = dm.list.filter((d) => pop[d.id] > 0).sort((p, q) => score[q.id] - score[p.id]);
  if (!candidates.length) return null;
  const pick = candidates[Math.min(candidates.length - 1, Math.floor(random() * Math.min(2, candidates.length)))];
  return { district: pick.id, severity: 25, months: 0 };
}

export const MONUMENT_NAMES: Record<MonumentType, string> = {
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
