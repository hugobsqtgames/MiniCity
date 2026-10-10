import { PaintStyle, Skia, type SkCanvas, type SkPathBuilder } from '@shopify/react-native-skia';

import { getOrigin, HALF_H, HALF_W } from './iso';
import { isZone, type Tile } from './map';
import { shade } from './palette';
import { isIntersection, LIGHT_GREEN, LIGHT_PERIOD, LIGHT_RED, LIGHT_YELLOW, lightOffset, lightState, mod } from './traffic';
import { buildingHeight } from './renderer';

/**
 * PNJ : la population de la ville rendue visible.
 *
 * - Thread JS : quand le réseau routier, la population ou les incidents changent,
 *   on calcule les itinéraires. Les voitures font des trajets domicile → travail
 *   (plus court chemin sur le graphe des routes), les camions desservent
 *   l'industrie, la police patrouille autour du commissariat, les pompiers
 *   foncent vers les incendies. Le nombre d'agents suit la population.
 * - Thread UI : `drawAgents` (worklet) interpole chaque image la position de
 *   chaque agent sur sa boucle et dessine des véhicules en 3D (carrosserie,
 *   habitacle vitré, roues, phares) avec élimination des faces cachées.
 */

export const AGENT_CAR = 0;
export const AGENT_PED = 1;
export const AGENT_TRUCK = 2;
export const AGENT_POLICE = 3;
export const AGENT_FIRETRUCK = 4;
export const AGENT_BUS = 5;
export const AGENT_AMBULANCE = 6;

export type Agent = {
  kind: number;
  /** Polyligne fermée, en coordonnées de grille flottantes (centre de tuile = x + 0.5). */
  gx: number[];
  gy: number[];
  /** Longueurs cumulées (en tuiles) à chaque point. */
  cum: number[];
  total: number;
  /**
   * Horaire de la boucle : à l'instant kt[k] (s) l'agent est à la distance kd[k].
   * Entre deux clés il roule à vitesse constante ; deux clés à la même distance
   * = arrêt (feu rouge, file d'attente).
   */
  kt: number[];
  kd: number[];
  /** Durée d'un tour complet (multiple du cycle des feux pour que l'horaire se répète). */
  loopT: number;
  /** Décalage de départ (s). */
  phase: number;
  color: number;
};

/** Feu tricolore affiché au centre d'un carrefour. */
export type TrafficLight = { gx: number; gy: number; offset: number };
/** Ligne de métro souterraine entre deux stations (coordonnées de grille). */
export type MetroLine = { ax: number; ay: number; bx: number; by: number };

/** Foyers d'incendie à animer (flammes + fumée). */
export type FireSpot = { gx: number; gy: number; seed: number; z: number };

export const CAR_COLORS = ['#e74c3c', '#ecf0f1', '#3498db', '#f39c12', '#8e44ad', '#2c3e50', '#16a085', '#d35400'];
export const SHIRT_COLORS = ['#e67e22', '#9b59b6', '#3498db', '#e74c3c', '#ecf0f1', '#1abc9c'];

/** Tables de teintes précalculées côté JS (le worklet ne fait que les lire). */
const BODY = [...CAR_COLORS, '#f5f5f5', '#c0392b', '#f1c40f', '#ecf0f1', '#ffffff'];
const COLOR_POLICE = CAR_COLORS.length;
const COLOR_FIRE = CAR_COLORS.length + 1;
const COLOR_BUS = CAR_COLORS.length + 2;
const COLOR_TRUCK = CAR_COLORS.length + 3;
const COLOR_AMBULANCE = CAR_COLORS.length + 4;
const BODY_LIGHT = BODY.map((c) => shade(c, 0.25));
const BODY_MID = BODY.map((c) => shade(c, -0.15));
const BODY_DARK = BODY.map((c) => shade(c, -0.45));

const MAX_CARS = 110;
const MAX_PEDS = 140;
const CAR_LANE = 0.2;
const SIDEWALK = 0.4;
/** Le véhicule s'arrête à cette fraction du segment qui entre dans le carrefour (avant le passage piéton). */
const STOP_AT = 0.24;


/** Générateur pseudo-aléatoire déterministe (mêmes routes = mêmes trajets). */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Clé de recalcul : routes, services, incendies et population (par paliers). */
export function agentsSignature(tiles: Tile[], population: number): string {
  let h = 2166136261;
  let roads = 0;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (t.type === 'ROAD') {
      h = Math.imul(h ^ i, 16777619);
      roads++;
    } else if (t.type === 'POLICE' || t.type === 'FIRE' || t.type === 'METRO' || t.fire > 0) {
      h = Math.imul(h ^ (i * 31 + t.type.length + t.fire), 16777619);
    }
  }
  // Population par paliers de +25 % : on ne recalcule pas le trafic à chaque nouvel habitant.
  const bucket = population > 0 ? Math.floor(Math.log(population) / Math.log(1.25)) : -1;
  return `${roads}:${h >>> 0}:${bucket}`;
}

const neighbours4 = (i: number, size: number, n: number) => {
  const x = i % size;
  return [x + 1 < size ? i + 1 : -1, x > 0 ? i - 1 : -1, i + size < n ? i + size : -1, i - size];
};

function randomWalk(start: number, size: number, isRoad: Uint8Array, maxLen: number, rand: () => number): number[] {
  const seq = [start];
  let prev = -1;
  let cur = start;
  for (let k = 0; k < maxLen; k++) {
    const options = neighbours4(cur, size, isRoad.length).filter((n) => n >= 0 && isRoad[n] && n !== prev);
    if (options.length === 0) break;
    // Préférence pour aller tout droit : moins de zigzags, trajets plus crédibles.
    const straight = prev >= 0 ? cur + (cur - prev) : -1;
    const next = options.includes(straight) && rand() < 0.65 ? straight : options[Math.floor(rand() * options.length)];
    seq.push(next);
    prev = cur;
    cur = next;
  }
  return seq;
}

