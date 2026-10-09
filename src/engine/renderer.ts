import { createPicture, PaintStyle, Skia, type SkCanvas, type SkPaint } from '@shopify/react-native-skia';

import type { Tile } from '../store/useGameStore';
import { getOrigin, getWorldSize, tileDiamond, type IsoOrigin } from './iso';

export const COLORS = {
  background: '#0b1622',
  grass: '#2ecc71',
  grassBorder: '#27ae60',
  highlight: '#ffffff',
};

function makePaint(color: string, style: PaintStyle = PaintStyle.Fill, strokeWidth = 1): SkPaint {
  const p = Skia.Paint();
  p.setAntiAlias(true);
  p.setColor(Skia.Color(color));
  p.setStyle(style);
  p.setStrokeWidth(strokeWidth);
  return p;
}

/** Chemin du losange de sol (réutilisé par la surbrillance). */
export function diamondPath(x: number, y: number, origin: IsoOrigin, z = 0) {
  const d = tileDiamond(x, y, origin, z);
  const path = Skia.Path.Make();
  path.moveTo(d.top.x, d.top.y);
  path.lineTo(d.right.x, d.right.y);
  path.lineTo(d.bottom.x, d.bottom.y);
  path.lineTo(d.left.x, d.left.y);
  path.close();
  return path;
}

function drawTile(canvas: SkCanvas, tile: Tile, origin: IsoOrigin, fill: SkPaint, stroke: SkPaint) {
  const path = diamondPath(tile.x, tile.y, origin);
  canvas.drawPath(path, fill);
  canvas.drawPath(path, stroke);
}

/**
 * Enregistre toute la carte dans une SkPicture (liste de commandes GPU figée).
 * Elle n'est reconstruite que lorsque le tableau `tiles` change : pan/zoom ne
 * font que modifier la matrice de la caméra, sans aucun re-render React.
 *
 * Depth sorting : le tableau est row-major (y externe, x interne), on dessine
 * donc de (0,0) — le haut de l'écran — vers (N-1,N-1) — le bas.
 */
export function buildMapPicture(tiles: Tile[], gridSize: number) {
  const origin = getOrigin(gridSize);
  const { width, height } = getWorldSize(gridSize);
  const fill = makePaint(COLORS.grass);
  const stroke = makePaint(COLORS.grassBorder, PaintStyle.Stroke, 1);

  return createPicture(
    (canvas) => {
      for (let i = 0; i < tiles.length; i++) {
        drawTile(canvas, tiles[i], origin, fill, stroke);
      }
    },
    { x: 0, y: 0, width, height },
  );
}
