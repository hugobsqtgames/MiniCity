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

import { LEVEL_H } from '../sim/constants';
import { districtMap } from '../sim/districts';
import { isFacility, isPlant, isRail, isRoadType, isTunnel, LINE_RAIL, LINE_TRAM, tileIndex, type RoadType, type ServiceType, type Tile } from './map';
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
// Contexte de rendu : saison (arbres, fleurs, Noël) et taille de la carte (styles de quartier)
// ---------------------------------------------------------------------------

type Look = 'spring' | 'summer' | 'autumn' | 'winter' | 'christmas';
let look: Look = 'spring';
let lookSize = 0;

/** Saison affichée par les arbres et le sol. Renvoie vrai si elle a changé. */
export function setRenderSeason(month: number): boolean {
  const m = ((month % 12) + 12) % 12;
  const next: Look = m === 11 ? 'christmas' : m <= 1 ? 'winter' : m <= 4 ? 'spring' : m <= 7 ? 'summer' : m <= 10 ? 'autumn' : 'winter';
  if (next === look) return false;
  look = next;
  return true;
}
export const renderSeason = () => look;

/** Couleurs du feuillage selon la saison (deux teintes alternées). */
function foliage(k: number, x: number, y: number): string {
  const h = hash01(x, y, 90 + k);
  switch (look) {
    case 'autumn':
      return h < 0.35 ? '#d35400' : h < 0.65 ? '#e67e22' : h < 0.85 ? '#c0392b' : '#b7950b';
    case 'winter':
    case 'christmas':
      return h < 0.6 ? '#4d6b57' : '#5b7a66';
    case 'spring':
      return h < 0.15 ? '#f5b7b1' : k % 2 ? '#2ecc71' : '#28b463';
    default:
      return k % 2 ? '#1e8449' : '#196f3d';
  }
}

/** Style architectural du quartier d'une tuile (0 moderne, 1 classique, 2 brique, 3 coloré). */
function styleOf(tile: Tile): number {
  if (lookSize <= 0) return 0;
  const x = tile.ox ?? tile.x;
  const y = tile.oy ?? tile.y;
  if (x < 0 || y < 0 || x >= lookSize || y >= lookSize) return 0;
  return districtMap(lookSize).ids[y * lookSize + x] % 4;
}

/** Coordonnées d'origine (stables quand on tourne la vue) pour les variations visuelles. */
const ogx = (t: Tile) => t.ox ?? t.x;
const ogy = (t: Tile) => t.oy ?? t.y;
/** Hauteur écran du sol d'une tuile. */
const zOf = (t: Tile) => (t.type === 'LAKE' ? 0 : (t.elev ?? 0) * LEVEL_H);

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

/** Un sapin : tronc + cône vert sombre (persistant). */
function fir(ox: number, oy: number, scale = 1): Prism {
  return { ox, oy, size: 0.2 * scale, h: 3 * scale, color: '#6e4b2a', roof: 'hip', roofColor: '#145a32', roofHeight: 16 * scale };
}

/** Trier les sous-objets d'une tuile de l'arrière vers l'avant (ordre peintre). */
const byDepth = (a: Prism, b: Prism) => (a.ox ?? 0) + (a.oy ?? 0) - ((b.ox ?? 0) + (b.oy ?? 0));

// ---------------------------------------------------------------------------
// Catalogue des bâtiments (par type + densité)
// ---------------------------------------------------------------------------

/** Teintes des façades selon le style du quartier (même famille de couleur que la zone). */
const R_STYLE = [
  { wall: PALETTE.residential, roof: PALETTE.residentialRoof, alt: '#c0392b' },
  { wall: '#58d68d', roof: '#7b241c', alt: '#6e2c00' },
  { wall: '#1d8348', roof: '#5d6d7e', alt: '#a04000' },
  { wall: '#7dcea0', roof: '#2471a3', alt: '#d4ac0d' },
];
const C_STYLE = [
  { wall: PALETTE.commercial, glass: PALETTE.windowC },
  { wall: '#5d8aa8', glass: '#fdebd0' },
  { wall: '#21618c', glass: '#aed6f1' },
  { wall: '#48c9b0', glass: '#e8f8f5' },
];