/** Plus court chemin (BFS) sur les routes entre deux tuiles de route. */
function roadPath(from: number, to: number, size: number, isRoad: Uint8Array, maxLen = 80): number[] | null {
  if (from === to) return null;
  const prev = new Int32Array(isRoad.length).fill(-1);
  prev[from] = from;
  const queue = [from];
  for (let h = 0; h < queue.length; h++) {
    const cur = queue[h];
    if (cur === to) break;
    for (const n of neighbours4(cur, size, isRoad.length)) {
      if (n < 0 || !isRoad[n] || prev[n] !== -1) continue;
      prev[n] = cur;
      queue.push(n);
    }
  }
  if (prev[to] === -1) return null;
  const path = [to];
  while (path[path.length - 1] !== from) {
    path.push(prev[path[path.length - 1]]);
    if (path.length > maxLen) return null;
  }
  return path.reverse();
}

/** Points décalés d'un côté de la chaussée pour une suite de tuiles. */
function offsetPolyline(seq: number[], size: number, k: number): [number[], number[]] {
  const gx: number[] = [];
  const gy: number[] = [];
  for (let i = 0; i + 1 < seq.length; i++) {
    const ax = (seq[i] % size) + 0.5;
    const ay = Math.floor(seq[i] / size) + 0.5;
    const bx = (seq[i + 1] % size) + 0.5;
    const by = Math.floor(seq[i + 1] / size) + 0.5;
    // Perpendiculaire "à droite" du sens de marche (en espace grille).
    const px = -(by - ay) * k;
    const py = (bx - ax) * k;
    gx.push(ax + px, bx + px);
    gy.push(ay + py, by + py);
  }
  return [gx, gy];
}

type Draft = {
  kind: number;
  gx: number[];
  gy: number[];
  cum: number[];
  total: number;
  speed: number;
  phase: number;
  color: number;
  /** Les véhicules d'urgence grillent les feux. */
  emergency: boolean;
  /** Arrivées aux carrefours : distance de la ligne d'arrêt, feu et axe concernés. */
  events: { d: number; light: number; axis: number; offset: number }[];
  /** Tronçons orientés (tuile de départ -> tuile d'arrivée) = voies, et distance de leur début. */
  pairKeys: number[];
  pairStart: number[];
};

function closeLoop(gx: number[], gy: number[]) {
  gx.push(gx[0]);
  gy.push(gy[0]);
  const cum = [0];
  for (let i = 1; i < gx.length; i++) cum.push(cum[i - 1] + Math.hypot(gx[i] - gx[i - 1], gy[i] - gy[i - 1]));
  return { cum, total: cum[cum.length - 1] };
}

/** Piéton : vitesse constante, pas de feux. */
function pedestrian(gx: number[], gy: number[], speed: number, rand: () => number, color: number): Agent {
  const { cum, total } = closeLoop(gx, gy);
  const loopT = total / speed;
  return { kind: AGENT_PED, gx, gy, cum, total, kt: [0, loopT], kd: [0, total], loopT, phase: rand() * loopT, color };
}

/**
 * Véhicule qui fait l'aller-retour sur un trajet, voie de droite dans les deux
 * sens. On note chaque entrée dans un carrefour pour y placer un arrêt au feu.
 */
function vehicle(
  kind: number,
  seq: number[],
  size: number,
  speed: number,
  rand: () => number,
  color: number,
  inter: Uint8Array,
): Draft {
  const back = seq.slice().reverse();
  const [fx, fy] = offsetPolyline(seq, size, CAR_LANE);
  const [bx, by] = offsetPolyline(back, size, CAR_LANE);
  const gx = fx.concat(bx);
  const gy = fy.concat(by);
  const { cum, total } = closeLoop(gx, gy);
  const events: Draft['events'] = [];
  const pairKeys: number[] = [];
  const pairStart: number[] = [];
  const pairs = [...seq.slice(0, -1).map((a, i) => [a, seq[i + 1]]), ...back.slice(0, -1).map((a, i) => [a, back[i + 1]])];
  pairs.forEach(([a, b], g) => {
    pairKeys.push(a * 4096 + b);
    pairStart.push(cum[2 * g]);
    if (!inter[b]) return;
    const segStart = cum[2 * g];
    const segLen = cum[2 * g + 1] - segStart;
    events.push({ d: segStart + segLen * STOP_AT, light: b, axis: Math.abs(b - a) === 1 ? 0 : 1, offset: lightOffset(b) });
  });
  const emergency = kind === AGENT_FIRETRUCK || kind === AGENT_AMBULANCE;
  return { kind, gx, gy, cum, total, speed, phase: 0, color, emergency, events, pairKeys, pairStart };
}

/** Pas de temps de la micro-simulation et fréquence d'enregistrement des trajectoires. */
const DT = 0.125;
const SAMPLE_EVERY = 3;
/** Distance minimale entre deux véhicules (centre à centre, en tuiles) et zone de freinage. */
const MIN_GAP = 0.46;
const BRAKE_ZONE = 0.6;

