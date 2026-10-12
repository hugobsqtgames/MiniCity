import type { SkPicture } from '@shopify/react-native-skia';
import { useEffect, useMemo, useState } from 'react';

import type { Tile } from './map';
import {
  blockBounds,
  buildBuildingPicture,
  buildGroundPicture,
  buildLightsPicture,
  buildShadowPicture,
  mapBlocks,
  renderSeason,
  setRenderSeason,
  type Block,
} from './renderer';
import { camera } from './cameraBridge';
import { RECYCLE_PICTURES } from './pictureBin';

/** Web : les images remplacées sont libérées un peu plus tard (le temps qu'elles ne soient plus dessinées). */
function release(old: SkPicture[]) {
  if (!RECYCLE_PICTURES || !old.length) return;
  setTimeout(() => {
    for (const p of old) p.dispose();
  }, 2000);
}

export type BlockBounds = { x0: number; x1: number; y0: number; y1: number };

/** Pictures d'une carte, par blocs de 10 x 10 tuiles (dans l'ordre de dessin). */
export type MapLayers = {
  bounds: BlockBounds[];
  ground: SkPicture[];
  shadows: SkPicture[];
  buildings: SkPicture[];
  lights: SkPicture[];
};

type Cache = { tiles: Tile[]; size: number; blocks: Block[]; layers: MapLayers; looks: string[] };


