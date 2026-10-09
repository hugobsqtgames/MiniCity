import { PaintStyle, Skia, type SkCanvas } from '@shopify/react-native-skia';

import type { Tile } from './map';
import { getOrigin, HALF_H, HALF_W } from './iso';
import { shade } from './palette';

/**
 * PNJ ambiants : voitures sur les routes, piétons sur les trottoirs.
 *
 * - Thread JS : quand le réseau routier change, on calcule pour chaque agent un
 *   itinéraire (marche aléatoire sur le graphe des routes, aller puis retour, donc
 *   une boucle fermée sans téléportation).
 * - Thread UI : à chaque image, `drawAgents` (worklet) interpole la position de
 *   chaque agent sur sa boucle à partir de l'horloge. Aucun re-render React.
 */

export const AGENT_CAR = 0;
export const AGENT_PED = 1;

export type Agent = {
  kind: number;
  /** Polyligne fermée, en coordonnées de grille flottantes (centre de tuile = x + 0.5). */
  gx: number[];
  gy: number[];
  /** Longueurs cumulées (en tuiles) à chaque point. */
  cum: number[];
  total: number;
  /** Tuiles par seconde. */
  speed: number;
  /** Décalage de départ sur la boucle (en tuiles). */
  phase: number;
  color: number;
};

export const CAR_COLORS = ['#e74c3c', '#ecf0f1', '#3498db', '#f39c12', '#8e44ad', '#2c3e50', '#16a085'];
/** Flancs des voitures : teinte de la carrosserie assombrie (précalculée côté JS). */
const CAR_SIDE_COLORS = CAR_COLORS.map((c) => shade(c, -0.45));
export const SHIRT_COLORS = ['#e67e22', '#9b59b6', '#3498db', '#e74c3c', '#ecf0f1', '#1abc9c'];

const MAX_CARS = 90;
const MAX_PEDS = 120;
const CAR_LANE = 0.2;
const SIDEWALK = 0.4;

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

/** Signature du réseau routier + taille de population (par paliers) : clé de recalcul des itinéraires. */
export function agentsSignature(tiles: Tile[], population: number): string {
  let h = 2166136261;
  let roads = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i].type === 'ROAD') {
      h = Math.imul(h ^ i, 16777619);
      roads++;
    }
  }
  return `${roads}:${h >>> 0}:${Math.floor(population / 250)}`;
}