/**
 * Micro-simulation du trafic, sur une période H commune à tous les véhicules
 * (multiple du cycle des feux) :
 *  - chaque véhicule suit celui qui le précède sur sa voie (distance de sécurité,
 *    freinage progressif) ;
 *  - il freine et s'arrête au feu rouge, repart au vert ;
 *  - les véhicules d'urgence (pompiers, ambulances) grillent les feux et doublent.
 * Chaque véhicule part de chez lui à une heure donnée, fait l'aller-retour puis
 * rentre "au garage" jusqu'au tour suivant. On simule deux périodes et on garde
 * la seconde (trafic établi) : la trajectoire enregistrée se rejoue ensuite en
 * boucle sur le thread UI, parfaitement synchronisée avec les feux affichés.
 */
function simulateTraffic(drafts: Draft[], rand: () => number): Agent[] {
  const n = drafts.length;
  if (n === 0) return [];
  const free = drafts.map((d) => d.total / d.speed);
  const H = Math.min(LIGHT_PERIOD * 20, Math.max(LIGHT_PERIOD * 6, Math.ceil((Math.max(...free) * 1.4 + 6) / LIGHT_PERIOD) * LIGHT_PERIOD));
  // Plusieurs trajets par période pour les trajets courts : la densité du trafic suit la population.
  const trips = drafts.map((_, i) => Math.max(1, Math.floor(H / (free[i] * 1.5 + 4))));
  const dep = drafts.map(() => rand() * H);
  const isDeparture = (i: number, t: number) => {
    const slot = H / trips[i];
    return mod(t - dep[i], slot) < DT * 0.999;
  };
  const d = new Float64Array(n);
  const pair = new Int32Array(n);
  const ev = new Int32Array(n);
  const active = new Uint8Array(n);
  const kt: number[][] = drafts.map(() => []);
  const kd: number[][] = drafts.map(() => []);
  const occ = new Map<number, number[]>();
  const next = new Float64Array(n);
  // On simule 3 périodes et on enregistre la dernière (trafic établi).
  const recordFrom = 2 * H;
  const steps = Math.round((3 * H) / DT);

  for (let step = 0; step < steps; step++) {
    const t = step * DT;
    const rec = t >= recordFrom;
    const tau = t - recordFrom;
    if (step === Math.round(recordFrom / DT)) {
      for (let i = 0; i < n; i++) {
        kt[i].push(0);
        kd[i].push(active[i] ? d[i] : drafts[i].total);
      }
    }
    // Départs (le véhicule sort du garage).
    for (let i = 0; i < n; i++) {
      if (active[i] || !isDeparture(i, t)) continue;
      active[i] = 1;
      d[i] = 0;
      pair[i] = 0;
      ev[i] = 0;
      if (rec) {
        kt[i].push(tau, tau);
        kd[i].push(drafts[i].total, 0);
      }
    }
    // Occupation des voies (tronçon orienté tuile -> tuile).
    occ.clear();
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      const key = drafts[i].pairKeys[pair[i]];
      const list = occ.get(key);
      if (list) list.push(i);
      else occ.set(key, [i]);
    }
    // Vitesses : suivi du véhicule de devant + feux.
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      const dr = drafts[i];
      let v = dr.speed;
      if (!dr.emergency) {
        let gap = Infinity;
        const j = pair[i];
        const mine = d[i] - dr.pairStart[j];
        for (const o of occ.get(dr.pairKeys[j]) ?? []) {
          if (o === i) continue;
          const theirs = d[o] - drafts[o].pairStart[pair[o]];
          if (theirs > mine || (theirs === mine && o < i)) gap = Math.min(gap, theirs - mine);
        }
        if (j + 1 < dr.pairKeys.length) {
          const rem = dr.pairStart[j + 1] - d[i];
          for (const o of occ.get(dr.pairKeys[j + 1]) ?? []) gap = Math.min(gap, rem + d[o] - drafts[o].pairStart[pair[o]]);
        }
        // Feu : la ligne d'arrêt agit comme un véhicule arrêté tant que le feu n'est pas vert.
        const e = dr.events[ev[i]];
        if (e && e.d - d[i] < 1.2) {
          const state = lightState(t, e.offset, e.axis);
          const close = e.d - d[i] < 0.15;
          if (state === LIGHT_RED || (state === LIGHT_YELLOW && !close)) gap = Math.min(gap, e.d - d[i] + MIN_GAP);
        }
        if (gap <= MIN_GAP) v = 0;
        else if (gap < MIN_GAP + BRAKE_ZONE) v = (dr.speed * (gap - MIN_GAP)) / BRAKE_ZONE;
      }
      next[i] = Math.min(dr.total, d[i] + v * DT);
    }
    // Avancement + enregistrement.
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      const dr = drafts[i];
      d[i] = next[i];
      while (pair[i] + 1 < dr.pairStart.length && d[i] >= dr.pairStart[pair[i] + 1]) pair[i]++;
      while (ev[i] < dr.events.length && d[i] > dr.events[ev[i]].d + 0.05) ev[i]++;
      if (d[i] >= dr.total) active[i] = 0; // arrivé : retour au garage
      if (rec && (step % SAMPLE_EVERY === 0 || !active[i])) {
        kt[i].push(tau + DT);
        kd[i].push(d[i]);
      }
    }
  }

  return drafts.map((dr, i) => {
    kt[i].push(H);
    kd[i].push(active[i] ? d[i] : dr.total);
    return { kind: dr.kind, gx: dr.gx, gy: dr.gy, cum: dr.cum, total: dr.total, kt: kt[i], kd: kd[i], loopT: H, phase: 0, color: dr.color };
  });
}

/** Routes qui bordent au moins une tuile satisfaisant `pred`. */
function roadsNear(tiles: Tile[], roads: number[], size: number, pred: (t: Tile) => boolean): number[] {
  return roads.filter((i) => neighbours4(i, size, tiles.length).some((n) => n >= 0 && pred(tiles[n])));
}

