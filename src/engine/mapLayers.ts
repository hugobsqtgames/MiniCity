import type { SkPicture } from '@shopify/react-native-skia';
import { useMemo, useState } from 'react';

import type { Tile } from './map';
import {
  blockBounds,
  buildBuildingPicture,
  buildGroundPicture,
  buildLightsPicture,
  buildShadowPicture,
  mapBlocks,
  type Block,
} from './renderer';

export type BlockBounds = { x0: number; x1: number; y0: number; y1: number };

/** Pictures d'une carte, par blocs de 10 x 10 tuiles (dans l'ordre de dessin). */
export type MapLayers = {
  bounds: BlockBounds[];
  ground: SkPicture[];
  shadows: SkPicture[];
  buildings: SkPicture[];
  lights: SkPicture[];
};

type Cache = { tiles: Tile[]; size: number; blocks: Block[]; layers: MapLayers };

/** Ce qui a un rendu : type, densité, réseaux, incendie, eau, ordures visibles, inondation. */
const visuallyEqual = (a: Tile, b: Tile) =>
  a === b ||
  (a.type === b.type &&
    a.density === b.density &&
    a.powered === b.powered &&
    a.water === b.water &&
    a.fire === b.fire &&
    a.lake === b.lake &&
    (a.flood > 0) === (b.flood > 0) &&
    (a.garbage >= 5) === (b.garbage >= 5) &&
    (a.type !== 'LANDFILL' || a.garbage === b.garbage));

function buildAll(tiles: Tile[], size: number, blocks: Block[]): MapLayers {
  return {
    bounds: blocks.map((b) => blockBounds(b, size)),
    ground: blocks.map((b) => buildGroundPicture(tiles, size, b)),
    shadows: blocks.map((b) => buildShadowPicture(tiles, size, b)),
    buildings: blocks.map((b) => buildBuildingPicture(tiles, size, b)),
    lights: blocks.map((b) => buildLightsPicture(tiles, size, b)),
  };
}

/**
 * Memoization du rendu : compare la nouvelle carte à la précédente et ne
 * ré-enregistre que les blocs qui ont changé. Le sol d'un bloc dépend aussi des
 * tuiles voisines (raccords de routes), d'où la marge d'une tuile.
 */
class LayerCache {
  private last: Cache | null = null;

  update(tiles: Tile[], size: number): MapLayers {
    const prev = this.last;
    if (!prev || prev.size !== size) {
      const blocks = mapBlocks(size);
      const layers = buildAll(tiles, size, blocks);
      this.last = { tiles, size, blocks, layers };
      return layers;
    }
    if (prev.tiles === tiles) return prev.layers;

    const changed = new Uint8Array(size * size);
    let any = false;
    for (let i = 0; i < tiles.length; i++) {
      if (!visuallyEqual(prev.tiles[i], tiles[i])) {
        changed[i] = 1;
        any = true;
      }
    }
    if (!any) {
      this.last = { ...prev, tiles };
      return prev.layers;
    }

    const L = prev.layers;
    const next: MapLayers = {
      bounds: L.bounds,
      ground: L.ground.slice(),
      shadows: L.shadows.slice(),
      buildings: L.buildings.slice(),
      lights: L.lights.slice(),
    };
    prev.blocks.forEach((b, k) => {
      let inner = false;
      let border = false;
      for (let y = Math.max(0, b.y0 - 1); y <= Math.min(size - 1, b.y1 + 1); y++) {
        for (let x = Math.max(0, b.x0 - 1); x <= Math.min(size - 1, b.x1 + 1); x++) {
          if (!changed[y * size + x]) continue;
          if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) inner = true;
          else border = true;
        }
      }
      if (inner || border) next.ground[k] = buildGroundPicture(tiles, size, b);
      if (inner) {
        next.shadows[k] = buildShadowPicture(tiles, size, b);
        next.buildings[k] = buildBuildingPicture(tiles, size, b);
        next.lights[k] = buildLightsPicture(tiles, size, b);
      }
    });
    this.last = { tiles, size, blocks: prev.blocks, layers: next };
    return next;
  }
}

export function useMapLayers(tiles: Tile[], size: number): MapLayers {
  const [cache] = useState(() => new LayerCache());
  return useMemo(() => cache.update(tiles, size), [cache, tiles, size]);
}