function randomWalk(start: number, size: number, isRoad: Uint8Array, maxLen: number, rand: () => number): number[] {
  const seq = [start];
  let prev = -1;
  let cur = start;
  for (let k = 0; k < maxLen; k++) {
    const x = cur % size;
    const options: number[] = [];
    for (const n of [x + 1 < size ? cur + 1 : -1, x > 0 ? cur - 1 : -1, cur + size, cur - size]) {
      if (n >= 0 && n < isRoad.length && isRoad[n] && n !== prev) options.push(n);
    }
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

/** Points décalés d'un côté de la chaussée pour une suite de tuiles. */
function offsetPolyline(seq: number[], size: number, offset: (dx: number, dy: number) => number): [number[], number[]] {
  const gx: number[] = [];
  const gy: number[] = [];
  for (let i = 0; i + 1 < seq.length; i++) {
    const ax = (seq[i] % size) + 0.5;
    const ay = Math.floor(seq[i] / size) + 0.5;
    const bx = (seq[i + 1] % size) + 0.5;
    const by = Math.floor(seq[i + 1] / size) + 0.5;
    const dx = bx - ax;
    const dy = by - ay;
    // Perpendiculaire "à droite" du sens de marche (en espace grille).
    const k = offset(dx, dy);
    const px = -dy * k;
    const py = dx * k;
    gx.push(ax + px, bx + px);
    gy.push(ay + py, by + py);
  }
  return [gx, gy];
}

function makeAgent(kind: number, gx: number[], gy: number[], speed: number, rand: () => number, colors: number): Agent {
  // Fermer la boucle.
  gx.push(gx[0]);
  gy.push(gy[0]);
  const cum = [0];
  for (let i = 1; i < gx.length; i++) cum.push(cum[i - 1] + Math.hypot(gx[i] - gx[i - 1], gy[i] - gy[i - 1]));
  const total = cum[cum.length - 1];
  return { kind, gx, gy, cum, total, speed, phase: rand() * total, color: Math.floor(rand() * colors) };
}

/** Construit les itinéraires des voitures et des piétons pour la carte courante. */
export function buildAgents(tiles: Tile[], size: number, population: number): Agent[] {
  const isRoad = new Uint8Array(tiles.length);
  const roads: number[] = [];
  const sidewalks: number[] = [];
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i].type !== 'ROAD') continue;
    isRoad[i] = 1;
    roads.push(i);
  }
  if (roads.length < 2) return [];

  // Les piétons sortent des maisons et des commerces : routes bordées de R ou C construits.
  for (const i of roads) {
    const x = i % size;
    for (const n of [x + 1 < size ? i + 1 : -1, x > 0 ? i - 1 : -1, i + size, i - size]) {
      const t = n >= 0 && n < tiles.length ? tiles[n] : null;
      if (t && (t.type === 'R' || t.type === 'C') && t.density > 0) {
        sidewalks.push(i);
        break;
      }
    }
  }

  const rand = mulberry32(roads.length * 7919 + population);
  const agents: Agent[] = [];

  const cars = Math.min(MAX_CARS, Math.round(2 + roads.length / 6 + population / 150));
  for (let c = 0; c < cars; c++) {
    const seq = randomWalk(roads[Math.floor(rand() * roads.length)], size, isRoad, 24, rand);
    if (seq.length < 2) continue;
    // Aller sur la voie de droite, retour sur l'autre voie (le sens s'inverse avec la direction).
    const [fx, fy] = offsetPolyline(seq, size, () => CAR_LANE);
    const [bx, by] = offsetPolyline(seq.slice().reverse(), size, () => CAR_LANE);
    agents.push(makeAgent(AGENT_CAR, fx.concat(bx), fy.concat(by), 1.1 + rand() * 0.9, rand, CAR_COLORS.length));
  }

  const peds = sidewalks.length ? Math.min(MAX_PEDS, Math.round(population / 60)) : 0;
  for (let p = 0; p < peds; p++) {
    const seq = randomWalk(sidewalks[Math.floor(rand() * sidewalks.length)], size, isRoad, 4 + Math.floor(rand() * 6), rand);
    if (seq.length < 2) continue;
    // Toujours sur le même trottoir : l'aller et le retour réutilisent les mêmes points.
    const side = rand() < 0.5 ? SIDEWALK : -SIDEWALK;
    const [fx, fy] = offsetPolyline(seq, size, () => side);
    const bx = fx.slice().reverse();
    const by = fy.slice().reverse();
    agents.push(makeAgent(AGENT_PED, fx.concat(bx), fy.concat(by), 0.22 + rand() * 0.18, rand, SHIRT_COLORS.length));
  }
  return agents;
}

/** Rectangle visible, en coordonnées monde. */
export type ViewRect = { x0: number; y0: number; x1: number; y1: number };

/**
 * Dessine les agents visibles à l'instant `timeMs`. Worklet : s'exécute sur le
 * thread UI. Les agents hors de `view` sont ignorés (culling).
 */