/** Route la plus proche (à vol d'oiseau) d'une tuile, dans un rayon de 3. */
function nearestRoad(tiles: Tile[], size: number, isRoad: Uint8Array, x: number, y: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const i = ny * size + nx;
      const d = Math.abs(dx) + Math.abs(dy);
      if (isRoad[i] && d < bestD) {
        bestD = d;
        best = i;
      }
    }
  }
  return best;
}

export type AgentsScene = { agents: Agent[]; fires: FireSpot[]; lights: TrafficLight[]; metro: MetroLine[] };

/** Lignes de métro : chaque station reliée à la plus proche (comme sur la carte du réseau). */
function metroLines(tiles: Tile[]): MetroLine[] {
  const stations = tiles.filter((t) => t.type === 'METRO' && t.powered);
  const lines: MetroLine[] = [];
  const seen = new Set<string>();
  for (const a of stations) {
    let best: Tile | null = null;
    let bestD = Infinity;
    for (const b of stations) {
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (b !== a && d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (!best) continue;
    const key = [a.x, a.y, best.x, best.y].sort().join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push({ ax: a.x + 0.5, ay: a.y + 0.5, bx: best.x + 0.5, by: best.y + 0.5 });
  }
  return lines;
}

/**
 * Construit les PNJ pour la carte courante. Le nombre de voitures et de piétons
 * est proportionnel à la population ; les usagers du métro ne prennent pas la voiture.
 */
export function buildAgents(tiles: Tile[], size: number, population: number, metroRiders = 0): AgentsScene {
  const fires: FireSpot[] = tiles
    .filter((t) => t.fire > 0)
    .map((t, k) => ({ gx: t.x + 0.5, gy: t.y + 0.5, seed: k * 1.7, z: Math.max(6, buildingHeight(t) - 6) }));
  const isRoad = new Uint8Array(tiles.length);
  const roads: number[] = [];
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i].type !== 'ROAD') continue;
    isRoad[i] = 1;
    roads.push(i);
  }
  const metro = metroLines(tiles);
  if (roads.length < 2) return { agents: [], fires, lights: [], metro };

  // Carrefours (≥ 3 routes) : chacun a ses feux tricolores.
  const inter = new Uint8Array(tiles.length);
  const lights: TrafficLight[] = [];
  for (const i of roads) {
    if (!isIntersection((n) => isRoad[n] === 1, i, size, tiles.length)) continue;
    inter[i] = 1;
    lights.push({ gx: (i % size) + 0.5, gy: Math.floor(i / size) + 0.5, offset: lightOffset(i) });
  }

  const rand = mulberry32(roads.length * 7919 + population);
  const drafts: Draft[] = [];
  const agents: Agent[] = [];
  const built = (t: Tile) => isZone(t.type) && t.density > 0 && t.fire === 0;
  const homes = roadsNear(tiles, roads, size, (t) => t.type === 'R' && built(t));
  const jobs = roadsNear(tiles, roads, size, (t) => (t.type === 'C' || t.type === 'I') && built(t));
  const factories = roadsNear(tiles, roads, size, (t) => t.type === 'I' && built(t));
  const shops = roadsNear(tiles, roads, size, (t) => t.type === 'C' && built(t));
  const pick = (list: number[]) => list[Math.floor(rand() * list.length)];

  // Vitesses presque identiques par type : les véhicules ne se « traversent » pas sur une même voie.
  // 1. Navetteurs : environ une voiture pour 35 habitants qui ne prennent pas le métro.
  const drivers = Math.max(0, population - metroRiders);
  const cars = Math.min(MAX_CARS, Math.round(2 + drivers / 35));
  for (let c = 0; c < cars; c++) {
    let seq: number[] | null = null;
    if (homes.length && jobs.length) seq = roadPath(pick(homes), pick(jobs), size, isRoad);
    seq ??= randomWalk(pick(roads), size, isRoad, 20, rand);
    if (seq.length < 2) continue;
    drafts.push(vehicle(AGENT_CAR, seq, size, 1.5 + rand() * 0.1, rand, Math.floor(rand() * CAR_COLORS.length), inter));
  }

  // 2. Camions de livraison : usines → commerces.
  const trucks = factories.length ? Math.min(18, Math.round(factories.length / 4)) : 0;
  for (let k = 0; k < trucks; k++) {
    const seq = (shops.length && roadPath(pick(factories), pick(shops), size, isRoad)) || randomWalk(pick(factories), size, isRoad, 16, rand);
    if (seq.length < 2) continue;
    drafts.push(vehicle(AGENT_TRUCK, seq, size, 1.35, rand, COLOR_TRUCK, inter));
  }

  // 3. Bus : une ligne par tranche de 1 500 habitants.
  const buses = Math.min(6, Math.floor(population / 1500));
  for (let k = 0; k < buses; k++) {
    const seq = randomWalk(pick(homes.length ? homes : roads), size, isRoad, 30, rand);
    if (seq.length < 4) continue;
    drafts.push(vehicle(AGENT_BUS, seq, size, 1.3, rand, COLOR_BUS, inter));
  }

  // 4. Police : deux patrouilles par commissariat alimenté.
  for (const st of tiles) {
    if (st.type !== 'POLICE' || !st.powered) continue;
    const start = nearestRoad(tiles, size, isRoad, st.x, st.y);
    if (start < 0) continue;
    for (let k = 0; k < 2; k++) {
      const seq = randomWalk(start, size, isRoad, 18, rand);
      if (seq.length >= 2) drafts.push(vehicle(AGENT_POLICE, seq, size, 1.55, rand, COLOR_POLICE, inter));
    }
  }

  // 5. Pompiers : un camion de la caserne la plus proche vers chaque incendie.
  const stations = tiles.filter((t) => t.type === 'FIRE' && t.powered);
  for (const f of fires.slice(0, 8)) {
    const target = nearestRoad(tiles, size, isRoad, Math.floor(f.gx), Math.floor(f.gy));
    if (target < 0 || !stations.length) continue;
    const st = stations.reduce((a, b) => (Math.hypot(a.x - f.gx, a.y - f.gy) < Math.hypot(b.x - f.gx, b.y - f.gy) ? a : b));
    const from = nearestRoad(tiles, size, isRoad, st.x, st.y);
    const seq = from >= 0 ? roadPath(from, target, size, isRoad) : null;
    if (seq && seq.length >= 2) drafts.push(vehicle(AGENT_FIRETRUCK, seq, size, 2.2, rand, COLOR_FIRE, inter));
  }

  // 6. Ambulances : deux par hôpital alimenté, qui vont chercher des patients dans les quartiers.
  for (const h of tiles) {
    if (h.type !== 'HOSPITAL' || !h.powered || !homes.length) continue;
    const from = nearestRoad(tiles, size, isRoad, h.x, h.y);
    if (from < 0) continue;
    for (let k = 0; k < 2; k++) {
      const seq = roadPath(from, pick(homes), size, isRoad);
      if (seq && seq.length >= 2) drafts.push(vehicle(AGENT_AMBULANCE, seq, size, 2, rand, COLOR_AMBULANCE, inter));
    }
  }

  // 7. Piétons : un pour 30 habitants, sur les trottoirs des quartiers habités.
  const sidewalks = roadsNear(tiles, roads, size, (t) => (t.type === 'R' || t.type === 'C' || t.type === 'PARK' || t.type === 'METRO') && (t.type === 'PARK' || t.type === 'METRO' || built(t)));
  const peds = sidewalks.length ? Math.min(MAX_PEDS, Math.round(population / 30)) : 0;
  for (let p = 0; p < peds; p++) {
    const seq = randomWalk(pick(sidewalks), size, isRoad, 4 + Math.floor(rand() * 6), rand);
    if (seq.length < 2) continue;
    // Toujours sur le même trottoir : l'aller et le retour réutilisent les mêmes points.
    const [fx, fy] = offsetPolyline(seq, size, rand() < 0.5 ? SIDEWALK : -SIDEWALK);
    agents.push(pedestrian(fx.concat(fx.slice().reverse()), fy.concat(fy.slice().reverse()), 0.22 + rand() * 0.18, rand, Math.floor(rand() * SHIRT_COLORS.length)));
  }
  return { agents: simulateTraffic(drafts, rand).concat(agents), fires, lights, metro };
}

