export type TileType = 'DIRT' | 'GRASS' | 'ROAD' | 'R' | 'C' | 'I' | 'POWER';

export type Tile = {
  x: number;
  y: number;
  type: TileType;
  /** 0-3 */
  density: number;
  powered: boolean;
  value: number;
};

export function createEmptyMap(size: number): Tile[] {
  const tiles: Tile[] = new Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      tiles[y * size + x] = { x, y, type: 'GRASS', density: 0, powered: false, value: 0 };
    }
  }
  return tiles;
}

/** Index 1D (row-major) : l'ordre du tableau EST l'ordre de rendu (y puis x). */
export const tileIndex = (x: number, y: number, size: number) => y * size + x;