export function drawAgents(canvas: SkCanvas, agents: Agent[], timeMs: number, gridSize: number, view: ViewRect) {
  'worklet';
  const origin = getOrigin(gridSize);
  const toX = (gx: number, gy: number) => origin.originX + (gx - gy) * HALF_W;
  const toY = (gx: number, gy: number) => origin.originY + (gx + gy) * HALF_H;
  const t = timeMs / 1000;

  const shadows = Skia.PathBuilder.Make();
  const sides = CAR_COLORS.map(() => Skia.PathBuilder.Make());
  const glass = Skia.PathBuilder.Make();
  const tops = CAR_COLORS.map(() => Skia.PathBuilder.Make());
  const shirts = SHIRT_COLORS.map(() => Skia.PathBuilder.Make());
  const heads = Skia.PathBuilder.Make();

  const L = 0.2; // demi-longueur d'une voiture (en tuiles)
  const W = 0.11; // demi-largeur
  const H = 6; // hauteur (px)

  for (let a = 0; a < agents.length; a++) {
    const ag = agents[a];
    const d = (ag.phase + t * ag.speed) % ag.total;
    let i = 0;
    while (i < ag.cum.length - 2 && ag.cum[i + 1] < d) i++;
    const segLen = ag.cum[i + 1] - ag.cum[i] || 1;
    const f = (d - ag.cum[i]) / segLen;
    const dx = ag.gx[i + 1] - ag.gx[i];
    const dy = ag.gy[i + 1] - ag.gy[i];
    const gx = ag.gx[i] + dx * f;
    const gy = ag.gy[i] + dy * f;
    const wx = toX(gx, gy);
    const wy = toY(gx, gy);
    if (wx < view.x0 || wx > view.x1 || wy < view.y0 || wy > view.y1) continue;

    if (ag.kind === AGENT_CAR) {
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const vx = -uy;
      const vy = ux;
      // Coins de l'empreinte (avant-droit, avant-gauche, arrière-gauche, arrière-droit).
      const cx = [gx + ux * L + vx * W, gx + ux * L - vx * W, gx - ux * L - vx * W, gx - ux * L + vx * W];
      const cy = [gy + uy * L + vy * W, gy + uy * L - vy * W, gy - uy * L - vy * W, gy - uy * L + vy * W];
      const px = cx.map((v, k) => toX(v, cy[k]));
      const py = cx.map((v, k) => toY(v, cy[k]));

      shadows.addPoly(
        px.map((v, k) => ({ x: v + 2.5, y: py[k] + 1.2 })),
        true,
      );
      for (let k = 0; k < 4; k++) {
        const n = (k + 1) % 4;
        sides[ag.color].addPoly(
          [
            { x: px[k], y: py[k] },
            { x: px[n], y: py[n] },
            { x: px[n], y: py[n] - H },
            { x: px[k], y: py[k] - H },
          ],
          true,
        );
      }
      tops[ag.color].addPoly(
        px.map((v, k) => ({ x: v, y: py[k] - H })),
        true,
      );
      // Pare-brise : bande sombre sur l'avant du toit.
      const gx0 = gx + ux * L * 0.15;
      const gy0 = gy + uy * L * 0.15;
      const gx1 = gx + ux * L * 0.7;
      const gy1 = gy + uy * L * 0.7;
      glass.addPoly(
        [
          { x: toX(gx1 + vx * W * 0.8, gy1 + vy * W * 0.8), y: toY(gx1 + vx * W * 0.8, gy1 + vy * W * 0.8) - H },
          { x: toX(gx1 - vx * W * 0.8, gy1 - vy * W * 0.8), y: toY(gx1 - vx * W * 0.8, gy1 - vy * W * 0.8) - H },
          { x: toX(gx0 - vx * W * 0.8, gy0 - vy * W * 0.8), y: toY(gx0 - vx * W * 0.8, gy0 - vy * W * 0.8) - H },
          { x: toX(gx0 + vx * W * 0.8, gy0 + vy * W * 0.8), y: toY(gx0 + vx * W * 0.8, gy0 + vy * W * 0.8) - H },
        ],
        true,
      );
    } else {
      // Piéton : corps + tête, avec un léger balancement de marche.
      const x = wx;
      const y = wy - Math.abs(Math.sin(t * 9 + ag.phase * 5)) * 0.8;
      shadows.addCircle(x + 1.5, wy + 0.5, 1.4);
      shirts[ag.color].addRect({ x: x - 1.1, y: y - 5, width: 2.2, height: 4 });
      heads.addCircle(x, y - 6.2, 1.25);
    }
  }

  const paint = (color: string, alpha = 1) => {
    const p = Skia.Paint();
    p.setAntiAlias(true);
    p.setColor(Skia.Color(color));
    p.setAlphaf(alpha);
    return p;
  };
  canvas.drawPath(shadows.detach(), paint('#000000', 0.25));
  for (let c = 0; c < sides.length; c++) canvas.drawPath(sides[c].detach(), paint(CAR_SIDE_COLORS[c]));
  for (let c = 0; c < tops.length; c++) canvas.drawPath(tops[c].detach(), paint(CAR_COLORS[c]));
  canvas.drawPath(glass.detach(), paint('#5d8aa8', 0.9));
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