/** Rectangle visible, en coordonnées monde. */
export type ViewRect = { x0: number; y0: number; x1: number; y1: number };

type Builders = {
  shadows: SkPathBuilder;
  light: SkPathBuilder[];
  mid: SkPathBuilder[];
  dark: SkPathBuilder[];
  glass: SkPathBuilder;
  glassDark: SkPathBuilder;
  wheels: SkPathBuilder;
  headlights: SkPathBuilder;
  red: SkPathBuilder;
  blue: SkPathBuilder;
  /** Faces jetées (non dessinées). */
  scrap: SkPathBuilder;
};

/**
 * Boîte 3D orientée (en espace grille) projetée en isométrique, avec élimination
 * des faces arrière : seules les faces tournées vers la caméra sont ajoutées.
 */
function addBox(
  top: SkPathBuilder,
  left: SkPathBuilder,
  right: SkPathBuilder,
  ox: number,
  oy: number,
  z0: number,
  z1: number,
  ux: number,
  uy: number,
  L0: number,
  L1: number,
  W: number,
  originX: number,
  originY: number,
) {
  'worklet';
  const vx = -uy;
  const vy = ux;
  // Coins dans l'ordre : arrière-droit, avant-droit, avant-gauche, arrière-gauche.
  const cgx = [ox + ux * L0 + vx * W, ox + ux * L1 + vx * W, ox + ux * L1 - vx * W, ox + ux * L0 - vx * W];
  const cgy = [oy + uy * L0 + vy * W, oy + uy * L1 + vy * W, oy + uy * L1 - vy * W, oy + uy * L0 - vy * W];
  const px = [0, 0, 0, 0];
  const py = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    px[k] = originX + (cgx[k] - cgy[k]) * HALF_W;
    py[k] = originY + (cgx[k] + cgy[k]) * HALF_H;
  }
  for (let k = 0; k < 4; k++) {
    const n = (k + 1) % 4;
    // Normale sortante de l'arête (k -> n) en espace grille ; visible si elle pointe
    // vers le spectateur (+x ou +y de la grille, c'est-à-dire vers le bas de l'écran).
    const ex = cgx[n] - cgx[k];
    const ey = cgy[n] - cgy[k];
    const nx = ey;
    const ny = -ex;
    if (nx + ny <= 0.0001) continue;
    // Face tournée vers +x (sud-est) plus sombre que celle tournée vers +y (sud-ouest).
    const target = nx > ny ? right : left;
    target.addPoly(
      [
        { x: px[k], y: py[k] - z0 },
        { x: px[n], y: py[n] - z0 },
        { x: px[n], y: py[n] - z1 },
        { x: px[k], y: py[k] - z1 },
      ],
      true,
    );
  }
  top.addPoly(
    [
      { x: px[0], y: py[0] - z1 },
      { x: px[1], y: py[1] - z1 },
      { x: px[2], y: py[2] - z1 },
      { x: px[3], y: py[3] - z1 },
    ],
    true,
  );
}

