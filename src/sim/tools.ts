import { isBuildableGround, isMonument, isRoadType, isVenue, type Tile } from '../engine/map';
import { MONUMENT_UNLOCK, NUCLEAR_UNLOCK, TOOL_BY_ID, VENUE_UNLOCK, type ToolId } from './constants';
import { applyPower } from './power';

export type ToolResult = { ok: true; tiles: Tile[]; cost: number } | { ok: false; reason: string };

/** Contexte de construction : budget et population (pour débloquer les monuments). */
export type BuildContext = { funds: number; population: number; month?: number };

/** Surcoût d'un pont (route sur l'eau) et du défrichage d'une forêt. */
export const BRIDGE_FACTOR = 4;
export const CLEAR_FOREST_COST = 5;

const ROAD_RANK = { ROAD: 1, AVENUE: 2, HIGHWAY: 3 } as const;

const reset = (tile: Tile, type: Tile['type'], lake = false): Tile => ({
  ...tile,
  type,
  density: 0,
  powered: false,
  water: false,
  value: 0,
  fire: 0,
  garbage: 0,
  flood: 0,
  lake,
});

function nextToLake(tiles: Tile[], size: number, x: number, y: number): boolean {
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < size && ny < size && tiles[ny * size + nx].type === 'LAKE') return true;
  }
  return false;
}

/** Coût réel d'un outil sur une tuile (pont, défrichage, pompage dans un lac). */
export function toolCost(tiles: Tile[], size: number, tool: ToolId, x: number, y: number): number {
  const def = TOOL_BY_ID[tool];
  const tile = tiles[y * size + x];
  let cost = def.cost;
  if (def.places && isRoadType(def.places) && (tile.type === 'LAKE' || tile.lake)) cost *= BRIDGE_FACTOR;
  if (tile.type === 'FOREST' && tool !== 'bulldoze') cost += CLEAR_FOREST_COST;
  if (tool === 'water' && nextToLake(tiles, size, x, y)) cost = Math.round(cost / 2);
  if (tool === 'bulldoze' && tile.type === 'FOREST') cost = CLEAR_FOREST_COST;
  return cost;
}

/** Applique un outil sur une tuile. Pure : renvoie une nouvelle carte (ou une raison de refus). */
export function applyTool(tiles: Tile[], size: number, tool: ToolId, x: number, y: number, ctx: BuildContext | number): ToolResult {
  const { funds, population, month } = typeof ctx === 'number' ? { funds: ctx, population: Infinity, month: 3 } : ctx;
  if (x < 0 || y < 0 || x >= size || y >= size) return { ok: false, reason: 'Hors de la carte' };
  const def = TOOL_BY_ID[tool];
  const idx = y * size + x;
  const tile = tiles[idx];
  let next: Tile;

  if (tool === 'inspect') return { ok: false, reason: '' };

  if (tool === 'bulldoze') {
    if (tile.type === 'GRASS' || tile.type === 'SAND') return { ok: false, reason: 'Rien à raser ici' };
    if (tile.type === 'LAKE') return { ok: false, reason: 'Impossible d’assécher l’eau 🌊' };
    if (tile.type === 'FOREST') next = reset(tile, 'GRASS');
    // Un pont rasé rend l'eau ; un bâtiment rasé laisse un terrain vague ; un terrain vague redevient de l'herbe.
    else if (tile.lake) next = reset(tile, 'LAKE');
    else next = reset(tile, tile.type === 'DIRT' ? 'GRASS' : 'DIRT');
  } else {
    const places = def.places!;
    if (tile.type === places) return { ok: false, reason: '' };
    if (tile.rad > 0) return { ok: false, reason: 'Terrain contaminé ☢️ — attendez la décontamination' };
    if (isMonument(places)) {
      if (population < MONUMENT_UNLOCK[places]) {
        return { ok: false, reason: `🔒 Débloqué à ${MONUMENT_UNLOCK[places]} habitants` };
      }
      if (tiles.some((t) => t.type === places)) return { ok: false, reason: 'Un seul exemplaire par ville 🏛️' };
    }
    if (isVenue(places) && population < VENUE_UNLOCK[places]) {
      return { ok: false, reason: `🔒 Débloqué à ${VENUE_UNLOCK[places]} habitants` };
    }
    if (places === 'NUCLEAR' && population < NUCLEAR_UNLOCK) return { ok: false, reason: `🔒 Nucléaire débloqué à ${NUCLEAR_UNLOCK} habitants` };
    if (places === 'PORT' && !nextToLake(tiles, size, x, y)) return { ok: false, reason: 'Un port se construit au bord de l’eau ⚓' };
    if (isRoadType(places)) {
      // Routes : sur terrain libre, en pont sur l'eau, ou en montée en gamme d'une route existante.
      const upgrade = isRoadType(tile.type) && ROAD_RANK[places] > ROAD_RANK[tile.type];
      if (isRoadType(tile.type) && !upgrade) return { ok: false, reason: '' };
      if (!upgrade && !isBuildableGround(tile.type) && tile.type !== 'FOREST' && tile.type !== 'LAKE') {
        return { ok: false, reason: 'Terrain occupé — passez le bulldozer 🚜' };
      }
      next = reset(tile, places, tile.type === 'LAKE' || tile.lake);
    } else {
      if (tile.type === 'LAKE') return { ok: false, reason: 'On ne construit pas sur l’eau 🌊' };
      if (!isBuildableGround(tile.type) && tile.type !== 'FOREST') return { ok: false, reason: 'Terrain occupé — passez le bulldozer 🚜' };
      next = reset(tile, places);
    }
  }

  const cost = toolCost(tiles, size, tool, x, y);
  if (funds < cost) return { ok: false, reason: 'Fonds insuffisants 💸' };

  const out = tiles.slice();
  out[idx] = next;
  return { ok: true, tiles: applyPower(out, size, month ?? 3), cost };
}

/**
 * Tuiles traversées entre deux points de la grille, en 4-connexité (pas de
 * diagonale) : peindre au doigt une route rapide ne laisse ni trou ni coupure.
 */
export function gridLine(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const nx = Math.abs(x1 - x0);
  const ny = Math.abs(y1 - y0);
  const sx = Math.sign(x1 - x0);
  const sy = Math.sign(y1 - y0);
  let x = x0;
  let y = y0;
  const pts: [number, number][] = [[x, y]];
  for (let ix = 0, iy = 0; ix < nx || iy < ny; ) {
    if ((0.5 + ix) / nx < (0.5 + iy) / ny) {
      x += sx;
      ix++;
    } else {
      y += sy;
      iy++;
    }
    pts.push([x, y]);
  }
  return pts;
}
