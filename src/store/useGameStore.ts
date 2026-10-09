import { create } from 'zustand';

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

/** Phase 1 : 20x20. Passera à 50x50 en phase 2+. */
export const GRID_SIZE = 20;

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

type GameState = {
  gridSize: number;
  /** Tableau 1D row-major. Remplacé (immutabilité) à chaque modification -> le renderer ne se recalcule que dans ce cas. */
  tiles: Tile[];
  /** Tuile touchée (démo du raycasting inverse en phase 1). */
  selected: { x: number; y: number } | null;
  selectTile: (x: number, y: number) => void;
  clearSelection: () => void;
  newMap: (size?: number) => void;
};

export const useGameStore = create<GameState>()((set) => ({
  gridSize: GRID_SIZE,
  tiles: createEmptyMap(GRID_SIZE),
  selected: null,
  selectTile: (x, y) => set({ selected: { x, y } }),
  clearSelection: () => set({ selected: null }),
  newMap: (size = GRID_SIZE) => set({ gridSize: size, tiles: createEmptyMap(size), selected: null }),
}));
