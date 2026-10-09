import { create } from 'zustand';

import { createDemoMap } from '../engine/demoMap';
import { createEmptyMap, type Tile } from '../engine/map';

export { createEmptyMap, tileIndex, type Tile, type TileType } from '../engine/map';

export const GRID_SIZE = 50;

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
  // Phase 2 : quartier de démo pour juger le rendu (remplacé par une carte vierge quand les outils arriveront).
  tiles: createDemoMap(GRID_SIZE),
  selected: null,
  selectTile: (x, y) => set({ selected: { x, y } }),
  clearSelection: () => set({ selected: null }),
  newMap: (size = GRID_SIZE) => set({ gridSize: size, tiles: createEmptyMap(size), selected: null }),
}));
