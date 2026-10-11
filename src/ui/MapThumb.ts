import { createPicture, Skia, type SkPathBuilder } from '@shopify/react-native-skia';

import type { TileType } from '../engine/map';

/** Couleur d'une tuile vue de très haut (mini-carte, aperçu de sauvegarde). */
export function thumbColor(type: TileType, density = 1): string {
  switch (type) {
    case 'GRASS':
      return '#2ecc71';
    case 'DIRT':
      return '#a1887f';
    case 'LAKE':
      return '#3498db';
    case 'SAND':
      return '#f5deb3';
    case 'FOREST':
      return '#1e8449';
    case 'ROAD':
    case 'AVENUE':
      return '#7f8c8d';
    case 'HIGHWAY':
      return '#566573';
    case 'R':
      return density > 0 ? '#58d68d' : '#a9dfbf';
    case 'C':
      return density > 0 ? '#5dade2' : '#aed6f1';
    case 'I':
      return density > 0 ? '#f4d03f' : '#f9e79f';
    case 'PARK':
      return '#27ae60';
    case 'POWER':
    case 'NUCLEAR':
      return '#34495e';
    default:
      return '#d5d8dc';
  }
}

/**
 * Vignette isométrique (même projection que la carte, réduite) : un losange
 * par tuile, regroupés par couleur pour un dessin rapide.
 * La vignette occupe `width` × `width / 2` pixels.
 */
export function buildThumbPicture(n: number, width: number, typeAt: (x: number, y: number) => TileType, densityAt?: (x: number, y: number) => number) {
  const hw = width / (2 * n);
  const hh = hw / 2;
  const ox = width / 2;
  return createPicture(
    (canvas) => {
      const paths = new Map<string, SkPathBuilder>();
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const color = thumbColor(typeAt(x, y), densityAt ? densityAt(x, y) : 1);
          let p = paths.get(color);
          if (!p) {
            p = Skia.PathBuilder.Make();
            paths.set(color, p);
          }
          const cx = ox + (x - y) * hw;
          const cy = (x + y) * hh;
          p.addPoly(
            [
              { x: cx, y: cy },
              { x: cx + hw, y: cy + hh },
              { x: cx, y: cy + 2 * hh },
              { x: cx - hw, y: cy + hh },
            ],
            true,
          );
        }
      }
      for (const [color, p] of paths) {
        const paint = Skia.Paint();
        paint.setColor(Skia.Color(color));
        canvas.drawPath(p.detach(), paint);
      }
    },
    { x: 0, y: 0, width, height: width / 2 },
  );
}