function baseBuildingFor(tile: Tile): Prism[] {
  // Parcelle zonée mais pas encore construite : seul le sol (lot teinté) est dessiné.
  if (tile.density === 0 && (tile.type === 'R' || tile.type === 'C' || tile.type === 'I')) return [];
  const gx = ogx(tile);
  const gy = ogy(tile);
  const v = hash01(gx, gy);
  const v2 = hash01(gx, gy, 7);
  switch (tile.type) {
    case 'R': {
      const st = styleOf(tile);
      const S = R_STYLE[st];
      if (tile.density === 1)
        return [
          {
            size: 0.55,
            h: 9 + v * 3,
            color: shade(S.wall, 0.35),
            roof: 'hip',
            roofColor: v2 > 0.5 ? S.roof : S.alt,
            roofHeight: st === 1 ? 12 : 9,
            windows: { floors: 1, cols: 2, color: PALETTE.windowR },
          },
          ...(st === 3 ? [tree(0.32, 0.3, 0.6, foliage(1, gx, gy))] : []),
        ];
      if (tile.density === 2) {
        const h = 24 + v * 8;
        if (st === 1)
          // Immeuble classique : toit à pans et lucarnes.
          return [{ size: 0.72, h, color: S.wall, roof: 'hip', roofColor: S.roof, roofHeight: 10, windows: { floors: 3, cols: 3, color: PALETTE.windowR } }];
        return [
          { size: 0.72, h, color: S.wall, windows: { floors: 3, cols: 3, color: PALETTE.windowR } },
          { ox: -0.12, oy: -0.12, size: 0.16, z: h, h: 4, color: st === 2 ? '#a04000' : '#95a5a6' },
        ];
      }
      if (st === 0)
        // Tour moderne en gradins.
        return [
          { size: 0.64, h: 40 + v * 12, color: S.wall, windows: { floors: 6, cols: 3, color: PALETTE.windowR } },
          { size: 0.46, z: 40 + v * 12, h: 22 + v2 * 10, color: shade(S.wall, 0.1), windows: { floors: 3, cols: 2, color: PALETTE.windowR }, antenna: v2 > 0.5 ? 10 : 0 },
        ];
      if (st === 3)
        // Deux tours colorées.
        return [
          { ox: -0.16, oy: -0.16, size: 0.36, h: 60 + v * 16, color: S.wall, windows: { floors: 9, cols: 2, color: PALETTE.windowR } },
          { ox: 0.18, oy: 0.18, size: 0.36, h: 44 + v2 * 12, color: shade(S.wall, -0.15), windows: { floors: 7, cols: 2, color: PALETTE.windowR } },
        ];
      return [
        {
          size: 0.62,
          h: 56 + v * 22,
          color: shade(S.wall, -0.05),
          windows: { floors: 8, cols: 3, color: PALETTE.windowR },
          antenna: v2 > 0.5 ? 10 : 0,
          ...(st === 1 ? { roof: 'hip' as const, roofColor: S.roof, roofHeight: 12 } : {}),
        },
      ];
    }
    case 'C': {
      const st = styleOf(tile);
      const S = C_STYLE[st];
      if (tile.density === 1)
        return [
          {
            size: 0.8,
            h: 12 + v * 3,
            color: S.wall,
            windows: { floors: 1, cols: 3, color: S.glass },
            ...(st === 1 ? { roof: 'hip' as const, roofColor: '#922b21', roofHeight: 7 } : {}),
          },
        ];
      if (tile.density === 2)
        return [
          {
            size: 0.7,
            h: 34 + v * 10,
            color: S.wall,
            windows: { floors: 5, cols: 4, color: S.glass },
            antenna: st === 3 ? 8 : 0,
          },
        ];
      if (st === 3)
        // Tour de verre effilée.
        return [
          { size: 0.7, h: 30, color: shade(S.wall, -0.1), windows: { floors: 4, cols: 4, color: S.glass } },
          { size: 0.52, z: 30, h: 44 + v * 14, color: S.wall, windows: { floors: 7, cols: 3, color: S.glass } },
          { size: 0.3, z: 74 + v * 14, h: 16, color: shade(S.wall, 0.2), antenna: 18 },
        ];
      return [
        {
          size: 0.74,
          h: 52 + v * 14,
          color: shade(S.wall, -0.1),
          windows: { floors: 8, cols: 4, color: S.glass },
        },
        {
          size: 0.48,
          z: 52 + v * 14,
          h: 24 + v2 * 14,
          color: S.wall,
          windows: { floors: 4, cols: 3, color: S.glass },
          antenna: 14,
          ...(st === 1 ? { roof: 'hip' as const, roofColor: '#7b7d7d', roofHeight: 10, antenna: 0 } : {}),
        },
      ];
    }
    case 'I': {
      if (tile.spec === 1) {
        // Ferme : grange rouge, silos, tracteur.
        return ([
          { ox: -0.18, oy: -0.16, size: 0.42, h: 10 + tile.density * 2, color: '#a93226', roof: 'hip', roofColor: '#641e16', roofHeight: 9, windows: { floors: 1, cols: 2, color: '#fdebd0' } },
          { ox: 0.26, oy: -0.26, size: 0.16, h: 22 + tile.density * 4, color: '#d5d8dc', blob: { r: 4, color: '#aab7b8' } },
          ...(tile.density >= 2 ? [{ ox: 0.26, oy: 0.0, size: 0.14, h: 18, color: '#d5d8dc', blob: { r: 3.5, color: '#aab7b8' } }] : []),
          { ox: 0.18, oy: 0.3, size: 0.12, h: 4, color: '#27ae60' },
        ] as Prism[]).sort(byDepth);
      }
      if (tile.spec === 2) {
        // Scierie : hangar en bois, piles de rondins, cheminée.
        return ([
          { ox: -0.3, oy: -0.3, size: 0.12, h: 26 + tile.density * 4, color: '#7b7d7d' },
          { size: 0.62, h: 10 + tile.density * 4, color: '#a0522d', roof: 'hip', roofColor: '#6e2c00', roofHeight: 7, windows: { floors: 1, cols: 3, color: '#f5cba7' } },
          { ox: 0.32, oy: 0.18, size: 0.22, h: 4, color: '#8b5a2b' },
          { ox: 0.32, oy: 0.18, size: 0.18, z: 4, h: 3, color: '#a0522d' },
          { ox: 0.1, oy: 0.34, size: 0.2, h: 4, color: '#8b5a2b' },
        ] as Prism[]).sort(byDepth);
      }
      if (tile.spec === 3) {
        // Campus de haute technologie : verre bleu, toit végétalisé, antenne.
        return [
          { size: 0.8, h: 12 + tile.density * 6, color: '#2e86c1', roofColor: '#58d68d', windows: { floors: 1 + tile.density, cols: 5, color: '#d6eaf8' } },
          { ox: -0.16, oy: -0.16, size: 0.3, z: 12 + tile.density * 6, h: 8, color: '#5dade2', windows: { floors: 1, cols: 2, color: '#ebf5fb' }, antenna: 12 },
        ];
      }
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
      if (look === 'christmas')
        // Décembre : grand sapin décoré au centre du parc.
        return [
          tree(-0.26, -0.22, 1.1, foliage(0, gx, gy)),
          tree(0.24, -0.26, 0.9, foliage(1, gx, gy)),
          { size: 0.34, h: 3, color: '#6e4b2a', roof: 'hip', roofColor: '#145a32', roofHeight: 26 },
          { size: 0.02, z: 29, h: 0.5, color: '#f1c40f', blob: { r: 2.4, color: '#f7dc6f' } },
          tree(-0.22, 0.26, 0.95, foliage(2, gx, gy)),
          tree(0.26, 0.22, 1.15, foliage(3, gx, gy)),
        ];
      return [
        tree(-0.26, -0.22, 1.1, foliage(0, gx, gy)),
        tree(0.24, -0.26, 0.9, foliage(1, gx, gy)),
        { size: 0.18, h: 2, color: '#85929e', blob: { r: 3, color: look === 'winter' ? '#d6eaf8' : '#5dade2' } },
        tree(-0.22, 0.26, 0.95, foliage(2, gx, gy)),
        tree(0.26, 0.22, 1.15, foliage(3, gx, gy)),
      ];
    case 'FOREST': {
      // Forêt dense : 4 à 5 arbres de tailles variées.
      const trees: Prism[] = [];
      const n = 4 + (v > 0.5 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const ox = hash01(gx, gy, 40 + k) * 0.7 - 0.35;
        const oy = hash01(gx, gy, 60 + k) * 0.7 - 0.35;
        // Les conifères (un arbre sur trois) restent verts toute l'année.
        const pine = hash01(gx, gy, 20 + k) < 0.33;
        trees.push(pine ? fir(ox, oy, 0.85 + hash01(gx, gy, 80 + k) * 0.6) : tree(ox, oy, 0.85 + hash01(gx, gy, 80 + k) * 0.6, foliage(k, gx, gy)));
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
    case 'WIND':
      return [
        // Mât blanc et nacelle ; les pales tournent dans le calque des effets.
        { size: 0.16, h: 3, color: '#bdc3c7' },
        { size: 0.06, z: 3, h: 46, color: '#f8f9f9' },
        { size: 0.11, z: 49, h: 4, color: '#ecf0f1' },
      ];
    case 'SOLAR': {
      // Rangées de panneaux sombres sur gravier + onduleur.
      const panels: Prism[] = [];
      for (const [ox, oy] of [
        [-0.22, -0.22],
        [0.18, -0.22],
        [-0.22, 0.18],
        [0.18, 0.18],
      ]) {
        panels.push({ ox, oy, size: 0.34, z: 2, h: 2.5, color: '#1b4f72', roofColor: '#2874a6', windows: { floors: 1, cols: 3, color: '#5dade2' } });
      }
      panels.push({ ox: 0.36, oy: -0.4, size: 0.1, h: 6, color: '#d5d8dc' });
      return panels.sort(byDepth);
    }
    case 'NUCLEAR':
      return [
        // Deux grandes tours de refroidissement, un dôme de confinement, la salle des machines.
        { ox: -0.24, oy: -0.24, size: 0.46, h: 60, color: '#d5d8dc', stripe: { at: 46, height: 5, color: '#e74c3c' } },
        { ox: 0.24, oy: -0.24, size: 0.4, h: 52, color: '#d5d8dc', stripe: { at: 40, height: 5, color: '#e74c3c' } },
        { ox: -0.2, oy: 0.22, size: 0.36, h: 18, color: '#f2f3f4', blob: { r: 9, color: '#f8f9f9' } },
        { ox: 0.22, oy: 0.22, size: 0.42, h: 16, color: '#85929e', windows: { floors: 1, cols: 3, color: '#d6eaf8' } },
      ];
    case 'PORT':
      return ([
        // Entrepôt, piles de conteneurs et grue portuaire.
        { ox: -0.22, oy: -0.24, size: 0.42, h: 12, color: '#7f8c8d', roofColor: '#5d6d7e', windows: { floors: 1, cols: 3, color: '#d5dbdb' } },
        { ox: 0.24, oy: -0.2, size: 0.2, h: 6, color: '#c0392b' },
        { ox: 0.24, oy: -0.2, size: 0.2, z: 6, h: 6, color: '#2e86c1' },
        { ox: 0.24, oy: 0.06, size: 0.2, h: 6, color: '#28b463' },
        { ox: -0.2, oy: 0.2, size: 0.2, h: 6, color: '#f39c12' },
        // Grue : pylône, flèche continue vers l'eau, câble et conteneur suspendu.
        { ox: 0.24, oy: 0.3, size: 0.08, h: 38, color: '#f1c40f' },
        ...[0.17, 0.11, 0.05, -0.01, -0.07, -0.13, -0.19, -0.25, -0.31].map((ox) => ({ ox, oy: 0.3, size: 0.07, z: 36, h: 3, color: '#f39c12' })),
        { ox: -0.28, oy: 0.3, size: 0.02, z: 19, h: 17, color: '#2c3e50' },
        { ox: -0.28, oy: 0.3, size: 0.16, z: 14, h: 5, color: '#c0392b' },
      ] as Prism[]).sort(byDepth);
    case 'FREIGHT':
      return ([
        // Petite gare, wagons de marchandises sur les voies.
        { ox: -0.28, oy: -0.28, size: 0.32, h: 14, color: '#a04000', roof: 'hip', roofColor: '#6e2c00', roofHeight: 6, windows: { floors: 1, cols: 2, color: '#fae5d3' } },
        { ox: 0.18, oy: -0.08, size: 0.2, h: 7, color: '#784212' },
        { ox: 0.18, oy: 0.14, size: 0.2, h: 7, color: '#922b21' },
        { ox: 0.18, oy: 0.36, size: 0.2, h: 7, color: '#1e8449' },
        { ox: -0.12, oy: 0.24, size: 0.18, h: 6, color: '#2e86c1' },
        { ox: -0.12, oy: 0.24, size: 0.18, z: 6, h: 6, color: '#cb4335' },
      ] as Prism[]).sort(byDepth);
    case 'MARKET':
      return ([
        // Étals aux auvents colorés autour d'une petite halle.
        { size: 0.5, h: 10, color: '#d35400', roof: 'hip', roofColor: '#a04000', roofHeight: 8, windows: { floors: 1, cols: 3, color: '#fdebd0' } },
        { ox: -0.32, oy: -0.32, size: 0.18, h: 5, color: '#fdfefe', roof: 'hip', roofColor: '#e74c3c', roofHeight: 4 },
        { ox: 0.32, oy: -0.32, size: 0.18, h: 5, color: '#fdfefe', roof: 'hip', roofColor: '#f1c40f', roofHeight: 4 },
        { ox: -0.32, oy: 0.32, size: 0.18, h: 5, color: '#fdfefe', roof: 'hip', roofColor: '#3498db', roofHeight: 4 },
        { ox: 0.32, oy: 0.32, size: 0.18, h: 5, color: '#fdfefe', roof: 'hip', roofColor: '#27ae60', roofHeight: 4 },
      ] as Prism[]).sort(byDepth);
    case 'FAIR':
      return ([
        // Chapiteaux rayés et pieds de la grande roue (la roue tourne dans le calque des effets).
        { ox: -0.26, oy: 0.2, size: 0.34, h: 8, color: '#fdfefe', roof: 'hip', roofColor: '#e74c3c', roofHeight: 12, stripe: { at: 4, height: 2, color: '#e74c3c' } },
        { ox: 0.24, oy: 0.26, size: 0.26, h: 6, color: '#fdfefe', roof: 'hip', roofColor: '#f1c40f', roofHeight: 9 },
        { ox: -0.04, oy: -0.32, size: 0.05, h: 30, color: '#5d6d7e' },
        { ox: 0.16, oy: -0.32, size: 0.05, h: 30, color: '#5d6d7e' },
      ] as Prism[]).sort(byDepth);
    case 'ARENA':
      return [
        // Salle de concert : coque à dôme violet, enseigne lumineuse.
        { size: 0.86, h: 14, color: '#6c3483', windows: { floors: 1, cols: 5, color: '#f5b7b1' }, stripe: { at: 10, height: 2, color: '#f1c40f' } },
        { size: 0.6, z: 14, h: 6, color: '#7d3c98', blob: { r: 15, color: '#a569bd' } },
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
    case 'HIGHSCHOOL':
      return [
        { ox: -0.26, oy: -0.26, size: 0.2, h: 34, color: '#ba4a00', windows: { floors: 4, cols: 1, color: '#fdebd0' }, antenna: 8 },
        { size: 0.86, h: 22, color: '#ca6f1e', windows: { floors: 3, cols: 5, color: '#fdebd0' }, roofColor: '#a04000' },
      ];
    case 'PARKING': {
      // Voitures garées en épi (déterministes).
      const cars: Prism[] = [];
      const colors = ['#e74c3c', '#ecf0f1', '#3498db', '#f39c12', '#2c3e50', '#16a085'];
      for (let k = 0; k < 6; k++) {
        if (hash01(gx, gy, 100 + k) < 0.25) continue;
        const ox = -0.3 + (k % 3) * 0.3;
        const oy = k < 3 ? -0.22 : 0.22;
        cars.push({ ox, oy, size: 0.16, h: 4, color: colors[Math.floor(hash01(gx, gy, 120 + k) * colors.length)] });
      }
      cars.push({ ox: 0.42, oy: -0.42, size: 0.04, h: 12, color: '#2c3e50' }, { ox: 0.42, oy: -0.42, size: 0.12, z: 12, h: 6, color: '#2874a6', stripe: { at: 2, height: 2, color: '#ffffff' } });
      return cars.sort(byDepth);
    }
    case 'TREATMENT':
      return [
        // Bassins (au sol), bâtiment technique et digesteurs.
        { ox: -0.26, oy: -0.28, size: 0.22, h: 16, color: '#85929e', blob: { r: 5.5, color: '#aab7b8' } },
        { ox: 0.24, oy: 0.22, size: 0.3, h: 10, color: '#d5d8dc', windows: { floors: 1, cols: 2, color: '#d6eaf8' } },
      ];
    case 'STATION':
      return ([
        // Gare : bâtiment voyageurs à horloge et marquise au-dessus des quais.
        { ox: -0.26, oy: -0.26, size: 0.36, h: 16, color: '#cd6155', roof: 'hip', roofColor: '#7b241c', roofHeight: 8, windows: { floors: 1, cols: 2, color: '#fdebd0' } },
        { ox: -0.4, oy: -0.1, size: 0.1, h: 28, color: '#a93226', stripe: { at: 20, height: 4, color: '#fdfefe' } },
        { ox: 0.3, oy: 0.3, size: 0.04, h: 11, color: '#566573' },
        { ox: -0.05, oy: 0.3, size: 0.04, h: 11, color: '#566573' },
        { ox: 0.14, oy: 0.3, size: 0.4, z: 11, h: 1.5, color: '#d5d8dc' },
      ] as Prism[]).sort(byDepth);
    case 'HOTEL':
      return [
        { size: 0.66, h: 64 + v * 10, color: '#8e44ad', windows: { floors: 9, cols: 3, color: '#f5eef8' } },
        { ox: 0.0, oy: 0.0, size: 0.4, z: 64 + v * 10, h: 7, color: '#f1c40f', stripe: { at: 2, height: 2, color: '#8e44ad' } },
        { ox: 0.36, oy: 0.36, size: 0.18, h: 3, color: '#a569bd' },
      ];
    case 'RESORT': {
      // Parasols colorés et serviettes sur le sable.
      const items: Prism[] = [];
      const cols = ['#e74c3c', '#f1c40f', '#3498db', '#2ecc71', '#e67e22'];
      for (let k = 0; k < 4; k++) {
        const ox = -0.28 + (k % 2) * 0.5 + (hash01(gx, gy, 140 + k) - 0.5) * 0.1;
        const oy = -0.24 + Math.floor(k / 2) * 0.48;
        items.push({ ox, oy, size: 0.03, h: 9, color: '#fdfefe' });
        items.push({ ox, oy, size: 0.3, z: 9, h: 0.6, color: '#fdfefe', roof: 'hip', roofColor: cols[(k + Math.floor(v * 5)) % cols.length], roofHeight: 4 });
        items.push({ ox: ox + 0.12, oy: oy + 0.1, size: 0.12, h: 0.6, color: cols[(k + 2) % cols.length] });
      }
      return items.sort(byDepth);
    }
    case 'GRASS': {
      // Arbres épars sur l'herbe (déterministes) : la campagne n'est plus vide.
      if (v > 0.1) return [];
      const n = v < 0.04 ? 2 : 1;
      const trees: Prism[] = [];
      for (let k = 0; k < n; k++) {
        trees.push(tree(hash01(gx, gy, 11 + k) * 0.6 - 0.3, hash01(gx, gy, 21 + k) * 0.6 - 0.3, 0.8 + v2 * 0.5, foliage(k, gx, gy)));
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
  if (isPlant(tile.type) && tile.flood > 0) {
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
  const d = groundDiamond(tiles, size, tile, origin);
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
  // Tramway (rails noyés dans l'avenue) et passage à niveau.
  if (tile.line & LINE_TRAM) addRails(batch, tiles, size, tile, d, true, true);
  if (tile.line & LINE_RAIL) {
    batch.poly('fill:#5d6d7e', footprintPts(center, 0.5));
    addRails(batch, tiles, size, tile, d, true);
  }
}

function footprintPts(center: Point, size: number): Point[] {
  const f = footprint(center, size, 0);
  return [f.top, f.right, f.bottom, f.left];
}

/** Tuile voisine (ou null hors carte). */
const at = (tiles: Tile[], size: number, x: number, y: number) => (x >= 0 && y >= 0 && x < size && y < size ? tiles[y * size + x] : null);

/** Une route peut descendre en rampe vers une route voisine d'un niveau plus bas. */
const rampable = (t: Tile | null): t is Tile => !!t && ((isRoadType(t.type) && !t.lake && !isTunnel(t)) || t.type === 'RAIL');

/** Hauteur de chaque sommet du losange : les routes en pente forment des rampes. */
export function cornerHeights(tiles: Tile[], size: number, tile: Tile) {
  const z = zOf(tile);
  const c = { top: z, right: z, bottom: z, left: z };
  if (!rampable(tile)) return c;
  const low = (n: Tile | null) => rampable(n) && n.elev === tile.elev - 1;
  const L = z - LEVEL_H;
  if (low(at(tiles, size, tile.x + 1, tile.y))) c.right = c.bottom = L;
  if (low(at(tiles, size, tile.x - 1, tile.y))) c.left = c.top = L;
  if (low(at(tiles, size, tile.x, tile.y + 1))) c.bottom = c.left = L;
  if (low(at(tiles, size, tile.x, tile.y - 1))) c.top = c.right = L;
  return c;
}

/** Losange de sol d'une tuile, sommets à leur hauteur. */
function groundDiamond(tiles: Tile[], size: number, tile: Tile, origin: IsoOrigin) {
  const d = tileDiamond(tile.x, tile.y, origin);
  const c = cornerHeights(tiles, size, tile);
  return { top: up(d.top, c.top), right: up(d.right, c.right), bottom: up(d.bottom, c.bottom), left: up(d.left, c.left) };
}

/**
 * Falaises du relief : faces verticales sur les deux côtés visibles (avant
 * gauche et avant droit) quand la voisine est plus basse, et jusqu'au socle
 * sur les bords de la carte. Les portails de tunnel s'y découpent.
 */
function addCliffs(batch: PathBatch, tiles: Tile[], size: number, tile: Tile, origin: IsoOrigin) {
  const base = tileDiamond(tile.x, tile.y, origin);
  const c = cornerHeights(tiles, size, tile);
  const wet = tile.type === 'LAKE' || tile.lake;
  const rock = tile.elev >= 2;
  const sides: { n: Tile | null; a: 'left' | 'bottom'; b: 'bottom' | 'right'; na: 'top' | 'left'; nb: 'right' | 'top'; key: string }[] = [
    // y+1 : arête gauche → bas ; chez la voisine, son arête haut → droite.
    { n: at(tiles, size, tile.x, tile.y + 1), a: 'left', b: 'bottom', na: 'top', nb: 'right', key: 'L' },
    // x+1 : arête bas → droite ; chez la voisine, son arête gauche → haut.
    { n: at(tiles, size, tile.x + 1, tile.y), a: 'bottom', b: 'right', na: 'left', nb: 'top', key: 'R' },
  ];
  for (const s of sides) {
    const za = c[s.a];
    const zb = c[s.b];
    let na: number;
    let nb: number;
    if (!s.n) {
      na = -CLIFF_DEPTH;
      nb = -CLIFF_DEPTH;
    } else {
      const nc = cornerHeights(tiles, size, s.n);
      na = nc[s.na];
      nb = nc[s.nb];
    }
    if (za <= na + 0.5 && zb <= nb + 0.5) continue;
    const pa = base[s.a];
    const pb = base[s.b];
    const face = [up(pa, za), up(pb, zb), up(pb, Math.min(zb, nb)), up(pa, Math.min(za, na))];
    const key = !s.n ? (wet ? 'cliffW' : 'cliff') : rock ? 'rock' : 'cliff';
    batch.poly(key + s.key, face);
    // Strate d'herbe en haut de la falaise.
    if (s.n && !wet && tile.type !== 'SAND') strip(batch, 'deco:' + shade(PALETTE.grassBorder, -0.15), up(pa, za - 1.2), up(pb, zb - 1.2), 0.9);
    // Portail de tunnel : la route voisine plus basse s'enfonce dans la montagne.
    if (s.n && isTunnel(tile) && isRoadType(s.n.type) && !isTunnel(s.n)) {
      const m = lerp(pa, pb, 0.5);
      const zl = Math.min(za, na);
      const hw = 0.28;
      const p0 = lerp(pa, pb, 0.5 - hw);
      const p1 = lerp(pa, pb, 0.5 + hw);
      const arch: Point[] = [up(p0, zl), up(p0, zl + 8), up(lerp(p0, m, 0.5), zl + 11), up(m, zl + 12), up(lerp(m, p1, 0.5), zl + 11), up(p1, zl + 8), up(p1, zl)];
      batch.poly('deco:#8e9eab', arch.map((p, k) => (k === 0 || k === arch.length - 1 ? p : up(p, 2))));
      batch.poly('deco:#1c2833', arch);
    }
  }
}

/**
 * Voie ferrée : ballast, traverses et deux rails vers chaque voisine ferroviaire
 * (même logique de raccords que les routes). `over` = rails posés sur la chaussée.
 */
function addRails(batch: PathBatch, tiles: Tile[], size: number, tile: Tile, d: { top: Point; right: Point; bottom: Point; left: Point }, over: boolean, tram = false) {
  const center = mid(d.top, d.bottom);
  const link = (n: Tile | null) => !!n && (tram ? n.type === 'AVENUE' && (n.line & LINE_TRAM) !== 0 : isRail(n));
  const edges = [
    { on: link(at(tiles, size, tile.x + 1, tile.y)), a: d.right, b: d.bottom },
    { on: link(at(tiles, size, tile.x - 1, tile.y)), a: d.left, b: d.top },
    { on: link(at(tiles, size, tile.x, tile.y + 1)), a: d.bottom, b: d.left },
    { on: link(at(tiles, size, tile.x, tile.y - 1)), a: d.top, b: d.right },
  ];
  if (!edges.some((e) => e.on)) {
    edges[0].on = true;
    edges[1].on = true;
  }
  const gauge = tram ? 0.07 : 0.09;
  for (const e of edges) {
    if (!e.on) continue;
    const m = mid(e.a, e.b);
    const side = { x: (e.b.x - e.a.x) * gauge, y: (e.b.y - e.a.y) * gauge };
    if (!over) strip(batch, 'deco:#9a8478', center, m, 4.2);
    // Traverses.
    if (!over || tram) {
      for (const t of [0.2, 0.5, 0.8]) {
        const p = lerp(center, m, t);
        strip(batch, 'deco:' + (over ? '#566573' : '#6e4b2a'), add(p, { x: side.x * 1.6, y: side.y * 1.6 }), add(p, { x: -side.x * 1.6, y: -side.y * 1.6 }), 0.7);
      }
    }
    for (const sgn of [1, -1]) {
      const o = { x: side.x * sgn, y: side.y * sgn };
      strip(batch, 'deco:' + (tram ? '#2c3e50' : '#d5d8dc'), add(center, o), add(m, o), tram ? 0.45 : 0.55);
    }
  }
}

/** Ellipse posée au sol (bassins, piscines), approchée par un polygone. */
function groundEllipse(c: Point, r: number): Point[] {
  const pts: Point[] = [];
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2;
    pts.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r * 0.5 });
  }
  return pts;
}

/** Sommet de colline / montagne : herbe rase, roche et neige sur les sommets. */
function addHill(batch: PathBatch, tile: Tile, diamond: Point[]) {
  const color = tile.elev >= 3 ? PALETTE.rock : shade(PALETTE.grass, -0.12);
  batch.poly('fill:' + color, diamond);
  batch.poly('stroke:' + shade(color, -0.12), diamond);
  if (tile.elev >= 3) {
    // Calotte de neige au sommet (toute l'année).
    const c = mid(diamond[0], diamond[2]);
    batch.poly('deco:#f4f6f7', diamond.map((p) => lerp(c, p, 0.55)));
  }
}

/** Fleurs au printemps, feuilles mortes à l'automne, sur l'herbe. */
function addFlowers(batch: PathBatch, tile: Tile, d: { top: Point; right: Point; bottom: Point; left: Point }) {
  if (look !== 'spring' && look !== 'autumn') return;
  const gx = ogx(tile);
  const gy = ogy(tile);
  if (hash01(gx, gy, 5) > 0.35) return;
  const center = mid(d.top, d.bottom);
  const colors = look === 'spring' ? ['#f7dc6f', '#ec7063', '#ffffff', '#bb8fce'] : ['#d35400', '#e67e22', '#b9770e'];
  for (let k = 0; k < 5; k++) {
    const u = hash01(gx, gy, 30 + k) - 0.5;
    const w = hash01(gx, gy, 50 + k) - 0.5;
    const p = { x: center.x + (u - w) * HALF_W * 1.4, y: center.y + (u + w) * HALF_H * 1.4 };
    const c = colors[Math.floor(hash01(gx, gy, 70 + k) * colors.length)];
    batch.poly('deco:' + c, [
      { x: p.x, y: p.y - 1.3 },
      { x: p.x + 1.6, y: p.y },
      { x: p.x, y: p.y + 1.3 },
      { x: p.x - 1.6, y: p.y },
    ]);
  }
}

function addGround(batch: PathBatch, tiles: Tile[], size: number, tile: Tile, origin: IsoOrigin) {
  const d = tileDiamond(tile.x, tile.y, origin, zOf(tile));
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
      // Tunnel : la route passe sous la montagne, on ne voit que la montagne.
      if (isTunnel(tile)) addHill(batch, tile, diamond);
      else addRoad(batch, tiles, size, tile, origin);
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
      } else if (tile.type === 'I' && tile.spec === 1) {
        // Champs : bandes de culture alternées.
        batch.poly('fill:' + (look === 'winter' || look === 'christmas' ? '#a3876b' : look === 'summer' ? '#e9c46a' : '#7dbb5a'), diamond);
        for (let k = 1; k < 5; k++) strip(batch, 'deco:' + (look === 'summer' ? '#c9a227' : '#5e8f3e'), lerp(d.top, d.left, k / 5), lerp(d.right, d.bottom, k / 5), 1.2);
      } else if (tile.type === 'I' && tile.spec === 3) {
        batch.poly('fill:' + PALETTE.grass, diamond);
      } else {
        batch.poly('fill:' + PALETTE.pavement, diamond);
      }
      batch.poly('stroke:' + PALETTE.pavementBorder, diamond);
      break;
    case 'POWER':
    case 'NUCLEAR':
      batch.poly('fill:' + PALETTE.powerGround, diamond);
      batch.poly('stroke:' + PALETTE.pavementBorder, diamond);
      break;
    case 'WIND':
      batch.poly('fill:' + PALETTE.grass, diamond);
      batch.poly('stroke:' + PALETTE.grassBorder, diamond);
      break;
    case 'SOLAR':
    case 'FREIGHT': {
      batch.poly('fill:#aab7b8', diamond);
      batch.poly('stroke:#839192', diamond);
      if (tile.type === 'FREIGHT') {
        // Deux voies ferrées en diagonale.
        for (const o of [0.12, 0.32]) {
          const a = lerp(d.top, d.left, o + 0.2);
          const b = lerp(d.right, d.bottom, o + 0.2);
          strip(batch, 'deco:#5d4037', a, b, 2.4);
          strip(batch, 'deco:#2c3e50', a, b, 0.7);
        }
      }
      break;
    }
    case 'PORT': {
      pave();
      // Quai : bordure jaune côté eau.
      strip(batch, 'deco:#f1c40f', lerp(d.left, d.bottom, 0.1), lerp(d.left, d.bottom, 0.9), 1);
      break;
    }
    case 'FAIR':
      batch.poly('fill:#f5cba7', diamond);
      batch.poly('stroke:#e59866', diamond);
      break;
    case 'MARKET': {
      pave();
      const inset = footprint(center, 0.9, 0);
      batch.poly('zone:#e59866', [inset.top, inset.right, inset.bottom, inset.left]);
      break;
    }
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
    case 'RAIL':
      batch.poly('fill:' + (tile.elev >= 2 ? shade(PALETTE.grass, -0.12) : PALETTE.grass), diamond);
      batch.poly('stroke:' + PALETTE.grassBorder, diamond);
      addRails(batch, tiles, size, tile, d, false);
      break;
    case 'STATION':
      pave();
      // Quai le long des voies.
      batch.poly('fill:#d5d8dc', footprintPts(add(center, { x: HALF_W * 0.2, y: HALF_H * 0.2 }), 0.5));
      addRails(batch, tiles, size, tile, d, false);
      break;
    case 'PARKING': {
      batch.poly('fill:#5d6d7e', diamond);
      batch.poly('stroke:#d5d8dc', diamond);
      for (const s of [-0.15, 0.15]) {
        for (let k = 0; k < 4; k++) {
          const a = lerp(lerp(d.top, d.left, 0.15 + k * 0.23), lerp(d.right, d.bottom, 0.15 + k * 0.23), 0.5 + s - 0.12);
          const b = lerp(lerp(d.top, d.left, 0.15 + k * 0.23), lerp(d.right, d.bottom, 0.15 + k * 0.23), 0.5 + s + 0.12);
          strip(batch, 'deco:#ecf0f1', a, b, 0.4);
        }
      }
      break;
    }
    case 'TREATMENT':
      pave();
      for (const [ox, oy] of [
        [-0.1, 0.2],
        [0.22, -0.12],
      ]) {
        const c = add(center, { x: (ox - oy) * HALF_W, y: (ox + oy) * HALF_H });
        batch.poly('fill:#95a5a6', groundEllipse(c, 9));
        batch.poly('water:#5d8a6e', groundEllipse(c, 7.5));
      }
      break;
    case 'HIGHSCHOOL': {
      pave();
      // Terrain de sport.
      const c = add(center, { x: 0, y: HALF_H * 0.45 });
      batch.poly('fill:#c0392b', footprintPts(c, 0.42));
      batch.poly('zone:#ecf0f1', footprintPts(c, 0.34));
      break;
    }
    case 'HOTEL':
      pave();
      batch.poly('water:#5dade2', footprintPts(add(center, { x: HALF_W * 0.4, y: HALF_H * 0.4 }), 0.3));
      break;
    case 'RESORT':
      batch.poly('fill:#f7e7b4', diamond);
      batch.poly('stroke:' + PALETTE.sandBorder, diamond);
      break;
    default:
      if (tile.type === 'GRASS') {
        if (tile.elev >= 2) addHill(batch, tile, diamond);
        else {
          batch.poly('fill:' + PALETTE.grass, diamond);
          batch.poly('stroke:' + PALETTE.grassBorder, diamond);
          addFlowers(batch, tile, d);
        }
      } else pave();
  }

  // Inondation : voile d'eau translucide.
  if (tile.flood > 0 && !isPlant(tile.type)) batch.poly(`tint:${PALETTE.flood}:0.55`, diamond);
  // Contamination radioactive : voile jaune-vert, plus fort près de l'accident.
  if (tile.rad > 0) batch.poly(`tint:#b7d433:${(0.2 + tile.rad * 0.04).toFixed(2)}`, diamond);

  // Falaises : relief et bords de la carte (bleues sous l'eau).
  addCliffs(batch, tiles, size, tile, origin);
}

function flushGround(canvas: SkCanvas, batch: PathBatch) {
  // Ordre : falaises, eau, remplissages, contours, détails, voiles.
  const order = (k: string) =>
    k.startsWith('cliff') || k.startsWith('rock') ? 0 : k.startsWith('water:') ? 1 : k.startsWith('fill:') ? 2 : k.startsWith('stroke:') ? 3 : k.startsWith('tint:') ? 5 : 4;
  const entries = batch.detachAll().sort((a, b) => order(a[0]) - order(b[0]));
  for (const [key, path] of entries) {
    if (key === 'cliffL') canvas.drawPath(path, fillPaint(PALETTE.cliffLeft));
    else if (key === 'cliffR') canvas.drawPath(path, fillPaint(PALETTE.cliffRight));
    else if (key === 'cliffWL') canvas.drawPath(path, fillPaint(PALETTE.lakeDeep));
    else if (key === 'cliffWR') canvas.drawPath(path, fillPaint(shade(PALETTE.lakeDeep, -0.25)));
    else if (key === 'rockL') canvas.drawPath(path, fillPaint(shade(PALETTE.rock, -0.18)));
    else if (key === 'rockR') canvas.drawPath(path, fillPaint(shade(PALETTE.rock, -0.4)));
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
  return { x: p.x, y: p.y + HALF_H - zOf(t) };
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
    y0: o.originY + (b.x0 + b.y0) * HALF_H - 140 - 3 * LEVEL_H - 30,
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
  lookSize = gridSize;
  return createPicture((canvas) => {
    // Niveau par niveau : un sol plus haut recouvre toujours ce qui est derrière et plus bas.
    let maxLevel = 0;
    eachTile(tiles, gridSize, b, (t) => {
      if (t.type !== 'LAKE' && t.elev > maxLevel) maxLevel = t.elev;
    });
    for (let level = 0; level <= maxLevel; level++) {
      const ground = new PathBatch();
      eachTile(tiles, gridSize, b, (t) => {
        if ((t.type === 'LAKE' ? 0 : (t.elev ?? 0)) === level) addGround(ground, tiles, gridSize, t, origin);
      });
      flushGround(canvas, ground);
    }
  }, worldRect(gridSize));
}

/**
 * Ombres d'un bloc dans un seul chemin noir à 20 % : les ombres qui se
 * chevauchent fusionnent au lieu de s'additionner.
 */
export function buildShadowPicture(tiles: Tile[], gridSize: number, b?: Block) {
  const origin = getOrigin(gridSize);
  lookSize = gridSize;
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
/** Équipements qui fonctionnent sans électricité (pas d'éclair « sans courant »). */
const NO_POWER_NEEDED = new Set(['PARK', 'BUSSTOP', 'PARKING', 'RESORT']);

/**
 * Le sol d'une tuile surélevée doit masquer le pied des bâtiments situés juste
 * derrière et plus bas : il est alors redessiné dans le calque des bâtiments.
 */
function needsGroundRedraw(tiles: Tile[], size: number, t: Tile): boolean {
  // Pas pour les routes et voies ferrées : les véhicules qui y roulent seraient recouverts.
  if (t.type === 'LAKE' || !t.elev || isRoadType(t.type) || t.type === 'RAIL') return false;
  for (const [dx, dy] of [
    [-1, 0],
    [0, -1],
    [-1, -1],
  ]) {
    const n = at(tiles, size, t.x + dx, t.y + dy);
    if (n && zOf(n) < zOf(t) && buildingFor(n).length) return true;
  }
  return false;
}

/** Point de la grille (vue) projeté à l'écran, à la hauteur z. */
function gridPoint(gx: number, gy: number, origin: IsoOrigin, z: number): Point {
  return { x: origin.originX + (gx - gy) * HALF_W, y: origin.originY + (gx + gy) * HALF_H - z };
}

/** Longueur du pont (tuiles de route sur l'eau alignées) qui contient la tuile, selon un axe. */
function bridgeRun(tiles: Tile[], size: number, t: Tile, axis: 0 | 1): [number, number] {
  const isDeck = (n: Tile | null) => !!n && n.lake && isRoadType(n.type);
  let a = axis ? t.y : t.x;
  let b = a;
  while (isDeck(axis ? at(tiles, size, t.x, a - 1) : at(tiles, size, a - 1, t.y))) a--;
  while (isDeck(axis ? at(tiles, size, t.x, b + 1) : at(tiles, size, b + 1, t.y))) b++;
  return [a, b];
}

/** Pont suspendu (4 tuiles ou plus) : pylônes rouges et câbles porteurs avec suspentes. */
function drawSuspension(canvas: SkCanvas, tiles: Tile[], size: number, t: Tile, origin: IsoOrigin) {
  for (const axis of [0, 1] as const) {
    const [a, b] = bridgeRun(tiles, size, t, axis);
    if (b - a + 1 < 4) continue;
    const pos = axis ? t.y : t.x;
    const p0 = a + 1.5;
    const p1 = b - 0.5;
    const H = 42;
    const height = (s: number) => {
      if (s <= p0) return 4 + ((s - a) / (p0 - a)) * (H - 4);
      if (s >= p1) return 4 + ((b + 1 - s) / (b + 1 - p1)) * (H - 4);
      const m = (p0 + p1) / 2;
      const k = (s - m) / ((p1 - p0) / 2);
      return 9 + (H - 9) * k * k;
    };
    const cable = strokePaint('#ecf0f1', 1.1);
    const hanger = strokePaint('rgba(236,240,241,0.7)', 0.5);
    for (const side of [-0.42, 0.42]) {
      const pt = (s: number, z: number) => (axis ? gridPoint(t.x + 0.5 + side, s, origin, z) : gridPoint(s, t.y + 0.5 + side, origin, z));
      for (let k = 0; k < 4; k++) {
        const s0 = pos + k / 4;
        const s1 = pos + (k + 1) / 4;
        const q0 = pt(s0, height(s0));
        const q1 = pt(s1, height(s1));
        canvas.drawLine(q0.x, q0.y, q1.x, q1.y, cable);
        const deck = pt(s0, 2);
        canvas.drawLine(q0.x, q0.y, deck.x, deck.y, hanger);
      }
      // Pylône : deux montants reliés par une traverse.
      if (pos === a + 1 || pos === b - 1) {
        const foot = pt(pos + 0.5, 0);
        const top = pt(pos + 0.5, H + 4);
        const leg = strokePaint('#c0392b', 3);
        canvas.drawLine(foot.x, foot.y, top.x, top.y, leg);
        if (side > 0) {
          const other = axis ? gridPoint(t.x + 0.5 - 0.42, pos + 0.5, origin, H + 2) : gridPoint(pos + 0.5, t.y + 0.5 - 0.42, origin, H + 2);
          const here = axis ? gridPoint(t.x + 0.5 + 0.42, pos + 0.5, origin, H + 2) : gridPoint(pos + 0.5, t.y + 0.5 + 0.42, origin, H + 2);
          canvas.drawLine(other.x, other.y, here.x, here.y, strokePaint('#a93226', 2.5));
        }
      }
    }
  }
}

/** Mâts de caténaire du tramway, barrières des passages à niveau. */
function drawLineFurniture(canvas: SkCanvas, t: Tile, center: Point) {
  if (t.line & LINE_TRAM && (ogx(t) + ogy(t)) % 2 === 0) {
    const foot = add(center, { x: -HALF_W * 0.62, y: -HALF_H * 0.05 });
    canvas.drawLine(foot.x, foot.y, foot.x, foot.y - 15, strokePaint('#566573', 1.1));
    canvas.drawLine(foot.x, foot.y - 14, foot.x + HALF_W * 0.55, foot.y - 14 + HALF_H * 0.1, strokePaint('#2c3e50', 0.6));
  }
  if (t.line & LINE_RAIL) {
    for (const s of [-1, 1]) {
      const foot = add(center, { x: s * HALF_W * 0.58, y: -s * HALF_H * 0.2 });
      canvas.drawLine(foot.x, foot.y, foot.x, foot.y - 9, strokePaint('#2c3e50', 1));
      canvas.drawLine(foot.x, foot.y - 8, foot.x - s * 12, foot.y - 6, strokePaint('#e74c3c', 1.4));
      canvas.drawCircle(foot.x, foot.y - 10, 1.4, fillPaint('#e74c3c'));
    }
  }
}

export function buildBuildingPicture(tiles: Tile[], gridSize: number, b: Block) {
  const origin = getOrigin(gridSize);
  lookSize = gridSize;
  return createPicture((canvas) => {
    eachTile(tiles, gridSize, b, (t) => {
      if (needsGroundRedraw(tiles, gridSize, t)) {
        const batch = new PathBatch();
        addGround(batch, tiles, gridSize, t, origin);
        flushGround(canvas, batch);
      }
      const prisms = buildingFor(t);
      const center = tileCenter(t, origin);
      let top = 0;
      for (const prism of prisms) {
        drawPrism(canvas, center, prism);
        top = Math.max(top, prismTop(prism));
      }
      if (t.lake && isRoadType(t.type)) drawSuspension(canvas, tiles, gridSize, t, origin);
      if (t.line && !isTunnel(t)) drawLineFurniture(canvas, t, center);
      const needsPower = isZone(t) || (isFacility(t.type) && !NO_POWER_NEEDED.has(t.type) && !isPlant(t.type));
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
export function buildLightsPicture(tiles: Tile[], gridSize: number, b: Block): ReturnType<typeof createPicture> {
  const origin = getOrigin(gridSize);
  lookSize = gridSize;
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
      if (isTunnel(t)) return;
      if (isRoadType(t.type) && (ogx(t) + ogy(t)) % 2 === 0) {
        const p = add(center, { x: -HALF_W * 0.55, y: -2 });
        lamps.addCircle(p.x, p.y - 6, 1.6);
        halos.addCircle(p.x, p.y - 2, 9);
        pending = true;
        return;
      }
      // Relief : un sol surélevé masque les fenêtres des bâtiments plus bas situés derrière.
      if (needsGroundRedraw(tiles, gridSize, t)) {
        flush();
        const d = tileDiamond(t.x, t.y, origin);
        const z = zOf(t);
        const hill = Skia.PathBuilder.Make();
        hill.addPoly([up(d.left, z), up(d.top, z), up(d.right, z), d.right, d.bottom, d.left], true);
        canvas.drawPath(hill.detach(), eraser);
      }
      const prisms = buildingFor(t).filter((pr) => !pr.blob || t.type === 'STADIUM');
      if (!prisms.length) return;
      // Les lumières déjà posées derrière ce bâtiment sont masquées par sa silhouette.
      flush();
      const mask = Skia.PathBuilder.Make();
      addSilhouette(mask, prisms, center);
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
              if (hash01(ogx(t) * 7 + f, ogy(t) * 13 + c, a === base.left ? 1 : 2) > 0.6) continue;
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

/** Silhouette (contour plein) de prismes : sert de masque d'occlusion. */
function addSilhouette(mask: SkPathBuilder, prisms: Prism[], center: Point) {
  for (const prism of prisms) {
    const pc = prismCenter(center, prism);
    const z = prism.z ?? 0;
    const base = footprint(pc, prism.size, z);
    const top = footprint(pc, prism.size, z + prism.h);
    const roof = prism.roof === 'hip' ? up(pc, z + prism.h + (prism.roofHeight ?? 8)) : top.top;
    mask.addPoly([base.left, base.bottom, base.right, top.right, roof, top.left], true);
    if (prism.blob) {
      const c = up(pc, z + prism.h + prism.blob.r * 0.7);
      mask.addCircle(c.x, c.y, prism.blob.r);
    }
  }
}

/**
 * Masque d'occlusion d'un objet animé (pales d'éolienne, grande roue) : les
 * silhouettes des bâtiments situés DEVANT lui, dessinées en mode Clear. Rejoué
 * juste après l'objet dans un calque isolé, il efface ce qui doit être caché.
 */
export function buildOccluderPicture(tiles: Tile[], gridSize: number, vx: number, vy: number, radius = 5) {
  const origin = getOrigin(gridSize);
  lookSize = gridSize;
  return createPicture((canvas) => {
    const eraser = Skia.Paint();
    eraser.setBlendMode(BlendMode.Clear);
    const mask = Skia.PathBuilder.Make();
    for (let y = Math.max(0, vy - radius); y <= Math.min(gridSize - 1, vy + radius); y++) {
      for (let x = Math.max(0, vx - radius); x <= Math.min(gridSize - 1, vx + radius); x++) {
        if (x + y <= vx + vy || (x === vx && y === vy)) continue;
        const t = tiles[y * gridSize + x];
        const prisms = buildingFor(t);
        if (prisms.length) addSilhouette(mask, prisms, tileCenter(t, origin));
      }
    }
    canvas.drawPath(mask.detach(), eraser);
  }, worldRect(gridSize));
}

/** Masque de neige : le sol (herbe, parcelles, plages…), routes comprises ou non. */
export function buildSnowMask(tiles: Tile[], gridSize: number, roads: boolean): SkPath {
  const origin = getOrigin(gridSize);
  const p = Skia.PathBuilder.Make();
  for (const t of tiles) {
    if (t.type === 'LAKE' || (!roads && isRoadType(t.type) && !isTunnel(t))) continue;
    const d = tileDiamond(t.x, t.y, origin, zOf(t));
    p.addPoly([d.top, d.right, d.bottom, d.left], true);
  }
  return p.detach();
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

/** Dégradés (du bien vers le mal) : classique vert → rouge, ou bleu → orange lisible par les daltoniens. */
export const HEAT_STOPS = {
  normal: ['#2ecc71', '#a3d65c', '#f1c40f', '#e67e22', '#e74c3c'],
  colorblind: ['#2c7bb6', '#7fb6d6', '#f7f4b9', '#fdae61', '#d7301f'],
};

const hexRgb = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export function heatColor(v: number, colorblind = false): string {
  const stops = colorblind ? HEAT_STOPS.colorblind : HEAT_STOPS.normal;
  const t = Math.max(0, Math.min(1, v)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t));
  const f = t - i;
  const a = hexRgb(stops[i]);
  const b = hexRgb(stops[i + 1]);
  const c = a.map((x, k) => Math.round(x + (b[k] - x) * f));
  return `#${((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1)}`;
}

/** Teinte HSL -> hex (couleurs des quartiers). */
export function hueColor(h: number, s = 0.55, l = 0.55): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return `#${((1 << 24) | (f(0) << 16) | (f(8) << 8) | f(4)).toString(16).slice(1)}`;
}

/**
 * Carte thématique : chaque tuile teintée selon une valeur 0-1 (bien → mal),
 * ou d'une couleur choisie (`colorOf`, pour les quartiers).
 */
export function buildDataPicture(
  tiles: Tile[],
  gridSize: number,
  values: (t: Tile, i: number) => number | null,
  opts: { colorblind?: boolean; colorOf?: (t: Tile, i: number) => string | null; alpha?: number } = {},
) {
  const origin = getOrigin(gridSize);
  return createPicture((canvas) => {
    const buckets = new Map<string, SkPathBuilder>();
    for (let i = 0; i < tiles.length; i++) {
      let color: string | null;
      if (opts.colorOf) color = opts.colorOf(tiles[i], i);
      else {
        const v = values(tiles[i], i);
        color = v === null ? null : heatColor(Math.round(v * 10) / 10, opts.colorblind);
      }
      if (color === null) continue;
      let bld = buckets.get(color);
      if (!bld) {
        bld = Skia.PathBuilder.Make();
        buckets.set(color, bld);
      }
      const d = tileDiamond(tiles[i].x, tiles[i].y, origin, zOf(tiles[i]));
      bld.addPoly([d.top, d.right, d.bottom, d.left], true);
    }
    for (const [color, bld] of buckets) {
      const paint = fillPaint(color).copy();
      paint.setAlphaf(opts.alpha ?? 0.62);
      canvas.drawPath(bld.detach(), paint);
    }
  }, worldRect(gridSize));
}

/**
 * Aperçu d'un glisser (rectangle de zonage, route droite) : losanges teintés de
 * la couleur de l'outil, en rouge là où c'est impossible.
 */
export function buildPreviewPicture(gridSize: number, cells: { x: number; y: number; ok: boolean; z?: number }[], color: string) {
  const origin = getOrigin(gridSize);
  return createPicture((canvas) => {
    const okPath = Skia.PathBuilder.Make();
    const badPath = Skia.PathBuilder.Make();
    for (const c of cells) {
      const d = tileDiamond(c.x, c.y, origin, c.z ?? 0);
      (c.ok ? okPath : badPath).addPoly([d.top, d.right, d.bottom, d.left], true);
    }
    const ok = okPath.detach();
    // Teinte éclaircie : reste visible même quand l'outil a la couleur de l'herbe.
    const fill = fillPaint(shade(color, 0.55)).copy();
    fill.setAlphaf(0.8);
    canvas.drawPath(ok, fill);
    canvas.drawPath(ok, strokePaint(shade(color, -0.45), 1.6));
    const bad = fillPaint('#e74c3c').copy();
    bad.setAlphaf(0.35);
    canvas.drawPath(badPath.detach(), bad);
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
  HIGHSCHOOL: '#e67e22',
  PARKING: '#2874a6',
  TREATMENT: '#48c9b0',
  STATION: '#a93226',
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
      const d = tileDiamond(tiles[i].x, tiles[i].y, origin, zOf(tiles[i]));
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