/** Ce qui a un rendu : type, densité, réseaux, incendie, eau, ordures visibles, inondation. */
const visuallyEqual = (a: Tile, b: Tile) =>
  a === b ||
  // Vue tournée : la tuile à cet index vient d'ailleurs (arbres, styles, hauteurs changent).
  ((a.ox ?? a.x) === (b.ox ?? b.x) &&
    (a.oy ?? a.y) === (b.oy ?? b.y) &&
    a.type === b.type &&
    a.density === b.density &&
    a.powered === b.powered &&
    a.water === b.water &&
    a.fire === b.fire &&
    a.lake === b.lake &&
    (a.flood > 0) === (b.flood > 0) &&
    a.rad === b.rad &&
    a.elev === b.elev &&
    a.line === b.line &&
    a.spec === b.spec &&
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

/** Temps de dessin maximal par passe (ms) : au-delà, la suite attend la passe suivante. */
const PASS_BUDGET_MS = 8;

/** Ordre de priorité des blocs à redessiner : ceux à l'écran d'abord, puis les plus proches. */
function byVisibility(bounds: BlockBounds[]): (a: number, b: number) => number {
  const s = camera.scale.get() || 1;
  const x0 = -camera.tx.get() / s;
  const y0 = -camera.ty.get() / s;
  const x1 = x0 + camera.width.get() / s;
  const y1 = y0 + camera.height.get() / s;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const score = (k: number) => {
    const b = bounds[k];
    const visible = b.x1 >= x0 && b.x0 <= x1 && b.y1 >= y0 && b.y0 <= y1;
    return (visible ? 0 : 1e9) + Math.hypot((b.x0 + b.x1) / 2 - cx, (b.y0 + b.y1) / 2 - cy);
  };
  return (a, b) => score(a) - score(b);
}

/**
 * Memoization du rendu : compare la nouvelle carte à la précédente et ne
 * ré-enregistre que les blocs qui ont changé. Le sol d'un bloc dépend aussi des
 * tuiles voisines (raccords de routes), d'où la marge d'une tuile.
 *
 * Les blocs à refaire sont mis en file et redessinés par passes de quelques
 * millisecondes, ceux visibles à l'écran d'abord : un mois de croissance qui
 * touche toute la ville ne fige jamais l'écran.
 */
class LayerCache {
  private last: Cache | null = null;
  /** Blocs à redessiner : 'ground' (raccords voisins) ou 'all'. */
  private dirty = new Map<number, 'ground' | 'all'>();
  /** Blocs encore en attente (saison ou modifications) : une nouvelle passe est prévue. */
  pending = 0;

  update(tiles: Tile[], size: number): MapLayers {
    const look = renderSeason();
    const prev = this.last;
    if (!prev || prev.size !== size) {
      if (prev) release([...prev.layers.ground, ...prev.layers.shadows, ...prev.layers.buildings, ...prev.layers.lights]);
      const blocks = mapBlocks(size);
      const layers = buildAll(tiles, size, blocks);
      this.last = { tiles, size, blocks, layers, looks: blocks.map(() => look) };
      this.dirty.clear();
      this.pending = 0;
      return layers;
    }
    const mark = (k: number, what: 'ground' | 'all') => {
      if (this.dirty.get(k) !== 'all') this.dirty.set(k, what);
    };

    // 1. Ce qui a changé depuis la dernière carte.
    if (prev.tiles !== tiles) {
      const changed = new Uint8Array(size * size);
      let any = false;
      for (let i = 0; i < tiles.length; i++) {
        if (!visuallyEqual(prev.tiles[i], tiles[i])) {
          changed[i] = 1;
          any = true;
        }
      }
      // Ponts suspendus : toute la travée dépend de chacune de ses tuiles.
      if (any) {
        const deck = (t: Tile | undefined) => !!t && t.lake && (t.type === 'ROAD' || t.type === 'AVENUE' || t.type === 'HIGHWAY');
        const marks: number[] = [];
        for (let i = 0; i < tiles.length; i++) {
          if (!changed[i] || !(deck(tiles[i]) || deck(prev.tiles[i]))) continue;
          const x0 = i % size;
          const y0 = (i - x0) / size;
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            for (let x = x0 + dx, y = y0 + dy; x >= 0 && y >= 0 && x < size && y < size; x += dx, y += dy) {
              const j = y * size + x;
              if (!deck(tiles[j]) && !deck(prev.tiles[j])) break;
              marks.push(j);
            }
          }
        }
        for (const j of marks) changed[j] = 1;
        prev.blocks.forEach((b, k) => {
          let inner = false;
          let border = false;
          let relief = false;
          const inBlock = (x: number, y: number) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
          for (let y = Math.max(0, b.y0 - 1); y <= Math.min(size - 1, b.y1 + 1); y++) {
            for (let x = Math.max(0, b.x0 - 1); x <= Math.min(size - 1, b.x1 + 1); x++) {
              if (!changed[y * size + x]) continue;
              if (inBlock(x, y)) {
                inner = true;
                continue;
              }
              border = true;
              // Une voisine (derrière) qui change peut changer le sol surélevé redessiné devant elle.
              for (const [dx, dy] of [
                [1, 0],
                [0, 1],
                [1, 1],
              ]) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < size && ny < size && inBlock(nx, ny) && tiles[ny * size + nx].elev > 0) relief = true;
              }
            }
          }
          if (inner || relief) mark(k, 'all');
          else if (border) mark(k, 'ground');
        });
      }
    }
    // 2. Changement de saison : tout est à refaire, petit à petit.
    prev.looks.forEach((l, k) => {
      if (l !== look) mark(k, 'all');
    });

    if (!this.dirty.size) {
      this.pending = 0;
      if (prev.tiles !== tiles) this.last = { ...prev, tiles };
      return prev.layers;
    }

    // 3. Passe de dessin : les blocs visibles d'abord, dans la limite du budget.
    const L = prev.layers;
    const next: MapLayers = {
      bounds: L.bounds,
      ground: L.ground.slice(),
      shadows: L.shadows.slice(),
      buildings: L.buildings.slice(),
      lights: L.lights.slice(),
    };
    const looks = prev.looks.slice();
    const order = [...this.dirty.keys()].sort(byVisibility(L.bounds));
    const t0 = Date.now();
    let done = 0;
    for (const k of order) {
      if (done > 0 && Date.now() - t0 > PASS_BUDGET_MS) break;
      const b = prev.blocks[k];
      next.ground[k] = buildGroundPicture(tiles, size, b);
      if (this.dirty.get(k) === 'all') {
        next.shadows[k] = buildShadowPicture(tiles, size, b);
        next.buildings[k] = buildBuildingPicture(tiles, size, b);
        next.lights[k] = buildLightsPicture(tiles, size, b);
        looks[k] = look;
      }
      this.dirty.delete(k);
      done++;
    }
    this.pending = this.dirty.size;
    const old: SkPicture[] = [];
    for (const key of ['ground', 'shadows', 'buildings', 'lights'] as const) {
      L[key].forEach((p, k) => {
        if (next[key][k] !== p) old.push(p);
      });
    }
    release(old);
    this.last = { tiles, size, blocks: prev.blocks, layers: next, looks };
    return next;
  }
}

/**
 * Calques de la carte. `month` règle l'apparence saisonnière (arbres, fleurs,
 * Noël) ; au changement de saison, les blocs sont redessinés par petits lots.
 */
export function useMapLayers(tiles: Tile[], size: number, month = 3): MapLayers {
  const [cache] = useState(() => new LayerCache());
  const [pass, setPass] = useState(0);
  setRenderSeason(month);
  const look = renderSeason();
  const layers = useMemo(() => {
    void pass;
    void look;
    return cache.update(tiles, size);
  }, [cache, tiles, size, look, pass]);
  const pending = cache.pending;
  useEffect(() => {
    if (!pending) return;
    const id = setTimeout(() => setPass((p) => p + 1), 16);
    return () => clearTimeout(id);
  }, [pending, layers]);
  return layers;
}