/**
 * Dessine les agents visibles à l'instant `timeMs`. Worklet : s'exécute sur le
 * thread UI. Les agents hors de `view` sont ignorés (culling).
 */
export function drawAgents(canvas: SkCanvas, scene: AgentsScene, timeMs: number, gridSize: number, view: ViewRect) {
  'worklet';
  const { originX, originY } = getOrigin(gridSize);
  const t = timeMs / 1000;
  const nColors = BODY.length;
  const b: Builders = {
    shadows: Skia.PathBuilder.Make(),
    light: [],
    mid: [],
    dark: [],
    glass: Skia.PathBuilder.Make(),
    glassDark: Skia.PathBuilder.Make(),
    wheels: Skia.PathBuilder.Make(),
    headlights: Skia.PathBuilder.Make(),
    red: Skia.PathBuilder.Make(),
    blue: Skia.PathBuilder.Make(),
    scrap: Skia.PathBuilder.Make(),
  };
  for (let c = 0; c < nColors; c++) {
    b.light.push(Skia.PathBuilder.Make());
    b.mid.push(Skia.PathBuilder.Make());
    b.dark.push(Skia.PathBuilder.Make());
  }
  const shirts = SHIRT_COLORS.map(() => Skia.PathBuilder.Make());
  const heads = Skia.PathBuilder.Make();
  const blink = Math.floor(t * 4) % 2 === 0;

  // Tri par profondeur (gx + gy) : les véhicules du premier plan recouvrent ceux de derrière.
  const visible: { a: number; gx: number; gy: number; ux: number; uy: number; depth: number; stopped: boolean }[] = [];
  for (let a = 0; a < scene.agents.length; a++) {
    const ag = scene.agents[a];
    // Position selon l'horaire (arrêts aux feux compris).
    const tm = mod(t + ag.phase, ag.loopT);
    let k = 0;
    while (k < ag.kt.length - 2 && ag.kt[k + 1] <= tm) k++;
    const span = ag.kt[k + 1] - ag.kt[k];
    const stopped = ag.kd[k + 1] === ag.kd[k];
    // Pause en fin de tour : le véhicule est "au garage" (arrivé chez lui ou au travail), on ne le dessine pas.
    if (stopped && ag.kd[k] === ag.total && ag.kind !== AGENT_PED) continue;
    let d = span > 0 ? ag.kd[k] + ((ag.kd[k + 1] - ag.kd[k]) * (tm - ag.kt[k])) / span : ag.kd[k];
    if (d >= ag.total) d = 0;
    let i = 0;
    while (i < ag.cum.length - 2 && ag.cum[i + 1] < d) i++;
    const segLen = ag.cum[i + 1] - ag.cum[i] || 1;
    const f = (d - ag.cum[i]) / segLen;
    const dx = ag.gx[i + 1] - ag.gx[i];
    const dy = ag.gy[i + 1] - ag.gy[i];
    const gx = ag.gx[i] + dx * f;
    const gy = ag.gy[i] + dy * f;
    const wx = originX + (gx - gy) * HALF_W;
    const wy = originY + (gx + gy) * HALF_H;
    if (wx < view.x0 || wx > view.x1 || wy < view.y0 || wy > view.y1) continue;
    const len = Math.hypot(dx, dy) || 1;
    visible.push({ a, gx, gy, ux: dx / len, uy: dy / len, depth: gx + gy, stopped });
  }
  visible.sort((p, q) => p.depth - q.depth);

  // Feux tricolores : deux poteaux par carrefour (un par axe), lampe allumée selon le cycle.
  const lamps = [Skia.PathBuilder.Make(), Skia.PathBuilder.Make(), Skia.PathBuilder.Make()];
  const poles = Skia.PathBuilder.Make();
  const lightHeads = Skia.PathBuilder.Make();
  for (const L of scene.lights) {
    const cx = originX + (L.gx - L.gy) * HALF_W;
    const cy = originY + (L.gx + L.gy) * HALF_H;
    if (cx < view.x0 || cx > view.x1 || cy < view.y0 || cy > view.y1) continue;
    for (let axis = 0; axis < 2; axis++) {
      // Poteau au coin du carrefour, côté droit de la voie qui arrive.
      const ox = axis === 0 ? -0.46 : 0.46;
      const oy = axis === 0 ? 0.46 : -0.46;
      const px = originX + (L.gx + ox - (L.gy + oy)) * HALF_W;
      const py = originY + (L.gx + ox + L.gy + oy) * HALF_H;
      poles.addRect({ x: px - 0.6, y: py - 13, width: 1.2, height: 13 });
      lightHeads.addRect({ x: px - 1.9, y: py - 19, width: 3.8, height: 7.5 });
      const state = lightState(t, L.offset, axis);
      lamps[state].addCircle(px, py - 17.3 + state * 2.2, 1.15);
    }
  }

  for (const v of visible) {
    const ag = scene.agents[v.a];
    const { gx, gy, ux, uy } = v;
    const wx = originX + (gx - gy) * HALF_W;
    const wy = originY + (gx + gy) * HALF_H;

    if (ag.kind === AGENT_PED) {
      const y = wy - Math.abs(Math.sin(t * 9 + ag.phase * 5)) * 0.8;
      b.shadows.addCircle(wx + 1.5, wy + 0.5, 1.4);
      shirts[ag.color].addRect({ x: wx - 1.1, y: y - 5, width: 2.2, height: 4 });
      heads.addCircle(wx, y - 6.2, 1.25);
      continue;
    }

    // Gabarits : demi-longueur L, demi-largeur W, hauteurs de caisse et de toit.
    const isAmbulance = ag.kind === AGENT_AMBULANCE;
    const isTruck = ag.kind === AGENT_TRUCK || ag.kind === AGENT_FIRETRUCK || isAmbulance;
    const isBus = ag.kind === AGENT_BUS;
    const L = isBus ? 0.36 : isAmbulance ? 0.23 : isTruck ? 0.27 : 0.19;
    const W = isBus || isTruck ? 0.12 : 0.1;
    const c = ag.color;
    const vx = -uy;
    const vy = ux;

    // Ombre portée.
    const sh = [
      [gx + ux * L + vx * W, gy + uy * L + vy * W],
      [gx + ux * L - vx * W, gy + uy * L - vy * W],
      [gx - ux * L - vx * W, gy - uy * L - vy * W],
      [gx - ux * L + vx * W, gy - uy * L + vy * W],
    ].map(([sx, sy]) => ({ x: originX + (sx - sy) * HALF_W + 3, y: originY + (sx + sy) * HALF_H + 1.5 }));
    b.shadows.addPoly(sh, true);

    // Roues : 4 petits disques sombres sous la caisse.
    for (const [l, s] of [
      [0.65, 1],
      [0.65, -1],
      [-0.65, 1],
      [-0.65, -1],
    ]) {
      const qx = gx + ux * L * l + vx * W * s * 1.02;
      const qy = gy + uy * L * l + vy * W * s * 1.02;
      b.wheels.addCircle(originX + (qx - qy) * HALF_W, originY + (qx + qy) * HALF_H - 1.2, 1.5);
    }

    if (isBus) {
      // Caisse unique haute, bande vitrée continue.
      addBox(b.light[c], b.mid[c], b.dark[c], gx, gy, 1.5, 9, ux, uy, -L, L, W, originX, originY);
      addBox(b.light[c], b.glass, b.glassDark, gx, gy, 5, 7.5, ux, uy, -L * 0.98, L * 0.98, W * 1.01, originX, originY);
    } else if (isTruck) {
      // Cabine à l'avant + caisse/citerne à l'arrière.
      const cargo = ag.kind === AGENT_TRUCK ? COLOR_TRUCK : c;
      addBox(b.light[cargo], b.mid[cargo], b.dark[cargo], gx, gy, 1.5, 9, ux, uy, -L, L * 0.25, W, originX, originY);
      // Ambulance : bande rouge sur les flancs de la cellule sanitaire.
      if (isAmbulance) addBox(b.scrap, b.red, b.red, gx, gy, 4.5, 6, ux, uy, -L * 0.98, L * 0.2, W * 1.01, originX, originY);
      addBox(b.light[c], b.mid[c], b.dark[c], gx, gy, 1.5, 7, ux, uy, L * 0.3, L, W * 0.95, originX, originY);
      addBox(b.light[c], b.glass, b.glassDark, gx, gy, 4.2, 6.6, ux, uy, L * 0.32, L * 0.98, W * 0.97, originX, originY);
    } else {
      // Voiture : caisse basse + habitacle vitré en retrait + toit.
      addBox(b.light[c], b.mid[c], b.dark[c], gx, gy, 1.5, 4.5, ux, uy, -L, L, W, originX, originY);
      addBox(b.light[c], b.glass, b.glassDark, gx, gy, 4.5, 7.2, ux, uy, -L * 0.45, L * 0.4, W * 0.82, originX, originY);
      // Phares (avant) et feux (arrière).
      const hx = gx + ux * L * 1.01;
      const hy = gy + uy * L * 1.01;
      b.headlights.addCircle(originX + (hx - hy) * HALF_W, originY + (hx + hy) * HALF_H - 3, 0.9);
      const rx = gx - ux * L * 1.01;
      const ry = gy - uy * L * 1.01;
      // Feux stop plus gros quand la voiture freine (arrêtée au feu).
      b.red.addCircle(originX + (rx - ry) * HALF_W, originY + (rx + ry) * HALF_H - 3, v.stopped ? 1.3 : 0.8);
    }

    // Gyrophares clignotants (police bleu/rouge, pompiers rouge).
    if (ag.kind === AGENT_POLICE || ag.kind === AGENT_FIRETRUCK || isAmbulance) {
      const z = ag.kind === AGENT_POLICE ? 8.4 : 10.2;
      const lx = gx + ux * (ag.kind === AGENT_POLICE ? 0 : L * 0.6);
      const ly = gy + uy * (ag.kind === AGENT_POLICE ? 0 : L * 0.6);
      const sx = originX + (lx - ly) * HALF_W;
      const sy = originY + (lx + ly) * HALF_H - z;
      if (ag.kind === AGENT_POLICE || isAmbulance) {
        (blink ? b.red : b.blue).addCircle(sx - 1.4, sy, 1.3);
        (blink ? b.blue : b.red).addCircle(sx + 1.4, sy, 1.3);
      } else if (blink) {
        b.red.addCircle(sx, sy, 1.6);
      }
    }
  }

  const paint = (color: string, alpha = 1) => {
    const p = Skia.Paint();
    p.setAntiAlias(true);
    p.setColor(Skia.Color(color));
    p.setAlphaf(alpha);
    return p;
  };

  canvas.drawPath(poles.detach(), paint('#2c3e50'));
  canvas.drawPath(lightHeads.detach(), paint('#17202a'));
  canvas.drawPath(lamps[LIGHT_GREEN].detach(), paint('#2ecc71'));
  canvas.drawPath(lamps[LIGHT_YELLOW].detach(), paint('#f1c40f'));
  canvas.drawPath(lamps[2].detach(), paint('#ff3b30'));

  canvas.drawPath(b.shadows.detach(), paint('#000000', 0.25));
  canvas.drawPath(b.wheels.detach(), paint('#17202a'));
  for (let c = 0; c < nColors; c++) {
    canvas.drawPath(b.mid[c].detach(), paint(BODY_MID[c]));
    canvas.drawPath(b.dark[c].detach(), paint(BODY_DARK[c]));
    canvas.drawPath(b.light[c].detach(), paint(BODY_LIGHT[c]));
  }
  canvas.drawPath(b.glass.detach(), paint('#85c1e9'));
  canvas.drawPath(b.glassDark.detach(), paint('#2e6f9e'));
  canvas.drawPath(b.headlights.detach(), paint('#fef9e7'));
  canvas.drawPath(b.red.detach(), paint('#ff3b30'));
  canvas.drawPath(b.blue.detach(), paint('#2f80ff'));

  const outline = paint('#000000', 0.35);
  outline.setStyle(PaintStyle.Stroke);
  outline.setStrokeWidth(0.5);
  for (let c = 0; c < shirts.length; c++) {
    const path = shirts[c].detach();
    canvas.drawPath(path, paint(SHIRT_COLORS[c]));
    canvas.drawPath(path, outline);
  }
  canvas.drawPath(heads.detach(), paint('#f5cba7'));
}

