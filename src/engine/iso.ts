/**
 * Moteur de projection isométrique 2:1.
 *
 * Convention : (screenX, screenY) renvoyé par gridToWorld est le SOMMET HAUT
 * du losange de la tuile. Le losange occupe donc :
 *   haut   (sx,            sy)
 *   droite (sx + TILE_W/2, sy + TILE_H/2)
 *   bas    (sx,            sy + TILE_H)
 *   gauche (sx - TILE_W/2, sy + TILE_H/2)
 * Avec cette convention, la projection inverse se résout par un simple floor().
 *
 * Toutes les fonctions sont des worklets : elles tournent aussi bien sur le
 * thread JS que sur le thread UI (gestes Reanimated).
 */

export const TILE_W = 64;
export const TILE_H = 32;
export const HALF_W = TILE_W / 2;
export const HALF_H = TILE_H / 2;

/** Marge autour de la carte dans l'espace "monde" (place pour les bâtiments extrudés). */
export const WORLD_PADDING = 128;

export type Point = { x: number; y: number };

export type IsoOrigin = { originX: number; originY: number };

/** Origine monde : sommet haut de la tuile (0,0), centrée horizontalement. */
export function getOrigin(gridSize: number): IsoOrigin {
  'worklet';
  return { originX: WORLD_PADDING + gridSize * HALF_W, originY: WORLD_PADDING };
}

/** Taille totale de l'espace monde (bounding box de la carte + marges). */
export function getWorldSize(gridSize: number): { width: number; height: number } {
  'worklet';
  return {
    width: gridSize * TILE_W + WORLD_PADDING * 2,
    height: gridSize * TILE_H + WORLD_PADDING * 2,
  };
}

/** Projection cartésien -> isométrique (formule imposée). */
export function gridToWorld(gridX: number, gridY: number, origin: IsoOrigin): Point {
  'worklet';
  return {
    x: origin.originX + (gridX - gridY) * HALF_W,
    y: origin.originY + (gridX + gridY) * HALF_H,
  };
}

/**
 * Projection inverse exacte (monde -> grille, en flottant).
 *   dx = (gx - gy) * W/2      dy = (gx + gy) * H/2
 * => gx = dx / W + dy / H     gy = dy / H - dx / W
 */
export function worldToGridFloat(wx: number, wy: number, origin: IsoOrigin): Point {
  'worklet';
  const dx = wx - origin.originX;
  const dy = wy - origin.originY;
  return { x: dx / TILE_W + dy / TILE_H, y: dy / TILE_H - dx / TILE_W };
}

/** Caméra : écran = monde * scale + translate. Inverse : monde = (écran - translate) / scale. */
export function screenToWorld(
  sx: number,
  sy: number,
  translateX: number,
  translateY: number,
  scale: number,
): Point {
  'worklet';
  return { x: (sx - translateX) / scale, y: (sy - translateY) / scale };
}

/**
 * "Raycasting inverse" complet : toucher écran -> tuile de la grille.
 * Renvoie null si le doigt est hors de la carte.
 */
export function screenToTile(
  sx: number,
  sy: number,
  translateX: number,
  translateY: number,
  scale: number,
  gridSize: number,
): Point | null {
  'worklet';
  const world = screenToWorld(sx, sy, translateX, translateY, scale);
  const g = worldToGridFloat(world.x, world.y, getOrigin(gridSize));
  const tx = Math.floor(g.x);
  const ty = Math.floor(g.y);
  if (tx < 0 || ty < 0 || tx >= gridSize || ty >= gridSize) return null;
  return { x: tx, y: ty };
}

/** Les 4 sommets du losange de sol d'une tuile, avec élévation Z optionnelle. */
export function tileDiamond(gridX: number, gridY: number, origin: IsoOrigin, z = 0) {
  'worklet';
  const p = gridToWorld(gridX, gridY, origin);
  const y = p.y - z;
  return {
    top: { x: p.x, y },
    right: { x: p.x + HALF_W, y: y + HALF_H },
    bottom: { x: p.x, y: y + TILE_H },
    left: { x: p.x - HALF_W, y: y + HALF_H },
  };
}
