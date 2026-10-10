import {
  BlendMode,
  createPicture,
  PaintStyle,
  Skia,
  StrokeJoin,
  type SkCanvas,
  type SkPaint,
  type SkPath,
  type SkPathBuilder,
} from '@shopify/react-native-skia';

import { isMonument, isRoadType, SERVICE_TYPES, tileIndex, type RoadType, type ServiceType, type Tile } from './map';
import { getOrigin, getWorldSize, gridToWorld, HALF_H, HALF_W, tileDiamond, type IsoOrigin, type Point } from './iso';
import { PALETTE, shade } from './palette';

export const COLORS = { background: PALETTE.background, highlight: PALETTE.highlight };

/**
 * Direction du soleil : décalage écran de l'ombre par pixel de hauteur.
 * Orientée vers le bas-droite. L'ombre est recalculée à partir de la hauteur
 * réelle de chaque prisme (ombres "dynamiques").
 */
export const SUN = { x: 0.6, y: 0.3 };

/** Profondeur des falaises de terre sur les bords sud de la carte. */
const CLIFF_DEPTH = 14;

// ---------------------------------------------------------------------------
// Peintures (mises en cache par couleur / style)
// ---------------------------------------------------------------------------

const paintCache = new Map<string, SkPaint>();

function fillPaint(color: string): SkPaint {
  const key = `f${color}`;
  let p = paintCache.get(key);
  if (!p) {
    p = Skia.Paint();
    p.setAntiAlias(true);
    p.setColor(Skia.Color(color));
    paintCache.set(key, p);
  }
  return p;
}

function strokePaint(color: string, width: number): SkPaint {
  const key = `s${color}${width}`;
  let p = paintCache.get(key);
  if (!p) {
    p = Skia.Paint();
    p.setAntiAlias(true);
    p.setColor(Skia.Color(color));
    p.setStyle(PaintStyle.Stroke);
    p.setStrokeWidth(width);
    p.setStrokeJoin(StrokeJoin.Round);
    paintCache.set(key, p);
  }
  return p;
}

/** Un chemin unique par couleur : des milliers de polygones = un seul draw call. */
class PathBatch {
  private builders = new Map<string, SkPathBuilder>();
  get(key: string): SkPathBuilder {
    let b = this.builders.get(key);
    if (!b) {
      b = Skia.PathBuilder.Make();
      this.builders.set(key, b);
    }
    return b;
  }
  poly(key: string, pts: Point[]) {
    this.get(key).addPoly(pts, true);
  }
  /** Chemins finalisés, dans l'ordre de création des clés. */
  detachAll(): [string, SkPath][] {
    return [...this.builders.entries()].map(([k, b]) => [k, b.detach()]);
  }
}

// ---------------------------------------------------------------------------
// Géométrie
// ---------------------------------------------------------------------------

const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const up = (p: Point, z: number): Point => ({ x: p.x, y: p.y - z });