/**
 * Flammes qui vacillent et fumée qui monte, au sommet des bâtiments en feu.
 * Dessinées dans un calque au-dessus des bâtiments pour rester visibles.
 */
export function drawFires(canvas: SkCanvas, fires: FireSpot[], timeMs: number, gridSize: number, view: ViewRect) {
  'worklet';
  if (!fires.length) return;
  const { originX, originY } = getOrigin(gridSize);
  const t = timeMs / 1000;
  const paint = (color: string, alpha = 1) => {
    const p = Skia.Paint();
    p.setAntiAlias(true);
    p.setColor(Skia.Color(color));
    p.setAlphaf(alpha);
    return p;
  };
  const flames = Skia.PathBuilder.Make();
  const cores = Skia.PathBuilder.Make();
  const smoke = Skia.PathBuilder.Make();
  for (const f of fires) {
    const fx = originX + (f.gx - f.gy) * HALF_W;
    const fy = originY + (f.gx + f.gy) * HALF_H - f.z;
    if (fx < view.x0 || fx > view.x1 || fy < view.y0 - 80 || fy > view.y1 + 80) continue;
    for (let k = 0; k < 5; k++) {
      const ph = t * 7 + f.seed + k * 1.3;
      const h = 22 + Math.sin(ph) * 7 + (2 - Math.abs(k - 2)) * 6;
      const ox = (k - 2) * 6;
      const base = fy + 2 - Math.abs(k - 2) * 2;
      flames.addPoly(
        [
          { x: fx + ox - 6, y: base },
          { x: fx + ox + Math.sin(ph * 1.3) * 3, y: base - h },
          { x: fx + ox + 6, y: base },
        ],
        true,
      );
      cores.addPoly(
        [
          { x: fx + ox - 3, y: base },
          { x: fx + ox + Math.sin(ph * 1.3) * 1.8, y: base - h * 0.55 },
          { x: fx + ox + 3, y: base },
        ],
        true,
      );
    }
    for (let k = 0; k < 5; k++) {
      const life = (t * 0.5 + f.seed + k / 5) % 1;
      smoke.addCircle(fx + Math.sin(life * 6 + k) * 8 + life * 18, fy - 26 - life * 70, 6 + life * 14);
    }
  }
  canvas.drawPath(smoke.detach(), paint('#5d6d7e', 0.5));
  canvas.drawPath(flames.detach(), paint('#e67e22', 0.95));
  canvas.drawPath(cores.detach(), paint('#f9e79f'));
}

