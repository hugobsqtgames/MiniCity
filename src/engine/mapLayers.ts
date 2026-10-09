import type { SkPicture } from '@shopify/react-native-skia';
import { useMemo, useState } from 'react';

import type { Tile } from './map';
import { buildBuildingPicture, buildGroundPicture, buildShadowPicture, CHUNK_ROWS } from './renderer';

export type MapLayers = { ground: SkPicture[]; shadows: SkPicture; buildings: SkPicture[] };

type Cache = { tiles: Tile[]; size: number; layers: MapLayers };

/** Seuls type, densité et courant ont un rendu : la valeur foncière qui bouge chaque mois ne redessine rien. */
const visuallyEqual = (a: Tile, b: Tile) =>
  a === b || (a.type === b.type && a.density === b.density && a.powered === b.powered);

/** Une ligne a-t-elle au moins une tuile visuellement modifiée ? */
function rowChanged(prev: Tile[], next: Tile[], size: number, y: number): boolean {
  const start = y * size;
  for (let i = start; i < start + size; i++) if (!visuallyEqual(prev[i], next[i])) return true;
  return false;
}

function buildAll(tiles: Tile[], size: number): MapLayers {
  const ground: SkPicture[] = [];
  const buildings: SkPicture[] = [];
  for (let y0 = 0; y0 < size; y0 += CHUNK_ROWS) {
    const y1 = Math.min(size - 1, y0 + CHUNK_ROWS - 1);
    ground.push(buildGroundPicture(tiles, size, y0, y1));
    buildings.push(buildBuildingPicture(tiles, size, y0, y1));
  }
  return { ground, shadows: buildShadowPicture(tiles, size), buildings };
}

/**
 * Memoization du rendu : compare la nouvelle carte à la précédente et ne
 * ré-enregistre que les bandes de lignes qui ont changé. Le sol d'une bande
 * dépend aussi des lignes voisines (raccords de routes), d'où la marge de ±1.
 */
class LayerCache {
  private last: Cache | null = null;

  update(tiles: Tile[], size: number): MapLayers {
    const prev = this.last;
    if (!prev || prev.size !== size) {
      const layers = buildAll(tiles, size);
      this.last = { tiles, size, layers };
      return layers;
    }
    if (prev.tiles === tiles) return prev.layers;

    const changedRows = new Uint8Array(size);
    let any = false;
    for (let y = 0; y < size; y++) {
      if (rowChanged(prev.tiles, tiles, size, y)) {
        changedRows[y] = 1;
        any = true;
      }
    }
    if (!any) {
      this.last = { ...prev, tiles };
      return prev.layers;
    }

    const ground = prev.layers.ground.slice();
    const buildings = prev.layers.buildings.slice();
    for (let c = 0; c < ground.length; c++) {
      const y0 = c * CHUNK_ROWS;
      const y1 = Math.min(size - 1, y0 + CHUNK_ROWS - 1);
      let groundDirty = false;
      let buildingsDirty = false;
      for (let y = y0 - 1; y <= y1 + 1; y++) {
        if (y < 0 || y >= size || !changedRows[y]) continue;
        groundDirty = true;
        if (y >= y0 && y <= y1) buildingsDirty = true;
      }
      if (groundDirty) ground[c] = buildGroundPicture(tiles, size, y0, y1);
      if (buildingsDirty) buildings[c] = buildBuildingPicture(tiles, size, y0, y1);
    }
    const layers = { ground, buildings, shadows: buildShadowPicture(tiles, size) };
    this.last = { tiles, size, layers };
    return layers;
  }
}

export function useMapLayers(tiles: Tile[], size: number): MapLayers {
  const [cache] = useState(() => new LayerCache());
  return useMemo(() => cache.update(tiles, size), [cache, tiles, size]);
}
