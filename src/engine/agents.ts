import { PaintStyle, Skia, type SkCanvas, type SkPathBuilder } from '@shopify/react-native-skia';

import { getOrigin, HALF_H, HALF_W } from './iso';
import { isRoadType, isZone, type Tile } from './map';
import { shade } from './palette';
import { buildingHeight } from './renderer';
import { pointToView, vectorToView } from './rotation';
import { mulberry32 } from './terrain';
import { isIntersection, LIGHT_GREEN, LIGHT_PERIOD, LIGHT_RED, LIGHT_YELLOW, lightOffset, lightState, mod } from './traffic';

/**
 * PNJ : la population de la ville rendue visible.
 *
 * - Thread JS : quand le réseau routier, la population ou les incidents changent,
 *   on calcule les itinéraires (trajets domicile → travail, livraisons, lignes de
 *   bus entre les arrêts, patrouilles, pompiers, ambulances, éboueurs, piétons),
 *   puis une micro-simulation du trafic (suivi de véhicule, feux, priorités aux
 *   carrefours, arrêts de bus). Le calcul est découpé en tranches pour ne jamais
 *   bloquer l'interface.
 * - Thread UI : `drawAgents` (worklet) rejoue les trajectoires enregistrées et
 *   dessine des véhicules en 3D (carrosserie, habitacle vitré, roues, phares).
 */

export const AGENT_CAR = 0;
export const AGENT_PED = 1;
export const AGENT_TRUCK = 2;
export const AGENT_POLICE = 3;
export const AGENT_FIRETRUCK = 4;
export const AGENT_BUS = 5;
export const AGENT_AMBULANCE = 6;
export const AGENT_GARBAGE = 7;
export const AGENT_PLOW = 8;

/** Bulles d'humeur au-dessus des piétons. */
export const BUBBLE_HEART = 0;
export const BUBBLE_TRAFFIC = 1;
export const BUBBLE_CRIME = 2;
export const BUBBLE_POLLUTION = 3;
export const BUBBLE_GARBAGE = 4;
export const BUBBLE_MONEY = 5;
export const BUBBLE_JOBS = 6;

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
   * = arrêt (feu rouge, file d'attente, arrêt de bus). À la distance `total`
   * l'agent est "au garage" (chez lui, au travail) et n'est pas dessiné.
   */
  kt: number[];
  kd: number[];
  loopT: number;
  phase: number;
  color: number;
  /** Tuiles de départ et d'arrivée (index), pour la fiche du citoyen. */
  home: number;
  work: number;
  /** Bulle d'humeur affichée de temps en temps (-1 = aucune). */
  bubble: number;
};

/** Feu tricolore affiché au centre d'un carrefour. */
export type TrafficLight = { gx: number; gy: number; offset: number };
/** Ligne de métro souterraine entre deux stations (coordonnées de grille). */
export type MetroLine = { ax: number; ay: number; bx: number; by: number };
/** Foyers d'incendie à animer (flammes + fumée). */
export type FireSpot = { gx: number; gy: number; seed: number; z: number };
/** Personnes qui attendent à un arrêt de bus. */
export type Waiting = { gx: number; gy: number; color: number };

export type AgentsScene = {
  agents: Agent[];
  fires: FireSpot[];
  lights: TrafficLight[];
  metro: MetroLine[];
  waiting?: Waiting[];
};

export const CAR_COLORS = ['#e74c3c', '#ecf0f1', '#3498db', '#f39c12', '#8e44ad', '#2c3e50', '#16a085', '#d35400'];
export const SHIRT_COLORS = ['#e67e22', '#9b59b6', '#3498db', '#e74c3c', '#ecf0f1', '#1abc9c'];

/** Tables de teintes précalculées côté JS (le worklet ne fait que les lire). */
const BODY = [...CAR_COLORS, '#f5f5f5', '#c0392b', '#f1c40f', '#ecf0f1', '#ffffff', '#1e8449', '#e67e22'];
const COLOR_POLICE = CAR_COLORS.length;
const COLOR_FIRE = CAR_COLORS.length + 1;
const COLOR_BUS = CAR_COLORS.length + 2;
const COLOR_TRUCK = CAR_COLORS.length + 3;
const COLOR_AMBULANCE = CAR_COLORS.length + 4;
const COLOR_GARBAGE = CAR_COLORS.length + 5;
const COLOR_PLOW = CAR_COLORS.length + 6;
const BODY_LIGHT = BODY.map((c) => shade(c, 0.25));
const BODY_MID = BODY.map((c) => shade(c, -0.15));
const BODY_DARK = BODY.map((c) => shade(c, -0.45));

const MAX_CARS = 110;
const MAX_PEDS = 140;
const CAR_LANE = 0.2;
const SIDEWALK = 0.4;
/** Le véhicule s'arrête à cette fraction du segment qui entre dans le carrefour (avant le passage piéton). */
const STOP_AT = 0.24;
/** Les piétons attendent au bord du trottoir, un peu avant les voitures. */
const PED_STOP_AT = 0.14;
/** Durée d'arrêt d'un bus à un arrêt (s). */
const BUS_DWELL = 2.5;