/** Hash déterministe (variations visuelles stables d'une tuile à l'autre). */
function hash01(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Enveloppe convexe (monotone chain) — sert à projeter les ombres. */
function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function polyPath(pts: Point[]): SkPath {
  return Skia.Path.Polygon(pts, true);
}

/** Chemin du losange de sol (réutilisé par la surbrillance). */
export function diamondPath(x: number, y: number, origin: IsoOrigin, z = 0) {
  const d = tileDiamond(x, y, origin, z);
  return polyPath([d.top, d.right, d.bottom, d.left]);
}

// ---------------------------------------------------------------------------
// Prismes extrudés
// ---------------------------------------------------------------------------

type Prism = {
  /** Décalage du centre en unités de grille (sous-objets : cheminées, etc.). */
  ox?: number;
  oy?: number;
  /** Emprise relative à la tuile (1 = tuile complète). */
  size: number;
  /** Altitude de la base et hauteur, en pixels. */
  z?: number;
  h: number;
  color: string;
  roof?: 'flat' | 'hip';
  roofColor?: string;
  roofHeight?: number;
  windows?: { floors: number; cols: number; color: string };
  /** Bande horizontale décorative (rayures de tour de refroidissement). */
  stripe?: { at: number; height: number; color: string };
  antenna?: number;
  /** Feuillage (arbres) ou réservoir sphérique posé au sommet du prisme. */
  blob?: { r: number; color: string };
  /** Décor peint sur le toit-terrasse. */
  decal?: 'cross' | 'helipad' | 'recycle' | 'field';
};

type Footprint = { top: Point; right: Point; bottom: Point; left: Point };

function footprint(center: Point, size: number, z: number): Footprint {
  const hw = HALF_W * size;
  const hh = HALF_H * size;
  const c = up(center, z);
  return {
    top: { x: c.x, y: c.y - hh },
    right: { x: c.x + hw, y: c.y },
    bottom: { x: c.x, y: c.y + hh },
    left: { x: c.x - hw, y: c.y },
  };
}

function prismCenter(tileCenter: Point, p: Prism): Point {
  const ox = p.ox ?? 0;
  const oy = p.oy ?? 0;
  return add(tileCenter, { x: (ox - oy) * HALF_W, y: (ox + oy) * HALF_H });
}

function addPrismShadow(shadows: SkPathBuilder, tileCenter: Point, p: Prism) {
  const base = footprint(prismCenter(tileCenter, p), p.blob ? Math.max(p.size, p.blob.r / HALF_W) : p.size, 0);
  const totalH = (p.z ?? 0) + p.h + (p.roof === 'hip' ? (p.roofHeight ?? 0) * 0.6 : 0) + (p.blob ? p.blob.r * 1.6 : 0);
  const off = { x: totalH * SUN.x, y: totalH * SUN.y };
  const corners = [base.top, base.right, base.bottom, base.left];
  shadows.addPoly(convexHull([...corners, ...corners.map((c) => add(c, off))]), true);
}

/** Fenêtres sur une face verticale : `a` -> `b` est l'arête du bas de la face. */
function addFaceWindows(path: SkPathBuilder, a: Point, b: Point, z: number, h: number, floors: number, cols: number) {
  const floorH = h / floors;
  const winH = floorH * 0.45;
  for (let f = 0; f < floors; f++) {
    const z0 = z + f * floorH + floorH * 0.3;
    for (let c = 0; c < cols; c++) {
      const s0 = (c + 0.25) / cols;
      const s1 = (c + 0.75) / cols;
      const p0 = lerp(a, b, s0);
      const p1 = lerp(a, b, s1);
      path.addPoly([up(p0, z0), up(p1, z0), up(p1, z0 + winH), up(p0, z0 + winH)], true);
    }
  }
}

function drawPrism(canvas: SkCanvas, tileCenter: Point, p: Prism) {
  const z = p.z ?? 0;
  const center = prismCenter(tileCenter, p);
  const base = footprint(center, p.size, z);
  const top = footprint(center, p.size, z + p.h);
  const outline = strokePaint(PALETTE.outline, 0.75);

  // Lumière venant du haut-gauche : face gauche moyenne, face droite sombre, toit clair.
  const leftFace = polyPath([base.left, base.bottom, top.bottom, top.left]);
  const rightFace = polyPath([base.bottom, base.right, top.right, top.bottom]);
  canvas.drawPath(leftFace, fillPaint(shade(p.color, -0.12)));
  canvas.drawPath(rightFace, fillPaint(shade(p.color, -0.38)));

  if (p.stripe) {
    const s0 = z + p.stripe.at;
    const s1 = s0 + p.stripe.height;
    const sb = footprint(center, p.size, s0);
    const st = footprint(center, p.size, s1);
    canvas.drawPath(polyPath([sb.left, sb.bottom, st.bottom, st.left]), fillPaint(p.stripe.color));
    canvas.drawPath(polyPath([sb.bottom, sb.right, st.right, st.bottom]), fillPaint(shade(p.stripe.color, -0.3)));
  }

  if (p.windows) {
    const { floors, cols, color } = p.windows;
    const wl = Skia.PathBuilder.Make();
    const wr = Skia.PathBuilder.Make();
    // `base` est déjà élevé de z : les fenêtres sont positionnées relativement à lui.
    addFaceWindows(wl, base.left, base.bottom, 0, p.h, floors, cols);
    addFaceWindows(wr, base.bottom, base.right, 0, p.h, floors, cols);
    canvas.drawPath(wl.detach(), fillPaint(color));
    canvas.drawPath(wr.detach(), fillPaint(shade(color, -0.35)));
  }

  canvas.drawPath(leftFace, outline);
  canvas.drawPath(rightFace, outline);

  if (p.roof === 'hip') {
    const roofColor = p.roofColor ?? shade(p.color, -0.3);
    const apex = up(center, z + p.h + (p.roofHeight ?? 8));
    // Pentes arrière d'abord, puis pentes avant (ordre peintre).
    const slopes: [Point[], number][] = [
      [[top.left, top.top, apex], 0.25],
      [[top.top, top.right, apex], 0.1],
      [[top.left, top.bottom, apex], -0.05],
      [[top.bottom, top.right, apex], -0.35],
    ];
    for (const [pts, f] of slopes) {
      const path = polyPath(pts);
      canvas.drawPath(path, fillPaint(shade(roofColor, f)));
      canvas.drawPath(path, outline);
    }
  } else {
    const roof = polyPath([top.top, top.right, top.bottom, top.left]);
    canvas.drawPath(roof, fillPaint(shade(p.roofColor ?? p.color, 0.22)));
    canvas.drawPath(roof, outline);
    // Petit rebord intérieur pour un toit-terrasse plus lisible.
    if (p.size >= 0.5) {
      const inner = footprint(center, p.size * 0.82, z + p.h);
      const rim = polyPath([inner.top, inner.right, inner.bottom, inner.left]);
      canvas.drawPath(rim, fillPaint(shade(p.roofColor ?? p.color, 0.08)));
    }
  }

  if (p.antenna) {
    const a = up(center, z + p.h);
    const antenna = Skia.Path.Polygon([a, up(a, p.antenna)], false);
    canvas.drawPath(antenna, strokePaint('#2c3e50', 1.2));
    canvas.drawCircle(a.x, a.y - p.antenna, 1.6, fillPaint('#e74c3c'));
  }

  if (p.decal) {
    const zTop = z + p.h;
    // Rectangle en coordonnées de grille relatives au centre du toit.
    const quad = (x0: number, y0: number, x1: number, y1: number) =>
      polyPath(
        [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ].map(([gx, gy]) => up({ x: center.x + (gx - gy) * HALF_W, y: center.y + (gx + gy) * HALF_H }, zTop)),
      );
    if (p.decal === 'cross') {
      const k = p.size * 0.32;
      const w = p.size * 0.09;
      canvas.drawPath(quad(-k, -w, k, w), fillPaint('#e74c3c'));
      canvas.drawPath(quad(-w, -k, w, k), fillPaint('#e74c3c'));
    } else if (p.decal === 'helipad') {
      const k = p.size * 0.3;
      canvas.drawPath(quad(-k, -k, k, k), fillPaint('#566573'));
      canvas.drawPath(quad(-k * 0.6, -k * 0.12, k * 0.6, k * 0.12), fillPaint('#f1c40f'));
    } else if (p.decal === 'recycle') {
      const k = p.size * 0.28;
      canvas.drawPath(quad(-k, -k, k, k), fillPaint('#ffffff'));
      canvas.drawPath(quad(-k * 0.7, -k * 0.7, k * 0.7, k * 0.7), fillPaint('#2e7d32'));
    } else {
      // Pelouse du stade avec les lignes.
      const k = p.size * 0.36;
      canvas.drawPath(quad(-k, -k * 0.7, k, k * 0.7), fillPaint('#2ecc71'));
      canvas.drawPath(quad(-0.01, -k * 0.7, 0.01, k * 0.7), fillPaint('#ffffff'));
    }
  }

  if (p.blob) {
    // Boule de feuillage ombrée : base sombre, reflet clair en haut à gauche.
    const c = up(center, z + p.h + p.blob.r * 0.7);
    canvas.drawCircle(c.x, c.y, p.blob.r, fillPaint(shade(p.blob.color, -0.25)));
    canvas.drawCircle(c.x - p.blob.r * 0.25, c.y - p.blob.r * 0.25, p.blob.r * 0.72, fillPaint(p.blob.color));
    canvas.drawCircle(c.x - p.blob.r * 0.4, c.y - p.blob.r * 0.45, p.blob.r * 0.3, fillPaint(shade(p.blob.color, 0.3)));
  }
}

/** Un arbre : tronc brun + boule de feuillage. */
function tree(ox: number, oy: number, scale = 1, color = '#1e8449'): Prism {
  return { ox, oy, size: 0.06, h: 5 * scale, color: '#6e4b2a', roof: 'flat', blob: { r: 6.5 * scale, color } };
}

/** Trier les sous-objets d'une tuile de l'arrière vers l'avant (ordre peintre). */
const byDepth = (a: Prism, b: Prism) => (a.ox ?? 0) + (a.oy ?? 0) - ((b.ox ?? 0) + (b.oy ?? 0));

// ---------------------------------------------------------------------------
// Catalogue des bâtiments (par type + densité)
// ---------------------------------------------------------------------------

function baseBuildingFor(tile: Tile): Prism[] {
  // Parcelle zonée mais pas encore construite : seul le sol (lot teinté) est dessiné.
  if (tile.density === 0 && (tile.type === 'R' || tile.type === 'C' || tile.type === 'I')) return [];
  const v = hash01(tile.x, tile.y);
  const v2 = hash01(tile.x, tile.y, 7);
  switch (tile.type) {
    case 'R':
      if (tile.density === 1)
        return [
          {
            size: 0.55,
            h: 9 + v * 3,
            color: shade(PALETTE.residential, 0.35),
            roof: 'hip',
            roofColor: v2 > 0.5 ? PALETTE.residentialRoof : PALETTE.residential,
            roofHeight: 9,
            windows: { floors: 1, cols: 2, color: PALETTE.windowR },
          },
        ];
      if (tile.density === 2)
        return [
          {
            size: 0.72,
            h: 24 + v * 8,
            color: PALETTE.residential,
            windows: { floors: 3, cols: 3, color: PALETTE.windowR },
          },
          { ox: -0.12, oy: -0.12, size: 0.16, z: 24 + v * 8, h: 4, color: '#95a5a6' },
        ];
      return [
        {
          size: 0.62,
          h: 56 + v * 22,
          color: shade(PALETTE.residential, -0.05),
          windows: { floors: 8, cols: 3, color: PALETTE.windowR },
          antenna: v2 > 0.5 ? 10 : 0,
        },
      ];
    case 'C':
      if (tile.density === 1)
        return [
          {
            size: 0.8,
            h: 12 + v * 3,
            color: PALETTE.commercial,
            windows: { floors: 1, cols: 3, color: PALETTE.windowC },
          },
        ];
      if (tile.density === 2)
        return [
          {
            size: 0.7,
            h: 34 + v * 10,
            color: PALETTE.commercial,
            windows: { floors: 5, cols: 4, color: PALETTE.windowC },
          },
        ];
      return [
        {
          size: 0.74,
          h: 52 + v * 14,
          color: shade(PALETTE.commercial, -0.1),
          windows: { floors: 8, cols: 4, color: PALETTE.windowC },
        },
        {
          size: 0.48,
          z: 52 + v * 14,
          h: 24 + v2 * 14,
          color: PALETTE.commercial,
          windows: { floors: 4, cols: 3, color: PALETTE.windowC },
          antenna: 14,
        },
      ];
    case 'I': {
      const blocks: Prism[] = [];
      const chimneys = tile.density;
      // Cheminées à l'arrière (dessinées avant le bloc qui les masque partiellement).
      for (let i = 0; i < chimneys; i++) {
        blocks.push({
          ox: -0.28 + i * 0.2,
          oy: -0.3,
          size: 0.13,
          h: 28 + tile.density * 6 + i * 4,
          color: PALETTE.chimney,
          stripe: { at: 22 + tile.density * 6 + i * 4, height: 3, color: '#c0392b' },
        });
      }
      blocks.push({
        size: 0.82,
        h: 10 + tile.density * 5 + v * 3,
        color: PALETTE.industrial,
        windows: { floors: 1, cols: 4, color: PALETTE.windowI },
      });
      return blocks;
    }
    case 'POWER':
      return [
        {
          ox: -0.22,
          oy: -0.2,
          size: 0.4,
          h: 50,
          color: PALETTE.coolingTower,
          stripe: { at: 38, height: 5, color: '#c0392b' },
        },
        {
          ox: 0.2,
          oy: -0.24,
          size: 0.34,
          h: 42,
          color: PALETTE.coolingTower,
          stripe: { at: 31, height: 5, color: '#c0392b' },
        },
        {
          ox: 0.06,
          oy: 0.2,
          size: 0.64,
          h: 20,
          color: PALETTE.power,
          windows: { floors: 1, cols: 3, color: PALETTE.windowPower },
        },
      ];
    case 'POLICE':
      return [
        { size: 0.74, h: 20, color: '#2e4a8a', windows: { floors: 2, cols: 3, color: '#d6eaf8' }, antenna: 9 },
        // Gyrophares sur le toit.
        { ox: -0.1, oy: 0.05, size: 0.09, z: 20, h: 3, color: '#e74c3c' },
        { ox: 0.05, oy: -0.1, size: 0.09, z: 20, h: 3, color: '#3498db' },
      ];
    case 'FIRE':
      return [
        // Tour de séchage des tuyaux, à l'arrière.
        { ox: -0.26, oy: -0.24, size: 0.24, h: 36, color: '#a93226', windows: { floors: 4, cols: 1, color: '#fadbd8' } },
        { size: 0.82, h: 16, color: '#c0392b', windows: { floors: 1, cols: 2, color: '#4a1c16' }, decal: 'helipad' },
      ];
    case 'HOSPITAL':
      return [
        { ox: -0.18, oy: -0.18, size: 0.5, h: 40, color: '#dfe6e9', windows: { floors: 6, cols: 2, color: '#aed6f1' } },
        { size: 0.84, h: 18, color: '#ecf0f1', windows: { floors: 2, cols: 4, color: '#aed6f1' }, decal: 'cross' },
      ];
    case 'SCHOOL':
      return [
        { ox: -0.24, oy: -0.24, size: 0.18, h: 28, color: '#d35400', roof: 'hip', roofColor: '#a04000', roofHeight: 7, antenna: 6 },
        { size: 0.84, h: 14, color: '#e67e22', windows: { floors: 2, cols: 4, color: '#fdebd0' }, roof: 'hip', roofColor: '#922b21', roofHeight: 8 },
      ];
    case 'WATER':
      return [
        { size: 0.12, h: 24, color: '#7f8c8d' },
        { size: 0.46, z: 24, h: 14, color: '#5dade2', roof: 'hip', roofColor: '#2e86c1', roofHeight: 6, stripe: { at: 6, height: 2, color: '#ecf0f1' } },
        { ox: 0.28, oy: 0.26, size: 0.26, h: 8, color: '#95a5a6', windows: { floors: 1, cols: 1, color: '#d6eaf8' } },
      ];
    case 'METRO':
      return [
        { ox: -0.05, oy: -0.05, size: 0.56, h: 10, color: '#16a085', windows: { floors: 1, cols: 2, color: '#0b5345' } },
        // Totem "M" : poteau + panneau.
        { ox: 0.3, oy: 0.18, size: 0.05, h: 16, color: '#2c3e50' },
        { ox: 0.3, oy: 0.18, size: 0.16, z: 16, h: 8, color: '#f1c40f', stripe: { at: 3, height: 2, color: '#16a085' } },
      ];
    case 'PARK':
      return [
        tree(-0.26, -0.22, 1.1),
        tree(0.24, -0.26, 0.9, '#239b56'),
        { size: 0.18, h: 2, color: '#85929e', blob: { r: 3, color: '#5dade2' } },
        tree(-0.22, 0.26, 0.95, '#239b56'),
        tree(0.26, 0.22, 1.15),
      ];
    case 'FOREST': {
      // Forêt dense : 4 à 5 arbres de tailles variées.
      const trees: Prism[] = [];
      const n = 4 + (v > 0.5 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const ox = hash01(tile.x, tile.y, 40 + k) * 0.7 - 0.35;
        const oy = hash01(tile.x, tile.y, 60 + k) * 0.7 - 0.35;
        trees.push(tree(ox, oy, 0.85 + hash01(tile.x, tile.y, 80 + k) * 0.6, k % 2 ? '#1e8449' : '#196f3d'));
      }
      return trees.sort(byDepth);
    }
    case 'LANDFILL': {
      // Tas d'ordures qui montent avec le remplissage.
      const h = 3 + tile.garbage * 1.6;
      const heaps: Prism[] = [
        { ox: -0.15, oy: -0.1, size: 0.5, h, color: '#7b6a58', roof: 'hip', roofColor: '#8e8e5a', roofHeight: 4 + tile.garbage },
        { ox: 0.2, oy: 0.18, size: 0.38, h: h * 0.7, color: '#6e5c4a', roof: 'hip', roofColor: '#a1887f', roofHeight: 3 + tile.garbage * 0.6 },
        { ox: 0.3, oy: -0.28, size: 0.18, h: 6, color: '#f39c12' },
      ];
      return heaps.sort(byDepth);
    }
    case 'INCINERATOR':
      return [
        { ox: -0.24, oy: -0.24, size: 0.18, h: 46, color: '#7b7d7d', stripe: { at: 38, height: 4, color: '#c0392b' } },
        { size: 0.78, h: 18, color: '#6d4c41', windows: { floors: 1, cols: 3, color: '#f5b041' } },
      ];
    case 'RECYCLING':
      return [
        { size: 0.78, h: 14, color: '#43a047', windows: { floors: 1, cols: 3, color: '#c8e6c9' }, decal: 'recycle' },
        { ox: 0.32, oy: 0.3, size: 0.14, h: 6, color: '#1e88e5' },
        { ox: 0.32, oy: 0.06, size: 0.14, h: 6, color: '#fdd835' },
      ];
    case 'BUSSTOP':
      return [
        // Abri : toit sur deux poteaux + panneau.
        { ox: -0.12, oy: -0.2, size: 0.05, h: 9, color: '#566573' },
        { ox: 0.12, oy: -0.2, size: 0.05, h: 9, color: '#566573' },
        { oy: -0.2, size: 0.34, z: 9, h: 1.5, color: '#f39c12' },
        { ox: 0.3, oy: 0.28, size: 0.04, h: 13, color: '#2c3e50' },
        { ox: 0.3, oy: 0.28, size: 0.12, z: 13, h: 5, color: '#f39c12', stripe: { at: 2, height: 1.5, color: '#ffffff' } },
      ];
    case 'STADIUM':
      return [
        // Tribunes autour de la pelouse + 4 mâts d'éclairage.
        { ox: -0.4, oy: -0.4, size: 0.06, h: 30, color: '#95a5a6', blob: { r: 2.5, color: '#fef9e7' } },
        { size: 0.92, h: 12, color: '#e74c3c', roofColor: '#27ae60', windows: { floors: 2, cols: 6, color: '#fadbd8' }, decal: 'field' },
        { ox: 0.4, oy: -0.4, size: 0.06, h: 30, color: '#95a5a6', blob: { r: 2.5, color: '#fef9e7' } },
        { ox: -0.4, oy: 0.4, size: 0.06, h: 30, color: '#95a5a6', blob: { r: 2.5, color: '#fef9e7' } },
        { ox: 0.4, oy: 0.4, size: 0.06, h: 30, color: '#95a5a6', blob: { r: 2.5, color: '#fef9e7' } },
      ];
    case 'UNIVERSITY':
      return [
        // Bâtiment classique + tour à coupole.
        { ox: -0.2, oy: -0.2, size: 0.3, h: 38, color: '#d7ccc8', windows: { floors: 4, cols: 1, color: '#5d4037' }, blob: { r: 6, color: '#8e44ad' } },
        { size: 0.86, h: 20, color: '#efebe9', windows: { floors: 2, cols: 5, color: '#6d4c41' }, roof: 'hip', roofColor: '#8e44ad', roofHeight: 9 },
      ];
    case 'AIRPORT':
      return [
        // Tour de contrôle + terminal.
        { ox: -0.3, oy: -0.3, size: 0.1, h: 40, color: '#ecf0f1' },
        { ox: -0.3, oy: -0.3, size: 0.22, z: 40, h: 7, color: '#5dade2', windows: { floors: 1, cols: 2, color: '#d6eaf8' } },
        { ox: 0.22, oy: 0.18, size: 0.5, h: 10, color: '#f8f9f9', windows: { floors: 1, cols: 4, color: '#85c1e9' } },
      ];
    case 'LANDMARK':
      return [
        // Tour emblématique : étages qui s'affinent, couronne dorée, flèche.
        { size: 0.66, h: 40, color: '#b7950b', windows: { floors: 6, cols: 3, color: '#fcf3cf' } },
        { size: 0.48, z: 40, h: 34, color: '#d4ac0d', windows: { floors: 5, cols: 2, color: '#fcf3cf' } },
        { size: 0.3, z: 74, h: 22, color: '#f1c40f', windows: { floors: 3, cols: 1, color: '#fcf3cf' }, antenna: 22 },
      ];
    case 'GRASS': {
      // Arbres épars sur l'herbe (déterministes) : la campagne n'est plus vide.
      if (v > 0.1) return [];
      const n = v < 0.04 ? 2 : 1;
      const trees: Prism[] = [];
      for (let k = 0; k < n; k++) {
        trees.push(tree(hash01(tile.x, tile.y, 11 + k) * 0.6 - 0.3, hash01(tile.x, tile.y, 21 + k) * 0.6 - 0.3, 0.8 + v2 * 0.5, v2 > 0.5 ? '#1e8449' : '#239b56'));
      }
      return trees.sort(byDepth);
    }
    default:
      return [];
  }
}

/** Hauteur (px) du sommet du bâtiment d'une tuile — sert à placer les flammes. */
export function buildingHeight(tile: Tile): number {
  return baseBuildingFor(tile).reduce((m, p) => Math.max(m, prismTop(p)), 0);
}

/** Bâtiment d'une tuile, calciné et aux fenêtres rougeoyantes s'il brûle. */
function buildingFor(tile: Tile): Prism[] {
  const prisms = baseBuildingFor(tile);
  if (tile.type === 'POWER' && tile.flood > 0) {
    // Centrale en panne : éteinte et grisée.
    return prisms.map((p) => ({ ...p, color: shade(p.color, -0.35), windows: p.windows ? { ...p.windows, color: '#34495e' } : undefined }));
  }
  if (tile.fire === 0) return prisms;
  return prisms.map((p) => ({
    ...p,
    color: shade(p.color, -0.55),
    roofColor: p.roofColor ? shade(p.roofColor, -0.55) : undefined,
    windows: p.windows ? { ...p.windows, color: '#ff8c1a' } : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Sol (herbe, terre, routes, parcelles)
// ---------------------------------------------------------------------------

function isRoad(tiles: Tile[], size: number, x: number, y: number) {
  return x >= 0 && y >= 0 && x < size && y < size && isRoadType(tiles[tileIndex(x, y, size)].type);
}

/** Bande fine (polygone) entre deux points, d'épaisseur `w` pixels. */
function strip(batch: PathBatch, key: string, p0: Point, p1: Point, w: number) {
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
  const n = { x: (-(p1.y - p0.y) / len) * w, y: ((p1.x - p0.x) / len) * w };
  batch.poly(key, [add(p0, n), add(p1, n), add(p1, { x: -n.x, y: -n.y }), add(p0, { x: -n.x, y: -n.y })]);
}

const ROAD_SURFACE = { ROAD: PALETTE.asphalt, AVENUE: PALETTE.avenue, HIGHWAY: PALETTE.highway } as const;

function addRoad(batch: PathBatch, tiles: Tile[], size: number, tile: Tile, origin: IsoOrigin) {
  const d = tileDiamond(tile.x, tile.y, origin);
  const kind = tile.type as RoadType;
  const diamond = [d.top, d.right, d.bottom, d.left];
  if (tile.lake) {
    // Pont : l'eau dessous, le tablier un peu en retrait, garde-corps sur les côtés libres.
    batch.poly('water:' + PALETTE.lake, diamond);
    batch.poly('fill:' + ROAD_SURFACE[kind], footprintPts(mid(d.top, d.bottom), 0.94));
  } else {
    batch.poly('fill:' + ROAD_SURFACE[kind], diamond);
  }

  const center = mid(d.top, d.bottom);
  // Voisins : x+1 partage l'arête droite->bas (SE), x-1 haut->gauche (NO),
  // y+1 gauche->bas (SO), y-1 haut->droite (NE).
  const edges = [
    { on: isRoad(tiles, size, tile.x + 1, tile.y), a: d.right, b: d.bottom },
    { on: isRoad(tiles, size, tile.x - 1, tile.y), a: d.left, b: d.top },
    { on: isRoad(tiles, size, tile.x, tile.y + 1), a: d.bottom, b: d.left },
    { on: isRoad(tiles, size, tile.x, tile.y - 1), a: d.top, b: d.right },
  ];
  if (!edges.some((e) => e.on)) {
    edges[0].on = true;
    edges[1].on = true;
  }

  const crossroads = edges.filter((e) => e.on).length >= 3;

  for (const e of edges) {
    const m = mid(e.a, e.b);
    if (e.on && crossroads) {
      // Carrefour : passage piéton (bandes blanches) le long de chaque branche, pas de ligne médiane.
      for (let k = 0; k < 5; k++) {
        const s0 = 0.12 + k * 0.16;
        const s1 = s0 + 0.09;
        const p0 = lerp(e.a, e.b, s0);
        const p1 = lerp(e.a, e.b, s1);
        batch.poly('deco:' + PALETTE.crosswalk, [lerp(p0, center, 0.08), lerp(p1, center, 0.08), lerp(p1, center, 0.3), lerp(p0, center, 0.3)]);
      }
    } else if (e.on && kind === 'ROAD') {
      // Rue : ligne médiane jaune en tirets.
      for (const [t0, t1] of [
        [0.12, 0.42],
        [0.62, 0.92],
      ]) strip(batch, 'deco:' + PALETTE.median, lerp(center, m, t0), lerp(center, m, t1), 0.9);
    } else if (e.on && kind === 'AVENUE') {
      // Avenue 4 voies : double ligne jaune continue au centre + tirets blancs entre les voies.
      const side = { x: (e.b.x - e.a.x) * 0.22, y: (e.b.y - e.a.y) * 0.22 };
      strip(batch, 'deco:' + PALETTE.median, add(center, { x: side.x * 0.08, y: side.y * 0.08 }), add(m, { x: side.x * 0.08, y: side.y * 0.08 }), 0.6);
      strip(batch, 'deco:' + PALETTE.median, add(center, { x: -side.x * 0.08, y: -side.y * 0.08 }), add(m, { x: -side.x * 0.08, y: -side.y * 0.08 }), 0.6);
      for (const sgn of [1, -1]) {
        const o = { x: side.x * sgn, y: side.y * sgn };
        strip(batch, 'deco:' + PALETTE.laneWhite, add(lerp(center, m, 0.2), o), add(lerp(center, m, 0.5), o), 0.6);
        strip(batch, 'deco:' + PALETTE.laneWhite, add(lerp(center, m, 0.7), o), add(lerp(center, m, 0.98), o), 0.6);
      }
    } else if (e.on && kind === 'HIGHWAY') {
      // Autoroute : séparateur central en béton + tirets blancs.
      strip(batch, 'deco:#d5d8dc', center, m, 1.6);
      const side = { x: (e.b.x - e.a.x) * 0.25, y: (e.b.y - e.a.y) * 0.25 };
      for (const sgn of [1, -1]) {
        const o = { x: side.x * sgn, y: side.y * sgn };
        strip(batch, 'deco:' + PALETTE.laneWhite, add(lerp(center, m, 0.15), o), add(lerp(center, m, 0.55), o), 0.6);
      }
    } else {
      // Trottoir (ou garde-corps sur un pont / une autoroute) sur les côtés non connectés.
      const a = lerp(e.a, center, 0.1);
      const b = lerp(e.b, center, 0.1);
      const path = batch.get(tile.lake || kind === 'HIGHWAY' ? 'rail' : 'curb');
      path.moveTo(a.x, a.y);
      path.lineTo(b.x, b.y);
    }
  }
}

function footprintPts(center: Point, size: number): Point[] {
  const f = footprint(center, size, 0);
  return [f.top, f.right, f.bottom, f.left];
}

function addGround(batch: PathBatch, tiles: Tile[], size: number, tile: Tile, origin: IsoOrigin) {
  const d = tileDiamond(tile.x, tile.y, origin);
  const diamond = [d.top, d.right, d.bottom, d.left];
  const center = mid(d.top, d.bottom);
  const pave = () => {
    batch.poly('fill:' + PALETTE.pavement, diamond);
    batch.poly('stroke:' + PALETTE.pavementBorder, diamond);
  };

  switch (tile.type) {
    case 'ROAD':
    case 'AVENUE':
    case 'HIGHWAY':
      addRoad(batch, tiles, size, tile, origin);
      break;
    case 'LAKE': {
      batch.poly('water:' + PALETTE.lake, diamond);
      // Reflets : petites vaguelettes claires, placées de façon déterministe.
      const v = hash01(tile.x, tile.y, 3);
      const p0 = lerp(lerp(d.left, d.top, 0.5), center, 0.3 + v * 0.3);
      strip(batch, 'deco:' + PALETTE.lakeRipple, p0, add(p0, { x: 10, y: 0 }), 0.6);
      if (v > 0.5) {
        const p1 = lerp(lerp(d.right, d.bottom, 0.5), center, 0.3 + v * 0.2);
        strip(batch, 'deco:' + PALETTE.lakeRipple, p1, add(p1, { x: -8, y: 0 }), 0.6);
      }
      break;
    }
    case 'SAND':
      batch.poly('fill:' + PALETTE.sand, diamond);
      batch.poly('stroke:' + PALETTE.sandBorder, diamond);
      break;
    case 'FOREST':
      batch.poly('fill:' + PALETTE.forest, diamond);
      batch.poly('stroke:' + PALETTE.grassBorder, diamond);
      break;
    case 'DIRT':
      batch.poly('fill:' + PALETTE.dirt, diamond);
      batch.poly('stroke:' + PALETTE.dirtBorder, diamond);
      break;
    case 'R':
    case 'C':
    case 'I':
      if (tile.density === 0) {
        batch.poly('fill:' + PALETTE.zoneLot[tile.type], diamond);
        const inset = footprint(center, 0.86, 0);
        batch.poly('zone:' + PALETTE.zoneBorder[tile.type], [inset.top, inset.right, inset.bottom, inset.left]);
      } else {
        batch.poly('fill:' + PALETTE.pavement, diamond);
      }
      batch.poly('stroke:' + PALETTE.pavementBorder, diamond);
      break;
    case 'POWER':
      batch.poly('fill:' + PALETTE.powerGround, diamond);
      batch.poly('stroke:' + PALETTE.pavementBorder, diamond);
      break;
    case 'PARK': {
      batch.poly('fill:' + PALETTE.grassBorder, diamond);
      batch.poly('stroke:' + PALETTE.grassBorder, diamond);
      // Allées en croix.
      strip(batch, 'deco:' + PALETTE.parkPath, mid(d.top, d.left), mid(d.right, d.bottom), 2);
      strip(batch, 'deco:' + PALETTE.parkPath, mid(d.top, d.right), mid(d.left, d.bottom), 2);
      break;
    }
    case 'LANDFILL':
      batch.poly('fill:#8d6e63', diamond);
      batch.poly('stroke:#6d4c41', diamond);
      break;
    case 'AIRPORT': {
      pave();
      // Piste : bande sombre en diagonale avec marquage blanc.
      const a = lerp(d.left, d.top, 0.5);
      const b = lerp(d.right, d.bottom, 0.5);
      strip(batch, 'deco:' + PALETTE.runway, a, b, 7);
      for (let k = 0; k < 4; k++) strip(batch, 'deco:' + PALETTE.laneWhite, lerp(a, b, 0.1 + k * 0.22), lerp(a, b, 0.2 + k * 0.22), 0.8);
      break;
    }
    case 'STADIUM':
      batch.poly('fill:#27ae60', diamond);
      batch.poly('stroke:#1e8449', diamond);
      break;
    default:
      if (tile.type === 'GRASS') {
        batch.poly('fill:' + PALETTE.grass, diamond);
        batch.poly('stroke:' + PALETTE.grassBorder, diamond);
      } else pave();
  }

  // Inondation : voile d'eau translucide.
  if (tile.flood > 0 && tile.type !== 'POWER') batch.poly(`tint:${PALETTE.flood}:0.55`, diamond);

  // Falaises sur les bords sud-ouest et sud-est de la carte (bleues sous l'eau).
  const drop = { x: 0, y: CLIFF_DEPTH };
  const wet = tile.type === 'LAKE' || tile.lake;
  if (tile.y === size - 1) batch.poly(wet ? 'cliffWL' : 'cliffL', [d.left, d.bottom, add(d.bottom, drop), add(d.left, drop)]);
  if (tile.x === size - 1) batch.poly(wet ? 'cliffWR' : 'cliffR', [d.bottom, d.right, add(d.right, drop), add(d.bottom, drop)]);
}

function flushGround(canvas: SkCanvas, batch: PathBatch) {
  // Ordre : falaises, eau, remplissages, contours, détails, voiles.
  const order = (k: string) =>
    k.startsWith('cliff') ? 0 : k.startsWith('water:') ? 1 : k.startsWith('fill:') ? 2 : k.startsWith('stroke:') ? 3 : k.startsWith('tint:') ? 5 : 4;
  const entries = batch.detachAll().sort((a, b) => order(a[0]) - order(b[0]));
  for (const [key, path] of entries) {
    if (key === 'cliffL') canvas.drawPath(path, fillPaint(PALETTE.cliffLeft));
    else if (key === 'cliffR') canvas.drawPath(path, fillPaint(PALETTE.cliffRight));
    else if (key === 'cliffWL') canvas.drawPath(path, fillPaint(PALETTE.lakeDeep));
    else if (key === 'cliffWR') canvas.drawPath(path, fillPaint(shade(PALETTE.lakeDeep, -0.25)));
    else if (key === 'curb') canvas.drawPath(path, strokePaint(PALETTE.curb, 1.5));
    else if (key === 'rail') canvas.drawPath(path, strokePaint('#ecf0f1', 2));
    else if (key.startsWith('water:')) canvas.drawPath(path, fillPaint(key.slice(6)));
    else if (key.startsWith('fill:')) canvas.drawPath(path, fillPaint(key.slice(5)));
    else if (key.startsWith('stroke:')) canvas.drawPath(path, strokePaint(key.slice(7), 1));
    else if (key.startsWith('zone:')) canvas.drawPath(path, strokePaint(key.slice(5), 1.5));
    else if (key.startsWith('deco:')) canvas.drawPath(path, fillPaint(key.slice(5)));
    else if (key.startsWith('tint:')) {
      const [, color, alpha] = key.split(':');
      const paint = fillPaint(color).copy();
      paint.setAlphaf(Number(alpha));
      canvas.drawPath(path, paint);
    }
  }
}

// ---------------------------------------------------------------------------
// Indicateurs
// ---------------------------------------------------------------------------

/** Éclair jaune "pas de courant" flottant au-dessus d'une zone non alimentée (style SimCity). */
function drawNoPower(canvas: SkCanvas, center: Point, topZ: number) {
  const c = up(center, topZ + 14);
  const bg = Skia.Path.Polygon(
    [
      { x: c.x, y: c.y - 9 },
      { x: c.x + 9, y: c.y },
      { x: c.x, y: c.y + 9 },
      { x: c.x - 9, y: c.y },
    ],
    true,
  );
  canvas.drawPath(bg, fillPaint('#c0392b'));
  canvas.drawPath(bg, strokePaint('#ffffff', 1.2));
  const bolt = Skia.Path.Polygon(
    [
      { x: c.x + 1.5, y: c.y - 6 },
      { x: c.x - 3.5, y: c.y + 1 },
      { x: c.x - 0.2, y: c.y + 1 },
      { x: c.x - 1.5, y: c.y + 6 },
      { x: c.x + 3.5, y: c.y - 1 },
      { x: c.x + 0.2, y: c.y - 1 },
    ],
    true,
  );
  canvas.drawPath(bolt, fillPaint(PALETTE.median));
}

/** Goutte bleue "pas d'eau" : la zone ne pourra pas dépasser le niveau 1. */
function drawNoWater(canvas: SkCanvas, center: Point, topZ: number) {
  const c = up(center, topZ + 14);
  const drop = Skia.PathBuilder.Make();
  drop.moveTo(c.x, c.y - 9);
  drop.lineTo(c.x + 5.2, c.y - 0.5);
  drop.lineTo(c.x - 5.2, c.y - 0.5);
  drop.close();
  drop.addCircle(c.x, c.y + 1.5, 5.6);
  const path = drop.detach();
  canvas.drawPath(path, fillPaint('#2e86c1'));
  canvas.drawPath(path, strokePaint('#ffffff', 1.2));
  canvas.drawCircle(c.x - 1.8, c.y + 0.2, 1.4, fillPaint('#d6eaf8'));
}

function prismTop(p: Prism): number {
  return (p.z ?? 0) + p.h + (p.roof === 'hip' ? (p.roofHeight ?? 8) : 0) + (p.antenna ?? 0) + (p.blob ? p.blob.r * 1.7 : 0);
}

const isZone = (t: Tile) => t.type === 'R' || t.type === 'C' || t.type === 'I';

/** Sac poubelle + mouches : ordures non ramassées. */
function drawGarbage(canvas: SkCanvas, center: Point) {
  const c = add(center, { x: 12, y: 2 });
  canvas.drawCircle(c.x, c.y - 4, 4.5, fillPaint('#212f3c'));
  canvas.drawCircle(c.x + 5, c.y - 2.5, 3.5, fillPaint('#1c2833'));
  canvas.drawCircle(c.x - 1, c.y - 8.5, 1.2, fillPaint('#f1c40f'));
}

// ---------------------------------------------------------------------------
// Construction de la scène, en couches et en blocs
// ---------------------------------------------------------------------------
//
// La carte est découpée en blocs de CHUNK x CHUNK tuiles. Chaque bloc a ses
// SkPicture : sol, ombres, bâtiments et lumières de nuit. À l'écran, on ne
// rejoue que les blocs visibles (culling), dans l'ordre :
// sols -> ombres -> bâtiments bloc par bloc (lignes de blocs puis colonnes),
// ce qui respecte le depth sorting row-major de (0,0) vers (N-1,N-1).
// Quand une tuile change, seuls les blocs concernés sont ré-enregistrés.

export const CHUNK = 10;
/** Compatibilité. */
export const CHUNK_ROWS = CHUNK;

export type Block = { x0: number; x1: number; y0: number; y1: number };

function tileCenter(t: Tile, origin: IsoOrigin): Point {
  const p = gridToWorld(t.x, t.y, origin);
  return { x: p.x, y: p.y + HALF_H };
}

function worldRect(gridSize: number) {
  const { width, height } = getWorldSize(gridSize);
  return { x: 0, y: 0, width, height };
}

/** Rectangle écran (monde) couvert par un bloc, marge comprise pour les tours et les falaises. */
export function blockBounds(b: Block, gridSize: number) {
  const o = getOrigin(gridSize);
  return {
    x0: o.originX + (b.x0 - b.y1 - 1) * HALF_W - 8,
    x1: o.originX + (b.x1 - b.y0 + 1) * HALF_W + 8,
    y0: o.originY + (b.x0 + b.y0) * HALF_H - 140,
    y1: o.originY + (b.x1 + b.y1 + 2) * HALF_H + CLIFF_DEPTH + 30,
  };
}

function eachTile(tiles: Tile[], gridSize: number, b: Block, fn: (t: Tile) => void) {
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) fn(tiles[tileIndex(x, y, gridSize)]);
  }
}

/** Sol d'un bloc (herbe, eau, routes, parcelles, falaises). */
export function buildGroundPicture(tiles: Tile[], gridSize: number, b: Block) {
  const origin = getOrigin(gridSize);
  return createPicture((canvas) => {
    const ground = new PathBatch();
    eachTile(tiles, gridSize, b, (t) => addGround(ground, tiles, gridSize, t, origin));
    flushGround(canvas, ground);
  }, worldRect(gridSize));
}

/**
 * Ombres d'un bloc dans un seul chemin noir à 20 % : les ombres qui se
 * chevauchent fusionnent au lieu de s'additionner.
 */
export function buildShadowPicture(tiles: Tile[], gridSize: number, b?: Block) {
  const origin = getOrigin(gridSize);
  const block = b ?? { x0: 0, x1: gridSize - 1, y0: 0, y1: gridSize - 1 };
  return createPicture((canvas) => {
    const shadows = Skia.PathBuilder.Make();
    eachTile(tiles, gridSize, block, (t) => {
      const prisms = buildingFor(t);
      if (prisms.length === 0) return;
      const center = tileCenter(t, origin);
      for (const prism of prisms) addPrismShadow(shadows, center, prism);
    });
    canvas.drawPath(shadows.detach(), fillPaint(PALETTE.shadow));
  }, worldRect(gridSize));
}

/** Bâtiments (et indicateurs) d'un bloc, dans l'ordre row-major. */
export function buildBuildingPicture(tiles: Tile[], gridSize: number, b: Block) {
  const origin = getOrigin(gridSize);
  return createPicture((canvas) => {
    eachTile(tiles, gridSize, b, (t) => {
      const prisms = buildingFor(t);
      const center = tileCenter(t, origin);
      let top = 0;
      for (const prism of prisms) {
        drawPrism(canvas, center, prism);
        top = Math.max(top, prismTop(prism));
      }
      const needsPower =
        isZone(t) || isMonument(t.type) || (t.type !== 'PARK' && t.type !== 'BUSSTOP' && SERVICE_TYPES.includes(t.type as ServiceType));
      if (needsPower && !t.powered) drawNoPower(canvas, center, top);
      else if (isZone(t) && t.density > 0 && !t.water) drawNoWater(canvas, center, top);
      if (isZone(t) && t.garbage >= 5) drawGarbage(canvas, center);
    });
  }, worldRect(gridSize));
}

/**
 * Lumières de nuit d'un bloc : fenêtres allumées (environ 60 %), lampadaires le
 * long des routes, projecteurs du stade. Rejouées au-dessus du voile de nuit,
 * dans un calque à part : chaque bâtiment efface d'abord (mode Clear) les
 * lumières situées derrière sa silhouette, pour qu'aucune fenêtre ne
 * « traverse » un immeuble placé devant.
 */
export function buildLightsPicture(tiles: Tile[], gridSize: number, b: Block) {
  const origin = getOrigin(gridSize);
  return createPicture((canvas) => {
    const eraser = Skia.Paint();
    eraser.setBlendMode(BlendMode.Clear);
    const halo = fillPaint('#ffd27a').copy();
    halo.setAlphaf(0.16);
    let lit = Skia.PathBuilder.Make();
    let litDim = Skia.PathBuilder.Make();
    let halos = Skia.PathBuilder.Make();
    let lamps = Skia.PathBuilder.Make();
    let pending = false;
    const flush = () => {
      if (!pending) return;
      canvas.drawPath(halos.detach(), halo);
      canvas.drawPath(lit.detach(), fillPaint('#ffd27a'));
      canvas.drawPath(litDim.detach(), fillPaint('#e0a84f'));
      canvas.drawPath(lamps.detach(), fillPaint('#fff5d6'));
      lit = Skia.PathBuilder.Make();
      litDim = Skia.PathBuilder.Make();
      halos = Skia.PathBuilder.Make();
      lamps = Skia.PathBuilder.Make();
      pending = false;
    };
    eachTile(tiles, gridSize, b, (t) => {
      const center = tileCenter(t, origin);
      if (isRoadType(t.type) && (t.x + t.y) % 2 === 0) {
        const p = add(center, { x: -HALF_W * 0.55, y: -2 });
        lamps.addCircle(p.x, p.y - 6, 1.6);
        halos.addCircle(p.x, p.y - 2, 9);
        pending = true;
        return;
      }
      const prisms = buildingFor(t).filter((pr) => !pr.blob || t.type === 'STADIUM');
      if (!prisms.length) return;
      // Les lumières déjà posées derrière ce bâtiment sont masquées par sa silhouette.
      flush();
      const mask = Skia.PathBuilder.Make();
      for (const prism of prisms) {
        const pc = prismCenter(center, prism);
        const z = prism.z ?? 0;
        const base = footprint(pc, prism.size, z);
        const top = footprint(pc, prism.size, z + prism.h);
        const roof = prism.roof === 'hip' ? up(pc, z + prism.h + (prism.roofHeight ?? 8)) : top.top;
        mask.addPoly([base.left, base.bottom, base.right, top.right, roof, top.left], true);
      }
      canvas.drawPath(mask.detach(), eraser);
      if (t.fire > 0) return;
      for (const prism of prisms) {
        if (prism.blob && t.type === 'STADIUM') {
          const c = up(prismCenter(center, prism), (prism.z ?? 0) + prism.h + 2);
          halos.addCircle(c.x, c.y, 14);
          lamps.addCircle(c.x, c.y, 3);
          pending = true;
        }
        if (!prism.windows) continue;
        const base = footprint(prismCenter(center, prism), prism.size, prism.z ?? 0);
        const { floors, cols } = prism.windows;
        const floorH = prism.h / floors;
        const winH = floorH * 0.45;
        const faces: [Point, Point, SkPathBuilder][] = [
          [base.left, base.bottom, lit],
          [base.bottom, base.right, litDim],
        ];
        for (const [a, bb, path] of faces) {
          for (let f = 0; f < floors; f++) {
            for (let c = 0; c < cols; c++) {
              if (hash01(t.x * 7 + f, t.y * 13 + c, a === base.left ? 1 : 2) > 0.6) continue;
              const z0 = f * floorH + floorH * 0.3;
              const p0 = lerp(a, bb, (c + 0.25) / cols);
              const p1 = lerp(a, bb, (c + 0.75) / cols);
              path.addPoly([up(p0, z0), up(p1, z0), up(p1, z0 + winH), up(p0, z0 + winH)], true);
              pending = true;
            }
          }
        }
      }
    });
    flush();
  }, worldRect(gridSize));
}

/** Liste des blocs d'une carte, dans l'ordre de dessin (lignes de blocs puis colonnes). */
export function mapBlocks(gridSize: number): Block[] {
  const blocks: Block[] = [];
  for (let y0 = 0; y0 < gridSize; y0 += CHUNK) {
    for (let x0 = 0; x0 < gridSize; x0 += CHUNK) {
      blocks.push({ x0, y0, x1: Math.min(gridSize - 1, x0 + CHUNK - 1), y1: Math.min(gridSize - 1, y0 + CHUNK - 1) });
    }
  }
  return blocks;
}

/** Toute la carte en une seule image (aperçus, tests). */
export function buildMapPicture(tiles: Tile[], gridSize: number) {
  const blocks = mapBlocks(gridSize);
  const ground = blocks.map((b) => buildGroundPicture(tiles, gridSize, b));
  const shadows = blocks.map((b) => buildShadowPicture(tiles, gridSize, b));
  const buildings = blocks.map((b) => buildBuildingPicture(tiles, gridSize, b));
  return createPicture((canvas) => {
    for (const p of [...ground, ...shadows, ...buildings]) canvas.drawPicture(p);
  }, worldRect(gridSize));
}

// ---------------------------------------------------------------------------
// Vues de données (trafic, pollution, criminalité, valeur, déchets)
// ---------------------------------------------------------------------------

/** Dégradé vert -> jaune -> rouge. */
function heatColor(v: number): string {
  const t = Math.max(0, Math.min(1, v));
  const r = t < 0.5 ? Math.round(46 + (241 - 46) * (t / 0.5)) : Math.round(241 + (231 - 241) * ((t - 0.5) / 0.5));
  const g = t < 0.5 ? Math.round(204 + (196 - 204) * (t / 0.5)) : Math.round(196 + (76 - 196) * ((t - 0.5) / 0.5));
  const bl = t < 0.5 ? Math.round(113 + (15 - 113) * (t / 0.5)) : Math.round(15 + (60 - 15) * ((t - 0.5) / 0.5));
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}

/**
 * Carte thématique : chaque tuile teintée selon une valeur 0-1 (vert = bien,
 * rouge = mal). `roadsOnly` pour le trafic.
 */
export function buildDataPicture(tiles: Tile[], gridSize: number, values: (t: Tile, i: number) => number | null) {
  const origin = getOrigin(gridSize);
  return createPicture((canvas) => {
    const buckets = new Map<string, SkPathBuilder>();
    for (let i = 0; i < tiles.length; i++) {
      const v = values(tiles[i], i);
      if (v === null) continue;
      const color = heatColor(Math.round(v * 10) / 10);
      let bld = buckets.get(color);
      if (!bld) {
        bld = Skia.PathBuilder.Make();
        buckets.set(color, bld);
      }
      const d = tileDiamond(tiles[i].x, tiles[i].y, origin);
      bld.addPoly([d.top, d.right, d.bottom, d.left], true);
    }
    for (const [color, bld] of buckets) {
      const paint = fillPaint(color).copy();
      paint.setAlphaf(0.62);
      canvas.drawPath(bld.detach(), paint);
    }
  }, worldRect(gridSize));
}

// ---------------------------------------------------------------------------
// Cartes de couverture (affichées quand un outil de service est sélectionné)
// ---------------------------------------------------------------------------

export const COVERAGE_COLORS: Record<ServiceType, string> = {
  POLICE: '#3498db',
  FIRE: '#e74c3c',
  HOSPITAL: '#ecf0f1',
  SCHOOL: '#f39c12',
  WATER: '#5dade2',
  METRO: '#1abc9c',
  PARK: '#2ecc71',
  LANDFILL: '#a1887f',
  INCINERATOR: '#a1887f',
  RECYCLING: '#66bb6a',
  BUSSTOP: '#f39c12',
};

/**
 * Teinte chaque tuile selon la couverture du service (comme les "cartes" de
 * SimCity) : plus c'est opaque, mieux le quartier est desservi.
 */
export function buildCoveragePicture(tiles: Tile[], gridSize: number, service: ServiceType, coverage: Float32Array) {
  const origin = getOrigin(gridSize);
  return createPicture((canvas) => {
    const levels = [Skia.PathBuilder.Make(), Skia.PathBuilder.Make(), Skia.PathBuilder.Make()];
    for (let i = 0; i < tiles.length; i++) {
      const c = coverage[i];
      if (c <= 0) continue;
      const d = tileDiamond(tiles[i].x, tiles[i].y, origin);
      levels[c > 0.75 ? 2 : c > 0.5 ? 1 : 0].addPoly([d.top, d.right, d.bottom, d.left], true);
    }
    const color = COVERAGE_COLORS[service];
    levels.forEach((b, k) => {
      const paint = fillPaint(color).copy();
      paint.setAlphaf(0.18 + k * 0.12);
      canvas.drawPath(b.detach(), paint);
    });

    // Lignes de métro souterraines : chaque station reliée à la plus proche.
    if (service === 'METRO') {
      const stations = tiles.filter((t) => t.type === 'METRO');
      const line = strokePaint('#1abc9c', 7).copy();
      line.setAlphaf(0.9);
      const done = new Set<string>();
      for (const a of stations) {
        let best: Tile | null = null;
        let bestD = Infinity;
        for (const b of stations) {
          const dd = Math.hypot(a.x - b.x, a.y - b.y);
          if (b !== a && dd < bestD) {
            bestD = dd;
            best = b;
          }
        }
        if (!best) continue;
        const key = [a.x, a.y, best.x, best.y].sort().join(',');
        if (done.has(key)) continue;
        done.add(key);
        const pa = tileCenter(a, origin);
        const pb = tileCenter(best, origin);
        canvas.drawPath(Skia.Path.Polygon([pa, pb], false), line);
      }
    }
  }, worldRect(gridSize));
}
