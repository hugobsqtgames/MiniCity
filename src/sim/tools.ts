import { isBuildableGround, isBuilding, isMonument, isRoadType, isVenue, LINE_RAIL, LINE_TRAM, MAX_ELEV, type Tile } from '../engine/map';
import { MONUMENT_UNLOCK, NUCLEAR_UNLOCK, TERRAFORM_COST, TOOL_BY_ID, TRAM_COST, TUNNEL_FACTOR, UNLOCK, VENUE_UNLOCK, type ToolId } from './constants';
import { applyPower } from './power';

export type ToolResult = { ok: true; tiles: Tile[]; cost: number } | { ok: false; reason: string };

/** Contexte de construction : budget et population (pour débloquer les monuments). */
export type BuildContext = { funds: number; population: number; month?: number; /** false : pas de recalcul des réseaux (glisser en lot, recalculé à la fin). */ power?: boolean; /** Vérifie seulement (estimation du coût d'un glisser). */ dryRun?: boolean };

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
  line: 0,
  spec: 0,
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
  if (tool === 'raise' || tool === 'lower') return TERRAFORM_COST;
  if (tool === 'tram') return TRAM_COST;
  if (def.places && isRoadType(def.places) && (tile.type === 'LAKE' || tile.lake)) cost *= BRIDGE_FACTOR;
  // Tunnel : une route creusée dans une montagne coûte bien plus cher.
  if (def.places && isRoadType(def.places) && tile.elev >= 2) cost *= TUNNEL_FACTOR;
  if (tile.type === 'FOREST' && tool !== 'bulldoze') cost += CLEAR_FOREST_COST;
  if (tool === 'water' && nextToLake(tiles, size, x, y)) cost = Math.round(cost / 2);
  if (tool === 'bulldoze' && tile.type === 'FOREST') cost = CLEAR_FOREST_COST;
  return cost;
}

/** Applique un outil sur une tuile. Pure : renvoie une nouvelle carte (ou une raison de refus). */
export function applyTool(tiles: Tile[], size: number, tool: ToolId, x: number, y: number, ctx: BuildContext | number): ToolResult {
  const { funds, population, month, power = true, dryRun = false } = typeof ctx === 'number' ? { funds: ctx, population: Infinity, month: 3, power: true, dryRun: false } : ctx;
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
    // Une plage aménagée rasée redevient du sable (on pourra la réaménager).
    else if (tile.type === 'RESORT') next = reset(tile, 'SAND');
    else next = reset(tile, tile.type === 'DIRT' ? 'GRASS' : 'DIRT');
  } else if (tool === 'raise' || tool === 'lower') {
    // Terrassement : uniquement sur un terrain nu ou une parcelle vide.
    if (tile.type === 'LAKE' || tile.lake) return { ok: false, reason: 'On ne terrasse pas l’eau 🌊' };
    if (isBuilding(tile) || isRoadType(tile.type) || tile.type === 'RAIL') return { ok: false, reason: 'Terrain occupé — passez le bulldozer 🚜' };
    const elev = tile.elev + (tool === 'raise' ? 1 : -1);
    if (elev < 0) return { ok: false, reason: 'Impossible de creuser plus bas' };
    if (elev > MAX_ELEV) return { ok: false, reason: 'Sommet atteint ⛰️' };
    // Relief en terrasses : au plus un niveau d'écart avec les cases voisines.
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const n = tiles[ny * size + nx];
      const ne = n.type === 'LAKE' ? 0 : n.elev;
      if (Math.abs(elev - ne) > 1) return { ok: false, reason: 'Pente trop raide ⛰️ — terrassez d’abord les cases voisines' };
    }
    // Creuser au ras de l'eau, au niveau 0, ne change rien : le niveau 0 est le plancher.
    next = { ...tile, elev };
  } else if (tool === 'tram') {
    if (tile.type !== 'AVENUE') return { ok: false, reason: 'Le tramway se pose sur une avenue 🚋' };
    if (tile.line & LINE_TRAM) return { ok: false, reason: '' };
    next = { ...tile, line: tile.line | LINE_TRAM };
  } else {
    const places = def.places!;
    const unlock = UNLOCK[places];
    if (unlock !== undefined && places !== 'NUCLEAR' && population < unlock) return { ok: false, reason: `🔒 Débloqué à ${unlock} habitants` };
    if (places === 'RAIL' && isRoadType(tile.type)) {
      // Passage à niveau sur une rue ou une avenue (pas sur une autoroute).
      if (tile.type === 'HIGHWAY') return { ok: false, reason: 'Pas de passage à niveau sur une autoroute 🛣' };
      if (tile.lake) return { ok: false, reason: 'Pas de voie ferrée sur un pont routier 🌉' };
      if (tile.line & LINE_RAIL) return { ok: false, reason: '' };
      if (tile.flood > 0) return { ok: false, reason: 'Route inondée 🌊 — attendez la décrue' };
      if (tile.rad > 0) return { ok: false, reason: 'Terrain contaminé ☢️ — attendez la décontamination' };
      const cost = toolCost(tiles, size, tool, x, y);
      if (funds < cost) return { ok: false, reason: 'Fonds insuffisants 💸' };
      if (dryRun) return { ok: true, tiles, cost };
      const out = tiles.slice();
      out[idx] = { ...tile, line: tile.line | LINE_RAIL };
      return { ok: true, tiles: out, cost };
    }
    if (places === 'RESORT' && (tile.type !== 'SAND' || !nextToLake(tiles, size, x, y))) {
      return { ok: false, reason: 'Une plage s’aménage sur le sable, au bord de l’eau 🏖️' };
    }
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
      if (upgrade && places === 'HIGHWAY' && tile.line & LINE_RAIL) return { ok: false, reason: 'Passage à niveau : une autoroute ne peut pas couper la voie ferrée 🚆' };
      if (!upgrade && !isBuildableGround(tile.type) && tile.type !== 'FOREST' && tile.type !== 'LAKE') {
        return { ok: false, reason: 'Terrain occupé — passez le bulldozer 🚜' };
      }
      next = reset(tile, places, tile.type === 'LAKE' || tile.lake);
      // Une montée en gamme garde le passage à niveau (sauf autoroute) et le tram (avenue seulement).
      if (upgrade) next.line = places === 'HIGHWAY' ? 0 : tile.line & LINE_RAIL;
    } else {
      if (tile.type === 'LAKE') return { ok: false, reason: 'On ne construit pas sur l’eau 🌊' };
      if (!isBuildableGround(tile.type) && tile.type !== 'FOREST') return { ok: false, reason: 'Terrain occupé — passez le bulldozer 🚜' };
      next = reset(tile, places);
    }
  }

  const cost = toolCost(tiles, size, tool, x, y);
  if (funds < cost) return { ok: false, reason: 'Fonds insuffisants 💸' };
  if (dryRun) return { ok: true, tiles, cost };

  const out = tiles.slice();
  out[idx] = next;
  return { ok: true, tiles: power ? applyPower(out, size, month ?? 3) : out, cost };
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
