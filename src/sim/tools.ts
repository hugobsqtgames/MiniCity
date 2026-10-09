import type { Tile } from '../engine/map';
import { TOOL_BY_ID, type ToolId } from './constants';
import { applyPower } from './power';

export type ToolResult = { ok: true; tiles: Tile[]; cost: number } | { ok: false; reason: string };

const isEmptyGround = (t: Tile) => t.type === 'GRASS' || t.type === 'DIRT';

/** Applique un outil sur une tuile. Pure : renvoie une nouvelle carte (ou une raison de refus). */
export function applyTool(tiles: Tile[], size: number, tool: ToolId, x: number, y: number, funds: number): ToolResult {
  if (x < 0 || y < 0 || x >= size || y >= size) return { ok: false, reason: 'Hors de la carte' };
  const def = TOOL_BY_ID[tool];
  const idx = y * size + x;
  const tile = tiles[idx];
  let next: Tile;

  if (tool === 'inspect') return { ok: false, reason: '' };

  if (tool === 'bulldoze') {
    if (tile.type === 'GRASS') return { ok: false, reason: 'Rien à raser ici' };
    // Un bâtiment rasé laisse un terrain vague ; un terrain vague redevient de l'herbe.
    next = { ...tile, type: tile.type === 'DIRT' ? 'GRASS' : 'DIRT', density: 0, powered: false, value: 0 };
  } else {
    if (tile.type === def.places) return { ok: false, reason: '' };
    if (!isEmptyGround(tile)) return { ok: false, reason: 'Terrain occupé — passez le bulldozer 🚜' };
    next = { ...tile, type: def.places!, density: 0, powered: false, value: 0 };
  }

  if (funds < def.cost) return { ok: false, reason: 'Fonds insuffisants 💸' };

  const out = tiles.slice();
  out[idx] = next;
  return { ok: true, tiles: applyPower(out, size), cost: def.cost };
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