/** Rames de métro en va-et-vient sur les lignes (vue souterraine de l'outil Métro). */
export function drawMetro(canvas: SkCanvas, scene: AgentsScene, timeMs: number, gridSize: number) {
  'worklet';
  const { originX, originY } = getOrigin(gridSize);
  const t = timeMs / 1000;
  const paint = (color: string, alpha = 1) => {
    const p = Skia.Paint();
    p.setAntiAlias(true);
    p.setColor(Skia.Color(color));
    p.setAlphaf(alpha);
    return p;
  };
  // Rames de métro (vue souterraine, quand l'outil Métro est sélectionné).
  if (scene.metro.length) {
    const train = Skia.PathBuilder.Make();
    const windows = Skia.PathBuilder.Make();
    scene.metro.forEach((m, n) => {
      const len = Math.hypot(m.bx - m.ax, m.by - m.ay) || 1;
      // Va-et-vient avec accélération / freinage en station.
      const u = (1 - Math.cos(((t * 1.6) / len + n * 0.7) * Math.PI)) / 2;
      const ux = (m.bx - m.ax) / len;
      const uy = (m.by - m.ay) / len;
      for (let car = 0; car < 3; car++) {
        const s = u * len - car * 0.55 * (u > 0.5 ? 1 : -1);
        const cxg = m.ax + ux * Math.max(0, Math.min(len, s));
        const cyg = m.ay + uy * Math.max(0, Math.min(len, s));
        const x = originX + (cxg - cyg) * HALF_W;
        const y = originY + (cxg + cyg) * HALF_H;
        train.addCircle(x, y, 7);
        windows.addCircle(x, y - 1.2, 3);
      }
    });
    canvas.drawPath(train.detach(), paint('#ecf0f1'));
    canvas.drawPath(windows.detach(), paint('#16a085'));
  }

}
