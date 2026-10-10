import { createEmptyMap, type Tile, type TileType } from '../engine/map';
import { mulberry32 } from '../engine/terrain';

/** Pose des tuiles sur une carte vierge (coordonnées x, y). */
export function place(tiles: Tile[], size: number, cells: [number, number, TileType, number?][]): Tile[] {
  for (const [x, y, type, density = 0] of cells) {
    const t = tiles[y * size + x];
    t.type = type;
    t.density = density;
  }
  return tiles;
}

/**
 * Petite ville de test 20×20 : une rue horizontale (y = 5), des maisons de part
 * et d'autre, du commerce et de l'industrie plus loin, une centrale et un château d'eau.
 */
export function smallCity(size = 20): Tile[] {
  const tiles = createEmptyMap(size);
  const cells: [number, number, TileType, number?][] = [];
  for (let x = 1; x < size - 1; x++) cells.push([x, 5, 'ROAD']);
  for (let x = 2; x <= 8; x++) {
    cells.push([x, 4, 'R']);
    cells.push([x, 6, 'R']);
  }
  for (let x = 10; x <= 12; x++) cells.push([x, 4, 'C']);
  for (let x = 14; x <= 17; x++) cells.push([x, 6, 'I']);
  cells.push([15, 4, 'POWER']);
  cells.push([16, 4, 'WATER']);
  return place(tiles, size, cells);
}

export const seeded = (seed = 42) => mulberry32(seed);