/** Clé de recalcul : routes, services, incendies et population (par paliers). */
export function agentsSignature(tiles: Tile[], population: number): string {
  let h = 2166136261;
  let roads = 0;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (isRoadType(t.type)) {
      h = Math.imul(h ^ (i * 3 + t.type.length), 16777619);
      roads++;
    } else if (
      t.type === 'POLICE' ||
      t.type === 'FIRE' ||
      t.type === 'METRO' ||
      t.type === 'BUSSTOP' ||
      t.type === 'HOSPITAL' ||
      t.type === 'LANDFILL' ||
      t.type === 'INCINERATOR' ||
      t.fire > 0
    ) {
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
function roadPath(from: number, to: number, size: number, isRoad: Uint8Array, maxLen = 140): number[] | null {
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

/** Points décalés d'un côté de la chaussée pour une suite de tuiles (décalage par tronçon). */
function offsetPolyline(seq: number[], size: number, k: (a: number, b: number) => number): [number[], number[]] {
  const gx: number[] = [];
  const gy: number[] = [];
  for (let i = 0; i + 1 < seq.length; i++) {
    const ax = (seq[i] % size) + 0.5;
    const ay = Math.floor(seq[i] / size) + 0.5;
    const bx = (seq[i + 1] % size) + 0.5;
    const by = Math.floor(seq[i + 1] / size) + 0.5;
    const off = k(seq[i], seq[i + 1]);
    // Perpendiculaire "à droite" du sens de marche (en espace grille).
    const px = -(by - ay) * off;
    const py = (bx - ax) * off;
    gx.push(ax + px, bx + px);
    gy.push(ay + py, by + py);
  }
  return [gx, gy];
}

function closeLoop(gx: number[], gy: number[]) {
  gx.push(gx[0]);
  gy.push(gy[0]);
  const cum = [0];
  for (let i = 1; i < gx.length; i++) cum.push(cum[i - 1] + Math.hypot(gx[i] - gx[i - 1], gy[i] - gy[i - 1]));
  return { cum, total: cum[cum.length - 1] };
}

type Draft = {
  kind: number;
  gx: number[];
  gy: number[];
  cum: number[];
  total: number;
  speed: number;
  color: number;
  /** Les véhicules d'urgence grillent les feux et ne suivent personne. */
  emergency: boolean;
  /** Piéton : feux respectés, pas de suivi de véhicule. */
  ped: boolean;
  /** Arrivées aux carrefours : ligne d'arrêt, feu, axe, tourne-t-il ? */
  events: { d: number; tile: number; axis: number; offset: number; turn: boolean }[];
  /** Tronçons orientés (voies) : clé, tuiles de départ/arrivée, début, facteur de vitesse. */
  pairKeys: number[];
  pairFrom: number[];
  pairTo: number[];
  pairStart: number[];
  pairSpeed: number[];
  /** Arrêts de bus (distances sur la boucle). */
  dwell: number[];
  home: number;
  work: number;
  bubble: number;
};

/**
 * Véhicule qui fait l'aller-retour sur un trajet, voie de droite dans les deux
 * sens (avenues et autoroutes : deux voies par sens). On note chaque entrée
 * dans un carrefour pour y placer un arrêt au feu et la priorité.
 */
function vehicle(
  kind: number,
  seq: number[],
  size: number,
  speed: number,
  rand: () => number,
  color: number,
  inter: Uint8Array,
  multi: Uint8Array,
  roadSpeed: Float32Array,
  dwellTiles: Set<number> | null = null,
): Draft {
  const lane = rand() < 0.5 ? 0 : 1;
  const offset = (a: number, b: number) => (multi[a] && multi[b] ? (lane ? 0.34 : 0.14) : CAR_LANE);
  const back = seq.slice().reverse();
  const [fx, fy] = offsetPolyline(seq, size, offset);
  const [bx, by] = offsetPolyline(back, size, offset);
  const gx = fx.concat(bx);
  const gy = fy.concat(by);
  const { cum, total } = closeLoop(gx, gy);
  const pairs = [...seq.slice(0, -1).map((a, i) => [a, seq[i + 1]]), ...back.slice(0, -1).map((a, i) => [a, back[i + 1]])];
  const d: Draft = {
    kind,
    gx,
    gy,
    cum,
    total,
    speed,
    color,
    emergency: kind === AGENT_FIRETRUCK || kind === AGENT_AMBULANCE,
    ped: false,
    events: [],
    pairKeys: [],
    pairFrom: [],
    pairTo: [],
    pairStart: [],
    pairSpeed: [],
    dwell: [],
    home: seq[0],
    work: seq[seq.length - 1],
    bubble: -1,
  };
  pairs.forEach(([a, b], g) => {
    d.pairKeys.push((a * 4096 + b) * 2 + (multi[a] && multi[b] ? lane : 0));
    d.pairFrom.push(a);
    d.pairTo.push(b);
    d.pairStart.push(cum[2 * g]);
    d.pairSpeed.push(roadSpeed[b]);
    const segStart = cum[2 * g];
    const segLen = cum[2 * g + 1] - segStart;
    if (dwellTiles?.has(b)) d.dwell.push(segStart + segLen * 0.5);
    if (!inter[b]) return;
    const axis = Math.abs(b - a) === 1 ? 0 : 1;
    const nxt = pairs[g + 1];
    const turn = !!nxt && nxt[0] === b && (Math.abs(nxt[1] - b) === 1 ? 0 : 1) !== axis;
    d.events.push({ d: segStart + segLen * STOP_AT, tile: b, axis, offset: lightOffset(b), turn });
  });
  return d;
}

/** Piéton : aller-retour sur le même trottoir ; il attend le feu avant de traverser. */
function pedestrian(seq: number[], size: number, rand: () => number, color: number, inter: Uint8Array, bubble: number): Draft {
  const side = rand() < 0.5 ? SIDEWALK : -SIDEWALK;
  const [fx, fy] = offsetPolyline(seq, size, () => side);
  const gx = fx.concat(fx.slice().reverse());
  const gy = fy.concat(fy.slice().reverse());
  const { cum, total } = closeLoop(gx, gy);
  const back = seq.slice().reverse();
  const pairs = [...seq.slice(0, -1).map((a, i) => [a, seq[i + 1]]), ...back.slice(0, -1).map((a, i) => [a, back[i + 1]])];
  const d: Draft = {
    kind: AGENT_PED,
    gx,
    gy,
    cum,
    total,
    speed: 0.22 + rand() * 0.18,
    color,
    emergency: false,
    ped: true,
    events: [],
    pairKeys: [],
    pairFrom: [],
    pairTo: [],
    pairStart: [],
    pairSpeed: [],
    dwell: [],
    home: seq[0],
    work: seq[seq.length - 1],
    bubble,
  };
  pairs.forEach(([a, b], g) => {
    d.pairKeys.push(-1);
    d.pairFrom.push(a);
    d.pairTo.push(b);
    d.pairStart.push(cum[2 * g]);
    d.pairSpeed.push(1);
    if (!inter[b]) return;
    const segStart = cum[2 * g];
    const segLen = cum[2 * g + 1] - segStart;
    d.events.push({ d: segStart + segLen * PED_STOP_AT, tile: b, axis: Math.abs(b - a) === 1 ? 0 : 1, offset: lightOffset(b), turn: false });
  });
  return d;
}

/** Pas de temps de la micro-simulation et fréquence d'enregistrement des trajectoires. */
const DT = 0.125;
const SAMPLE_EVERY = 3;
/** Distance minimale entre deux véhicules (centre à centre, en tuiles) et zone de freinage. */
const MIN_GAP = 0.46;
const BRAKE_ZONE = 0.6;

/**
 * Micro-simulation du trafic, sur une période H commune à tous les agents
 * (multiple du cycle des feux) :
 *  - chaque véhicule suit celui qui le précède sur sa voie (distance de sécurité,
 *    freinage progressif) ;
 *  - il s'arrête au feu rouge, repart au vert ; s'il tourne, il cède le passage
 *    tant que le carrefour n'est pas dégagé ;
 *  - les bus marquent l'arrêt ; les piétons attendent le feu pour traverser ;
 *  - les véhicules d'urgence grillent les feux.
 * On simule 3 périodes et on enregistre la dernière (trafic établi). Générateur :
 * il rend la main régulièrement pour que le calcul se fasse en tâche de fond.
 */
function* simulateTraffic(drafts: Draft[], rand: () => number): Generator<void, Agent[], void> {
  const n = drafts.length;
  if (n === 0) return [];
  const free = drafts.map((d) => d.total / d.speed);
  const H = Math.min(LIGHT_PERIOD * 20, Math.max(LIGHT_PERIOD * 6, Math.ceil((Math.max(...free) * 1.4 + 6) / LIGHT_PERIOD) * LIGHT_PERIOD));
  // Plusieurs trajets par période pour les trajets courts : la densité suit la population.
  const trips = drafts.map((_, i) => Math.max(1, Math.floor(H / (free[i] * 1.5 + 4))));
  const dep = drafts.map(() => rand() * H);
  const isDeparture = (i: number, t: number) => mod(t - dep[i], H / trips[i]) < DT * 0.999;
  const d = new Float64Array(n);
  const pair = new Int32Array(n);
  const ev = new Int32Array(n);
  const dw = new Int32Array(n);
  const waitUntil = new Float64Array(n);
  const active = new Uint8Array(n);
  const kt: number[][] = drafts.map(() => []);
  const kd: number[][] = drafts.map(() => []);
  const occ = new Map<number, number[]>();
  const inside = new Map<number, number>();
  const next = new Float64Array(n);
  const recordFrom = 2 * H;
  const steps = Math.round((3 * H) / DT);

  for (let step = 0; step < steps; step++) {
    if (step % 24 === 0) yield;
    const t = step * DT;
    const rec = t >= recordFrom;
    const tau = t - recordFrom;
    if (step === Math.round(recordFrom / DT)) {
      for (let i = 0; i < n; i++) {
        kt[i].push(0);
        kd[i].push(active[i] ? d[i] : drafts[i].total);
      }
    }
    // Départs (l'agent sort de chez lui).
    for (let i = 0; i < n; i++) {
      if (active[i] || !isDeparture(i, t)) continue;
      active[i] = 1;
      d[i] = 0;
      pair[i] = 0;
      ev[i] = 0;
      dw[i] = 0;
      waitUntil[i] = 0;
      if (rec) {
        kt[i].push(tau, tau);
        kd[i].push(drafts[i].total, 0);
      }
    }
    // Occupation des voies et des carrefours.
    occ.clear();
    inside.clear();
    for (let i = 0; i < n; i++) {
      const dr = drafts[i];
      if (!active[i] || dr.ped) continue;
      const j = pair[i];
      const key = dr.pairKeys[j];
      const list = occ.get(key);
      if (list) list.push(i);
      else occ.set(key, [i]);
      const off = d[i] - dr.pairStart[j];
      const segLen = (dr.pairStart[j + 1] ?? dr.total) - dr.pairStart[j];
      if (off > segLen * (STOP_AT + 0.05)) inside.set(dr.pairTo[j], (inside.get(dr.pairTo[j]) ?? 0) + 1);
      else if (off < segLen * 0.45) inside.set(dr.pairFrom[j], (inside.get(dr.pairFrom[j]) ?? 0) + 1);
    }
    // Vitesses : suivi du véhicule de devant, feux, priorités, arrêts de bus.
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      const dr = drafts[i];
      const j = pair[i];
      const vmax = dr.speed * dr.pairSpeed[j];
      let v = vmax;
      if (t < waitUntil[i]) v = 0;
      else if (!dr.emergency) {
        let gap = Infinity;
        if (!dr.ped) {
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
        }
        const e = dr.events[ev[i]];
        if (e && e.d - d[i] < 1.2) {
          // Feu : la ligne d'arrêt agit comme un véhicule arrêté tant que le feu n'est pas vert.
          const state = lightState(t, e.offset, e.axis);
          const close = e.d - d[i] < 0.15;
          let stop = state === LIGHT_RED || (state === LIGHT_YELLOW && !close);
          // Priorité : celui qui tourne attend que le carrefour soit dégagé.
          if (!stop && e.turn && e.d - d[i] < 0.5 && (inside.get(e.tile) ?? 0) > 0) stop = true;
          if (stop) gap = Math.min(gap, e.d - d[i] + MIN_GAP);
        }
        // Arrêt de bus : on s'arrête quelques secondes.
        const stopD = dr.dwell[dw[i]];
        if (stopD !== undefined && d[i] >= stopD - 0.02) {
          waitUntil[i] = t + BUS_DWELL;
          dw[i]++;
          v = 0;
        } else if (dr.ped) {
          if (gap <= MIN_GAP) v = 0;
        } else if (gap <= MIN_GAP) v = 0;
        else if (gap < MIN_GAP + BRAKE_ZONE) v = (vmax * (gap - MIN_GAP)) / BRAKE_ZONE;
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
      if (d[i] >= dr.total) active[i] = 0; // arrivé : retour chez soi
      if (rec && (step % SAMPLE_EVERY === 0 || !active[i])) {
        kt[i].push(tau + DT);
        kd[i].push(d[i]);
      }
    }
  }

  return drafts.map((dr, i) => {
    kt[i].push(H);
    kd[i].push(active[i] ? d[i] : dr.total);
    return {
      kind: dr.kind,
      gx: dr.gx,
      gy: dr.gy,
      cum: dr.cum,
      total: dr.total,
      kt: kt[i],
      kd: kd[i],
      loopT: H,
      phase: 0,
      color: dr.color,
      home: dr.home,
      work: dr.work,
      bubble: dr.bubble,
    };
  });
}

/** Routes qui bordent au moins une tuile satisfaisant `pred`. */
function roadsNear(tiles: Tile[], roads: number[], size: number, pred: (t: Tile) => boolean): number[] {
  return roads.filter((i) => neighbours4(i, size, tiles.length).some((n) => n >= 0 && pred(tiles[n])));
}

/** Route la plus proche (à vol d'oiseau) d'une tuile, dans un rayon de 3. */
function nearestRoad(size: number, isRoad: Uint8Array, x: number, y: number): number {
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

type Prepared = { drafts: Draft[]; scene: Omit<AgentsScene, 'agents'>; rand: () => number };

/**
 * Prépare tous les itinéraires. `scale` réduit le nombre d'agents (qualité),
 * `issues` donne les bulles de mécontentement possibles.
 */
/** Options de la scène : événements en cours (foules) et hiver (chasse-neige). */
export type SceneOptions = { events?: { x: number; y: number }[]; winter?: boolean };

function prepare(tiles: Tile[], size: number, population: number, riders: number, scale: number, issues: number[], opts: SceneOptions = {}): Prepared {
  const fires: FireSpot[] = tiles
    .filter((t) => t.fire > 0)
    .map((t, k) => ({ gx: t.x + 0.5, gy: t.y + 0.5, seed: k * 1.7, z: Math.max(6, buildingHeight(t) - 6) }));
  const metro = metroLines(tiles);
  const isRoad = new Uint8Array(tiles.length);
  const multi = new Uint8Array(tiles.length);
  const roadSpeed = new Float32Array(tiles.length).fill(1);
  const roads: number[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const type = tiles[i].type;
    if (!isRoadType(type)) continue;
    isRoad[i] = 1;
    roads.push(i);
    if (type !== 'ROAD') multi[i] = 1;
    roadSpeed[i] = type === 'HIGHWAY' ? 1.7 : type === 'AVENUE' ? 1.25 : 1;
  }
  const rand = mulberry32(roads.length * 7919 + population);
  if (roads.length < 2) return { drafts: [], scene: { fires, lights: [], metro, waiting: [] }, rand };

  // Carrefours (≥ 3 routes) : chacun a ses feux tricolores.
  const inter = new Uint8Array(tiles.length);
  const lights: TrafficLight[] = [];
  for (const i of roads) {
    if (!isIntersection((k) => isRoad[k] === 1, i, size, tiles.length)) continue;
    inter[i] = 1;
    lights.push({ gx: (i % size) + 0.5, gy: Math.floor(i / size) + 0.5, offset: lightOffset(i) });
  }

  const drafts: Draft[] = [];
  const built = (t: Tile) => isZone(t.type) && t.density > 0 && t.fire === 0;
  const homes = roadsNear(tiles, roads, size, (t) => t.type === 'R' && built(t));
  const jobs = roadsNear(tiles, roads, size, (t) => (t.type === 'C' || t.type === 'I') && built(t));
  const factories = roadsNear(tiles, roads, size, (t) => t.type === 'I' && built(t));
  const shops = roadsNear(tiles, roads, size, (t) => t.type === 'C' && built(t));
  const pick = (list: number[]) => list[Math.floor(rand() * list.length)];
  const add = (kind: number, seq: number[] | null, speed: number, color: number, dwell?: Set<number>) => {
    if (seq && seq.length >= 2) drafts.push(vehicle(kind, seq, size, speed, rand, color, inter, multi, roadSpeed, dwell ?? null));
  };

  // 1. Navetteurs : environ une voiture pour 35 habitants qui ne prennent pas les transports.
  const drivers = Math.max(0, population - riders);
  const cars = Math.round(Math.min(MAX_CARS, 2 + drivers / 35) * scale);
  for (let c = 0; c < cars; c++) {
    let seq: number[] | null = null;
    if (homes.length && jobs.length) seq = roadPath(pick(homes), pick(jobs), size, isRoad);
    seq ??= randomWalk(pick(roads), size, isRoad, 20, rand);
    // Vitesses presque identiques : les véhicules ne se « traversent » pas sur une même voie.
    add(AGENT_CAR, seq, 1.5 + rand() * 0.1, Math.floor(rand() * CAR_COLORS.length));
  }

  // 2. Camions : usines → commerces, et usines → port / gare de fret pour l'export.
  const hubs = tiles.filter((t) => (t.type === 'PORT' || t.type === 'FREIGHT') && t.powered).map((t) => nearestRoad(size, isRoad, t.x, t.y)).filter((r) => r >= 0);
  const trucks = Math.round((factories.length ? Math.min(22, factories.length / 4) : 0) * scale);
  for (let k = 0; k < trucks; k++) {
    const dest = hubs.length && k % 2 === 0 ? pick(hubs) : shops.length ? pick(shops) : -1;
    add(AGENT_TRUCK, (dest >= 0 && roadPath(pick(factories), dest, size, isRoad)) || randomWalk(pick(factories), size, isRoad, 16, rand), 1.35, COLOR_TRUCK);
  }

  // 2 bis. L'hiver, les chasse-neige sillonnent les grands axes.
  if (opts.winter) {
    const plows = Math.max(1, Math.round(Math.min(6, roads.length / 80) * Math.max(0.5, scale)));
    for (let k = 0; k < plows; k++) add(AGENT_PLOW, randomWalk(pick(roads), size, isRoad, 26, rand), 1.1, COLOR_PLOW);
  }

  // 3. Bus : une ligne qui relie les arrêts dans l'ordre du plus proche voisin, et marque l'arrêt.
  const stops = tiles.filter((t) => t.type === 'BUSSTOP');
  const waiting: Waiting[] = [];
  if (stops.length >= 2) {
    const stopRoads = stops.map((s) => nearestRoad(size, isRoad, s.x, s.y)).filter((r) => r >= 0);
    const order = [stopRoads[0]];
    const left = new Set(stopRoads.slice(1));
    while (left.size) {
      const cur = order[order.length - 1];
      let best = -1;
      let bestD = Infinity;
      for (const r of left) {
        const d = Math.hypot((r % size) - (cur % size), Math.floor(r / size) - Math.floor(cur / size));
        if (d < bestD) {
          bestD = d;
          best = r;
        }
      }
      left.delete(best);
      order.push(best);
    }
    const route: number[] = [order[0]];
    for (let k = 1; k < order.length; k++) {
      const leg = roadPath(route[route.length - 1], order[k], size, isRoad);
      if (leg) route.push(...leg.slice(1));
    }
    const dwell = new Set(stopRoads);
    const buses = Math.max(1, Math.min(8, Math.round((stops.length / 2) * Math.max(0.5, scale))));
    for (let k = 0; k < buses; k++) add(AGENT_BUS, route.length >= 2 ? route : null, 1.3, COLOR_BUS, dwell);
    // Quelques personnes attendent à chaque arrêt.
    for (const s of stops) {
      const people = 1 + Math.floor(rand() * 3);
      for (let p = 0; p < people; p++) waiting.push({ gx: s.x + 0.3 + p * 0.14, gy: s.y + 0.62, color: Math.floor(rand() * SHIRT_COLORS.length) });
    }
  }

  // 4. Police : deux patrouilles par commissariat alimenté.
  for (const st of tiles) {
    if (st.type !== 'POLICE' || !st.powered) continue;
    const start = nearestRoad(size, isRoad, st.x, st.y);
    if (start < 0) continue;
    for (let k = 0; k < 2; k++) add(AGENT_POLICE, randomWalk(start, size, isRoad, 18, rand), 1.55, COLOR_POLICE);
  }

  // 5. Pompiers : un camion de la caserne la plus proche vers chaque incendie.
  const stations = tiles.filter((t) => t.type === 'FIRE' && t.powered);
  for (const f of fires.slice(0, 8)) {
    const target = nearestRoad(size, isRoad, Math.floor(f.gx), Math.floor(f.gy));
    if (target < 0 || !stations.length) continue;
    const st = stations.reduce((a, b) => (Math.hypot(a.x - f.gx, a.y - f.gy) < Math.hypot(b.x - f.gx, b.y - f.gy) ? a : b));
    const from = nearestRoad(size, isRoad, st.x, st.y);
    add(AGENT_FIRETRUCK, from >= 0 ? roadPath(from, target, size, isRoad) : null, 2.2, COLOR_FIRE);
  }

  // 6. Ambulances : deux par hôpital alimenté, qui vont chercher des patients dans les quartiers.
  for (const h of tiles) {
    if (h.type !== 'HOSPITAL' || !h.powered || !homes.length) continue;
    const from = nearestRoad(size, isRoad, h.x, h.y);
    if (from < 0) continue;
    for (let k = 0; k < 2; k++) add(AGENT_AMBULANCE, roadPath(from, pick(homes), size, isRoad), 2, COLOR_AMBULANCE);
  }

  // 7. Éboueurs : deux camions par décharge ou incinérateur.
  for (const w of tiles) {
    if ((w.type !== 'LANDFILL' && w.type !== 'INCINERATOR') || !w.powered || !homes.length) continue;
    const from = nearestRoad(size, isRoad, w.x, w.y);
    if (from < 0) continue;
    for (let k = 0; k < 2; k++) add(AGENT_GARBAGE, roadPath(from, pick(homes), size, isRoad), 1.2, COLOR_GARBAGE);
  }

  // 8. Piétons : un pour 30 habitants, sur les trottoirs des quartiers habités.
  const sidewalks = roadsNear(tiles, roads, size, (t) => (t.type === 'R' || t.type === 'C') ? built(t) : t.type === 'PARK' || t.type === 'METRO' || t.type === 'BUSSTOP');
  const peds = sidewalks.length ? Math.round(Math.min(MAX_PEDS, population / 30) * scale) : 0;
  for (let p = 0; p < peds; p++) {
    const seq = randomWalk(pick(sidewalks), size, isRoad, 4 + Math.floor(rand() * 6), rand);
    if (seq.length < 2) continue;
    // Un piéton sur cinq a quelque chose à dire (cœur s'il est content, sinon un problème de la ville).
    const bubble = rand() < 0.2 ? (issues.length && rand() < 0.75 ? issues[Math.floor(rand() * issues.length)] : BUBBLE_HEART) : -1;
    drafts.push(pedestrian(seq, size, rand, Math.floor(rand() * SHIRT_COLORS.length), inter, bubble));
  }

  // 9. Foules : les spectateurs convergent vers les lieux d'événements.
  for (const ev of opts.events ?? []) {
    const target = nearestRoad(size, isRoad, ev.x, ev.y);
    if (target < 0) continue;
    const near = roads.filter((r) => Math.abs((r % size) - ev.x) + Math.abs(Math.floor(r / size) - ev.y) <= 9 && r !== target);
    const crowd = Math.round(16 * Math.max(0.5, scale));
    for (let p = 0; p < crowd && near.length; p++) {
      const seq = roadPath(pick(near), target, size, isRoad);
      if (!seq || seq.length < 2) continue;
      drafts.push(pedestrian(seq, size, rand, Math.floor(rand() * SHIRT_COLORS.length), inter, rand() < 0.4 ? BUBBLE_HEART : -1));
    }
  }

  return { drafts, scene: { fires, lights, metro, waiting }, rand };
}

/** Construit la scène des PNJ d'un coup (tests, aperçus). */
export function buildAgents(tiles: Tile[], size: number, population: number, riders = 0, scale = 1, issues: number[] = [], opts: SceneOptions = {}): AgentsScene {
  const p = prepare(tiles, size, population, riders, scale, issues, opts);
  const gen = simulateTraffic(p.drafts, p.rand);
  let r = gen.next();
  while (!r.done) r = gen.next();
  return { ...p.scene, agents: r.value };
}

/**
 * Construit la scène en tâche de fond : le calcul est découpé en tranches de
 * quelques millisecondes et rend la main entre deux tranches, pour que les
 * gestes et les touchers restent réactifs. Renvoie null si annulé.
 */
export async function buildAgentsAsync(
  tiles: Tile[],
  size: number,
  population: number,
  riders: number,
  scale: number,
  issues: number[],
  cancelled: () => boolean,
  opts: SceneOptions = {},
): Promise<AgentsScene | null> {
  const p = prepare(tiles, size, population, riders, scale, issues, opts);
  const gen = simulateTraffic(p.drafts, p.rand);
  let slice = Date.now();
  let r = gen.next();
  while (!r.done) {
    if (Date.now() - slice > 6) {
      await new Promise((res) => setTimeout(res, 0));
      if (cancelled()) return null;
      slice = Date.now();
    }
    r = gen.next();
  }
  return { ...p.scene, agents: r.value };
}

/** Position d'un agent à l'instant t (s), en coordonnées d'origine. Worklet. */
export function agentPosition(ag: Agent, t: number) {
  'worklet';
  const tm = mod(t + ag.phase, ag.loopT);
  let k = 0;
  while (k < ag.kt.length - 2 && ag.kt[k + 1] <= tm) k++;
  const span = ag.kt[k + 1] - ag.kt[k];
  const stopped = ag.kd[k + 1] === ag.kd[k];
  // À la distance `total` à l'arrêt, l'agent est "chez lui" : on ne le dessine pas.
  const hidden = stopped && ag.kd[k] === ag.total;
  let d = span > 0 ? ag.kd[k] + ((ag.kd[k + 1] - ag.kd[k]) * (tm - ag.kt[k])) / span : ag.kd[k];
  if (d >= ag.total) d = 0;
  let i = 0;
  while (i < ag.cum.length - 2 && ag.cum[i + 1] < d) i++;
  const segLen = ag.cum[i + 1] - ag.cum[i] || 1;
  const f = (d - ag.cum[i]) / segLen;
  const dx = ag.gx[i + 1] - ag.gx[i];
  const dy = ag.gy[i + 1] - ag.gy[i];
  return { gx: ag.gx[i] + dx * f, gy: ag.gy[i] + dy * f, dx, dy, stopped, hidden };
}

/** Agent le plus proche d'un point de la grille (coordonnées d'origine), ou -1. */
export function agentAt(scene: AgentsScene, timeMs: number, gx: number, gy: number): number {
  const t = timeMs / 1000;
  let best = -1;
  let bestD = Infinity;
  scene.agents.forEach((ag, i) => {
    const p = agentPosition(ag, t);
    if (p.hidden) return;
    const d = Math.hypot(p.gx - gx, p.gy - gy);
    const reach = ag.kind === AGENT_PED ? 0.4 : 0.5;
    if (d < reach && d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

const FIRST_NAMES = ['Camille', 'Alex', 'Sacha', 'Noa', 'Charlie', 'Lou', 'Eden', 'Maël', 'Andrea', 'Robin', 'Yanis', 'Inès', 'Léa', 'Hugo', 'Jade', 'Louis', 'Chloé', 'Nathan', 'Amira', 'Tom', 'Sofia', 'Malik', 'Zoé', 'Théo'];
const LAST_NAMES = ['Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Richard', 'Petit', 'Durand', 'Leroy', 'Moreau', 'Simon', 'Laurent', 'Lefebvre', 'Michel', 'Garcia', 'Fontaine', 'Chevalier', 'Rousseau', 'Benali', 'Nguyen'];

const ROLE: Record<number, string> = {
  [AGENT_POLICE]: 'Agent·e de police en patrouille',
  [AGENT_FIRETRUCK]: 'Sapeur-pompier en intervention',
  [AGENT_AMBULANCE]: 'Ambulancier·ère',
  [AGENT_BUS]: 'Chauffeur·se de bus',
  [AGENT_TRUCK]: 'Livreur·se',
  [AGENT_GARBAGE]: 'Éboueur·se',
  [AGENT_PLOW]: 'Conducteur·rice de chasse-neige',
};

const QUOTES: Record<number, string[]> = {
  [BUBBLE_HEART]: ['J’adore cette ville !', 'Quel beau quartier.', 'Merci monsieur le maire !'],
  [BUBBLE_TRAFFIC]: ['Encore des bouchons…', 'Il faudrait des avenues !', 'Une heure pour aller au travail !'],
  [BUBBLE_CRIME]: ['Je ne me sens pas en sécurité.', 'Il faut plus de police.'],
  [BUBBLE_POLLUTION]: ['On respire mal ici.', 'Trop d’usines près de chez moi.'],
  [BUBBLE_GARBAGE]: ['Les poubelles débordent !', 'Les éboueurs ne passent plus.'],
  [BUBBLE_MONEY]: ['Les impôts sont trop élevés !', 'Tout est trop cher.'],
  [BUBBLE_JOBS]: ['Je cherche du travail…', 'Il manque des emplois.'],
};

/** Fiche d'un citoyen (nom, âge, métier, humeur, citation), déterministe pour un agent donné. */
export function describeAgent(scene: AgentsScene, index: number, tiles: Tile[], size: number, happiness: number) {
  const ag = scene.agents[index];
  const h = (k: number) => {
    let x = Math.imul(index + 1, 2654435761) ^ Math.imul(k + 7, 40503);
    x = Math.imul(x ^ (x >>> 15), 2246822507);
    return ((x ^ (x >>> 13)) >>> 0) / 4294967296;
  };
  const name = `${FIRST_NAMES[Math.floor(h(1) * FIRST_NAMES.length)]} ${LAST_NAMES[Math.floor(h(2) * LAST_NAMES.length)]}`;
  let role = ROLE[ag.kind];
  if (!role) {
    // Métier selon la zone desservie à l'arrivée du trajet.
    const wx = ag.work % size;
    const wy = Math.floor(ag.work / size);
    let near = '';
    for (let dy = -1; dy <= 1 && !near; dy++) {
      for (let dx = -1; dx <= 1 && !near; dx++) {
        const t = tiles[(wy + dy) * size + wx + dx];
        if (t && (t.type === 'C' || t.type === 'I') && t.density > 0) near = t.type;
      }
    }
    role = ag.kind === AGENT_PED ? (h(3) < 0.3 ? 'Étudiant·e en balade' : 'Habitant·e du quartier') : near === 'I' ? 'Ouvrier·ère, en route pour l’usine' : near === 'C' ? 'Employé·e de commerce, en route pour le travail' : 'Automobiliste';
  }
  const mood = Math.max(0, Math.min(100, Math.round(happiness + (h(4) - 0.5) * 30 + (ag.bubble === BUBBLE_HEART ? 15 : ag.bubble >= 1 ? -15 : 0))));
  const pool = QUOTES[ag.bubble >= 0 ? ag.bubble : mood >= 55 ? BUBBLE_HEART : BUBBLE_TRAFFIC];
  return {
    name,
    age: 18 + Math.floor(h(5) * 62),
    role,
    mood,
    quote: pool[Math.floor(h(6) * pool.length)],
    home: ag.home >= 0 ? { x: ag.home % size, y: Math.floor(ag.home / size) } : null,
  };
}

/** Rectangle visible, en coordonnées monde. */
export type ViewRect = { x0: number; y0: number; x1: number; y1: number };

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

function makePaint(color: string, alpha = 1) {
  'worklet';
  const p = Skia.Paint();
  p.setAntiAlias(true);
  p.setColor(Skia.Color(color));
  p.setAlphaf(alpha);
  return p;
}

/** Petite icône d'humeur dans une bulle blanche. */
function drawBubble(canvas: SkCanvas, x: number, y: number, kind: number) {
  'worklet';
  const bubble = Skia.PathBuilder.Make();
  bubble.addCircle(x, y, 5.2);
  bubble.moveTo(x - 1.8, y + 4.4);
  bubble.lineTo(x - 3.6, y + 8);
  bubble.lineTo(x + 0.6, y + 4.9);
  bubble.close();
  canvas.drawPath(bubble.detach(), makePaint('#ffffff', 0.95));
  if (kind === BUBBLE_HEART) {
    const h = Skia.PathBuilder.Make();
    h.addCircle(x - 1.3, y - 0.8, 1.6);
    h.addCircle(x + 1.3, y - 0.8, 1.6);
    h.moveTo(x - 2.8, y - 0.2);
    h.lineTo(x, y + 2.8);
    h.lineTo(x + 2.8, y - 0.2);
    h.close();
    canvas.drawPath(h.detach(), makePaint('#e74c3c'));
  } else if (kind === BUBBLE_TRAFFIC) {
    canvas.drawRect({ x: x - 3, y: y - 1.2, width: 6, height: 2.6 }, makePaint('#3498db'));
    canvas.drawRect({ x: x - 1.6, y: y - 2.6, width: 3.2, height: 1.6 }, makePaint('#2e86c1'));
    canvas.drawCircle(x - 1.8, y + 1.6, 0.9, makePaint('#17202a'));
    canvas.drawCircle(x + 1.8, y + 1.6, 0.9, makePaint('#17202a'));
  } else if (kind === BUBBLE_CRIME) {
    canvas.drawRect({ x: x - 0.8, y: y - 3.4, width: 1.6, height: 4.2 }, makePaint('#e74c3c'));
    canvas.drawCircle(x, y + 2.3, 0.9, makePaint('#e74c3c'));
  } else if (kind === BUBBLE_POLLUTION) {
    canvas.drawCircle(x - 1.5, y, 1.8, makePaint('#7f8c8d'));
    canvas.drawCircle(x + 1, y - 0.8, 2.1, makePaint('#95a5a6'));
    canvas.drawCircle(x + 1.8, y + 0.9, 1.5, makePaint('#7f8c8d'));
  } else if (kind === BUBBLE_GARBAGE) {
    canvas.drawRect({ x: x - 2, y: y - 1.6, width: 4, height: 4.2 }, makePaint('#566573'));
    canvas.drawRect({ x: x - 2.6, y: y - 2.6, width: 5.2, height: 1 }, makePaint('#2c3e50'));
  } else if (kind === BUBBLE_MONEY) {
    canvas.drawCircle(x, y, 3, makePaint('#f1c40f'));
    canvas.drawCircle(x, y, 1.8, makePaint('#d4ac0d'));
  } else {
    canvas.drawRect({ x: x - 2.8, y: y - 1.4, width: 5.6, height: 3.8 }, makePaint('#8d6e63'));
    canvas.drawRect({ x: x - 1.2, y: y - 2.6, width: 2.4, height: 1.2 }, makePaint('#6d4c41'));
  }
}

/**
 * Dessine les agents visibles à l'instant `timeMs`. Worklet : s'exécute sur le
 * thread UI. Les agents hors de `view` sont ignorés (culling).
 *  - mode 'bodies' : véhicules, piétons, feux tricolores, bulles d'humeur ;
 *  - mode 'lights' : phares, feux arrière et gyrophares, dessinés au-dessus du voile de nuit.
 */
export function drawAgents(
  canvas: SkCanvas,
  scene: AgentsScene,
  timeMs: number,
  gridSize: number,
  view: ViewRect,
  rot = 0,
  mode: 'bodies' | 'lights' = 'bodies',
  night = 0,
) {
  'worklet';
  const { originX, originY } = getOrigin(gridSize);
  const t = timeMs / 1000;
  const blink = Math.floor(t * 4) % 2 === 0;

  // Positions visibles, triées par profondeur (gx + gy) : le premier plan recouvre l'arrière-plan.
  const visible: { a: number; gx: number; gy: number; ux: number; uy: number; depth: number; stopped: boolean }[] = [];
  for (let a = 0; a < scene.agents.length; a++) {
    const ag = scene.agents[a];
    if (mode === 'lights' && ag.kind === AGENT_PED) continue;
    const p = agentPosition(ag, t);
    if (p.hidden) continue;
    // Passage dans le repère de la vue (rotation).
    const [gx, gy] = pointToView(p.gx, p.gy, gridSize, rot);
    const [vdx, vdy] = vectorToView(p.dx, p.dy, rot);
    const wx = originX + (gx - gy) * HALF_W;
    const wy = originY + (gx + gy) * HALF_H;
    if (wx < view.x0 || wx > view.x1 || wy < view.y0 || wy > view.y1) continue;
    const len = Math.hypot(p.dx, p.dy) || 1;
    visible.push({ a, gx, gy, ux: vdx / len, uy: vdy / len, depth: gx + gy, stopped: p.stopped });
  }
  visible.sort((p, q) => p.depth - q.depth);

  if (mode === 'lights') {
    // Nuit : faisceaux des phares, feux arrière et gyrophares.
    const beams = Skia.PathBuilder.Make();
    const tails = Skia.PathBuilder.Make();
    const flash = Skia.PathBuilder.Make();
    for (const v of visible) {
      const ag = scene.agents[v.a];
      const { gx, gy, ux, uy } = v;
      const L = ag.kind === AGENT_BUS ? 0.36 : ag.kind === AGENT_CAR || ag.kind === AGENT_POLICE ? 0.19 : 0.27;
      const vx = -uy;
      const vy = ux;
      const toS = (qx: number, qy: number, z: number) => ({ x: originX + (qx - qy) * HALF_W, y: originY + (qx + qy) * HALF_H - z });
      const f0 = toS(gx + ux * L + vx * 0.08, gy + uy * L + vy * 0.08, 2.5);
      const f1 = toS(gx + ux * L - vx * 0.08, gy + uy * L - vy * 0.08, 2.5);
      const far0 = toS(gx + ux * (L + 0.9) + vx * 0.28, gy + uy * (L + 0.9) + vy * 0.28, 0);
      const far1 = toS(gx + ux * (L + 0.9) - vx * 0.28, gy + uy * (L + 0.9) - vy * 0.28, 0);
      beams.addPoly([f0, far0, far1, f1], true);
      const r = toS(gx - ux * L, gy - uy * L, 3);
      tails.addCircle(r.x, r.y, v.stopped ? 2.6 : 1.8);
      if ((ag.kind === AGENT_POLICE || ag.kind === AGENT_AMBULANCE || ag.kind === AGENT_FIRETRUCK) && blink) {
        const b = toS(gx, gy, 9);
        flash.addCircle(b.x, b.y, 10);
      }
    }
    canvas.drawPath(beams.detach(), makePaint('#fff3c4', 0.22 * night));
    canvas.drawPath(tails.detach(), makePaint('#ff3b30', 0.85 * night));
    canvas.drawPath(flash.detach(), makePaint('#5dade2', 0.35 * night));
    return;
  }

  const nColors = BODY.length;
  const shadows = Skia.PathBuilder.Make();
  const light: SkPathBuilder[] = [];
  const mid: SkPathBuilder[] = [];
  const dark: SkPathBuilder[] = [];
  for (let c = 0; c < nColors; c++) {
    light.push(Skia.PathBuilder.Make());
    mid.push(Skia.PathBuilder.Make());
    dark.push(Skia.PathBuilder.Make());
  }
  const glass = Skia.PathBuilder.Make();
  const glassDark = Skia.PathBuilder.Make();
  const wheels = Skia.PathBuilder.Make();
  const headlights = Skia.PathBuilder.Make();
  const red = Skia.PathBuilder.Make();
  const blue = Skia.PathBuilder.Make();
  const scrap = Skia.PathBuilder.Make();
  const shirts = SHIRT_COLORS.map(() => Skia.PathBuilder.Make());
  const heads = Skia.PathBuilder.Make();
  const bubbles: { x: number; y: number; kind: number }[] = [];

  // Feux tricolores : deux poteaux par carrefour (un par axe), lampe allumée selon le cycle.
  const lamps = [Skia.PathBuilder.Make(), Skia.PathBuilder.Make(), Skia.PathBuilder.Make()];
  const poles = Skia.PathBuilder.Make();
  const lightHeads = Skia.PathBuilder.Make();
  for (const L0 of scene.lights) {
    const [lgx, lgy] = pointToView(L0.gx, L0.gy, gridSize, rot);
    const cx = originX + (lgx - lgy) * HALF_W;
    const cy = originY + (lgx + lgy) * HALF_H;
    if (cx < view.x0 || cx > view.x1 || cy < view.y0 || cy > view.y1) continue;
    for (let axis = 0; axis < 2; axis++) {
      // Poteau au coin du carrefour, côté droit de la voie qui arrive.
      const [ox, oy] = vectorToView(axis === 0 ? -0.46 : 0.46, axis === 0 ? 0.46 : -0.46, rot);
      const px = originX + (lgx + ox - (lgy + oy)) * HALF_W;
      const py = originY + (lgx + ox + lgy + oy) * HALF_H;
      poles.addRect({ x: px - 0.6, y: py - 13, width: 1.2, height: 13 });
      lightHeads.addRect({ x: px - 1.9, y: py - 19, width: 3.8, height: 7.5 });
      const state = lightState(t, L0.offset, axis);
      lamps[state].addCircle(px, py - 17.3 + state * 2.2, 1.15);
    }
  }

  // Personnes qui attendent le bus.
  for (const w of scene.waiting ?? []) {
    const [vgx, vgy] = pointToView(w.gx, w.gy, gridSize, rot);
    const wx = originX + (vgx - vgy) * HALF_W;
    const wy = originY + (vgx + vgy) * HALF_H;
    if (wx < view.x0 || wx > view.x1 || wy < view.y0 || wy > view.y1) continue;
    shadows.addCircle(wx + 1.5, wy + 0.5, 1.4);
    shirts[w.color].addRect({ x: wx - 1.1, y: wy - 5, width: 2.2, height: 4 });
    heads.addCircle(wx, wy - 6.2, 1.25);
  }

  for (const v of visible) {
    const ag = scene.agents[v.a];
    const { gx, gy, ux, uy } = v;
    const wx = originX + (gx - gy) * HALF_W;
    const wy = originY + (gx + gy) * HALF_H;

    if (ag.kind === AGENT_PED) {
      const y = wy - (v.stopped ? 0 : Math.abs(Math.sin(t * 9 + v.a * 5)) * 0.8);
      shadows.addCircle(wx + 1.5, wy + 0.5, 1.4);
      shirts[ag.color].addRect({ x: wx - 1.1, y: y - 5, width: 2.2, height: 4 });
      heads.addCircle(wx, y - 6.2, 1.25);
      // Bulle d'humeur : 3 secondes toutes les 15 secondes environ.
      if (ag.bubble >= 0 && mod(t + v.a * 2.3, 15) < 3) bubbles.push({ x: wx + 4, y: y - 15, kind: ag.bubble });
      continue;
    }

    // Gabarits : demi-longueur L, demi-largeur W, hauteurs de caisse et de toit.
    const isAmbulance = ag.kind === AGENT_AMBULANCE;
    const isTruck = ag.kind === AGENT_TRUCK || ag.kind === AGENT_FIRETRUCK || ag.kind === AGENT_GARBAGE || ag.kind === AGENT_PLOW || isAmbulance;
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
    shadows.addPoly(sh, true);

    // Roues : 4 petits disques sombres sous la caisse.
    for (const [l, s] of [
      [0.65, 1],
      [0.65, -1],
      [-0.65, 1],
      [-0.65, -1],
    ]) {
      const qx = gx + ux * L * l + vx * W * s * 1.02;
      const qy = gy + uy * L * l + vy * W * s * 1.02;
      wheels.addCircle(originX + (qx - qy) * HALF_W, originY + (qx + qy) * HALF_H - 1.2, 1.5);
    }

    if (isBus) {
      // Caisse unique haute, bande vitrée continue.
      addBox(light[c], mid[c], dark[c], gx, gy, 1.5, 9, ux, uy, -L, L, W, originX, originY);
      addBox(light[c], glass, glassDark, gx, gy, 5, 7.5, ux, uy, -L * 0.98, L * 0.98, W * 1.01, originX, originY);
    } else if (isTruck) {
      // Cabine à l'avant + caisse/citerne/benne à l'arrière.
      const cargo = ag.kind === AGENT_TRUCK ? COLOR_TRUCK : c;
      addBox(light[cargo], mid[cargo], dark[cargo], gx, gy, 1.5, 9, ux, uy, -L, L * 0.25, W, originX, originY);
      // Ambulance : bande rouge sur les flancs de la cellule sanitaire.
      if (isAmbulance) addBox(scrap, red, red, gx, gy, 4.5, 6, ux, uy, -L * 0.98, L * 0.2, W * 1.01, originX, originY);
      addBox(light[c], mid[c], dark[c], gx, gy, 1.5, 7, ux, uy, L * 0.3, L, W * 0.95, originX, originY);
      addBox(light[c], glass, glassDark, gx, gy, 4.2, 6.6, ux, uy, L * 0.32, L * 0.98, W * 0.97, originX, originY);
    } else {
      // Voiture : caisse basse + habitacle vitré en retrait + toit.
      addBox(light[c], mid[c], dark[c], gx, gy, 1.5, 4.5, ux, uy, -L, L, W, originX, originY);
      addBox(light[c], glass, glassDark, gx, gy, 4.5, 7.2, ux, uy, -L * 0.45, L * 0.4, W * 0.82, originX, originY);
      // Phares (avant) et feux (arrière).
      const hx = gx + ux * L * 1.01;
      const hy = gy + uy * L * 1.01;
      headlights.addCircle(originX + (hx - hy) * HALF_W, originY + (hx + hy) * HALF_H - 3, 0.9);
      const rx = gx - ux * L * 1.01;
      const ry = gy - uy * L * 1.01;
      // Feux stop plus gros quand la voiture freine (arrêtée au feu).
      red.addCircle(originX + (rx - ry) * HALF_W, originY + (rx + ry) * HALF_H - 3, v.stopped ? 1.3 : 0.8);
    }

    // Gyrophares clignotants (police et ambulance bleu/rouge, pompiers rouge).
    if (ag.kind === AGENT_POLICE || ag.kind === AGENT_FIRETRUCK || isAmbulance) {
      const z = ag.kind === AGENT_POLICE ? 8.4 : 10.2;
      const lx = gx + ux * (ag.kind === AGENT_POLICE ? 0 : L * 0.6);
      const ly = gy + uy * (ag.kind === AGENT_POLICE ? 0 : L * 0.6);
      const sx = originX + (lx - ly) * HALF_W;
      const sy = originY + (lx + ly) * HALF_H - z;
      if (ag.kind === AGENT_POLICE || isAmbulance) {
        (blink ? red : blue).addCircle(sx - 1.4, sy, 1.3);
        (blink ? blue : red).addCircle(sx + 1.4, sy, 1.3);
      } else if (blink) {
        red.addCircle(sx, sy, 1.6);
      }
    }
    // Chasse-neige : lame à l'avant et gyrophare orange.
    if (ag.kind === AGENT_PLOW) {
      addBox(scrap, dark[c], dark[c], gx, gy, 0.5, 3, ux, uy, L * 1.0, L * 1.18, W * 1.35, originX, originY);
      if (blink) {
        const lx = gx + ux * L * 0.6;
        const ly = gy + uy * L * 0.6;
        lamps[LIGHT_YELLOW].addCircle(originX + (lx - ly) * HALF_W, originY + (lx + ly) * HALF_H - 10.2, 1.5);
      }
    }
  }

  canvas.drawPath(poles.detach(), makePaint('#2c3e50'));
  canvas.drawPath(lightHeads.detach(), makePaint('#17202a'));
  canvas.drawPath(lamps[LIGHT_GREEN].detach(), makePaint('#2ecc71'));
  canvas.drawPath(lamps[LIGHT_YELLOW].detach(), makePaint('#f1c40f'));
  canvas.drawPath(lamps[LIGHT_RED].detach(), makePaint('#ff3b30'));

  canvas.drawPath(shadows.detach(), makePaint('#000000', 0.25));
  canvas.drawPath(wheels.detach(), makePaint('#17202a'));
  for (let c = 0; c < nColors; c++) {
    canvas.drawPath(mid[c].detach(), makePaint(BODY_MID[c]));
    canvas.drawPath(dark[c].detach(), makePaint(BODY_DARK[c]));
    canvas.drawPath(light[c].detach(), makePaint(BODY_LIGHT[c]));
  }
  canvas.drawPath(glass.detach(), makePaint('#85c1e9'));
  canvas.drawPath(glassDark.detach(), makePaint('#2e6f9e'));
  canvas.drawPath(headlights.detach(), makePaint('#fef9e7'));
  canvas.drawPath(red.detach(), makePaint('#ff3b30'));
  canvas.drawPath(blue.detach(), makePaint('#2f80ff'));
  scrap.detach();

  const outline = makePaint('#000000', 0.35);
  outline.setStyle(PaintStyle.Stroke);
  outline.setStrokeWidth(0.5);
  for (let c = 0; c < shirts.length; c++) {
    const path = shirts[c].detach();
    canvas.drawPath(path, makePaint(SHIRT_COLORS[c]));
    canvas.drawPath(path, outline);
  }
  canvas.drawPath(heads.detach(), makePaint('#f5cba7'));
  for (const b of bubbles) drawBubble(canvas, b.x, b.y, b.kind);
}

/**
 * Flammes qui vacillent et fumée qui monte, au sommet des bâtiments en feu.
 * Dessinées dans un calque au-dessus des bâtiments pour rester visibles.
 */
export function drawFires(canvas: SkCanvas, fires: FireSpot[], timeMs: number, gridSize: number, view: ViewRect, rot = 0) {
  'worklet';
  if (!fires.length) return;
  const { originX, originY } = getOrigin(gridSize);
  const t = timeMs / 1000;
  const flames = Skia.PathBuilder.Make();
  const cores = Skia.PathBuilder.Make();
  const smoke = Skia.PathBuilder.Make();
  for (const f of fires) {
    const [fgx, fgy] = pointToView(f.gx, f.gy, gridSize, rot);
    const fx = originX + (fgx - fgy) * HALF_W;
    const fy = originY + (fgx + fgy) * HALF_H - f.z;
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
  canvas.drawPath(smoke.detach(), makePaint('#5d6d7e', 0.5));
  canvas.drawPath(flames.detach(), makePaint('#e67e22', 0.95));
  canvas.drawPath(cores.detach(), makePaint('#f9e79f'));
}

/** Rames de métro en va-et-vient sur les lignes (vue souterraine de l'outil Métro). */
export function drawMetro(canvas: SkCanvas, scene: AgentsScene, timeMs: number, gridSize: number, rot = 0) {
  'worklet';
  if (!scene.metro.length) return;
  const { originX, originY } = getOrigin(gridSize);
  const t = timeMs / 1000;
  const train = Skia.PathBuilder.Make();
  const windows = Skia.PathBuilder.Make();
  scene.metro.forEach((m0, n) => {
    const [ax, ay] = pointToView(m0.ax, m0.ay, gridSize, rot);
    const [bx, by] = pointToView(m0.bx, m0.by, gridSize, rot);
    const len = Math.hypot(bx - ax, by - ay) || 1;
    // Va-et-vient avec accélération / freinage en station.
    const u = (1 - Math.cos(((t * 1.6) / len + n * 0.7) * Math.PI)) / 2;
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    for (let car = 0; car < 3; car++) {
      const s = u * len - car * 0.55 * (u > 0.5 ? 1 : -1);
      const cxg = ax + ux * Math.max(0, Math.min(len, s));
      const cyg = ay + uy * Math.max(0, Math.min(len, s));
      const x = originX + (cxg - cyg) * HALF_W;
      const y = originY + (cxg + cyg) * HALF_H;
      train.addCircle(x, y, 7);
      windows.addCircle(x, y - 1.2, 3);
    }
  });
  canvas.drawPath(train.detach(), makePaint('#ecf0f1'));
  canvas.drawPath(windows.detach(), makePaint('#16a085'));
}
