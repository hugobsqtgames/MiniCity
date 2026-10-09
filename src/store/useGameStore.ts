import * as Haptics from 'expo-haptics';
import { create } from 'zustand';

import { createDemoMap } from '../engine/demoMap';
import { createEmptyMap, type Tile } from '../engine/map';
import { DEFAULT_TAX, MAX_TAX, MIN_TAX, START_FUNDS, type Speed, type ToolId } from '../sim/constants';
import { applyPower } from '../sim/power';
import { computeStats, simulateMonth, type CityStats, type Demand } from '../sim/simulation';
import { applyTool, gridLine } from '../sim/tools';
import type { SavedGame } from './persistence';

export { createEmptyMap, tileIndex, type Tile, type TileType } from '../engine/map';

export const GRID_SIZE = 50;

export type Toast = { id: number; text: string };

type GameState = {
  hydrated: boolean;
  gridSize: number;
  /**
   * Tableau 1D row-major. Remplacé à chaque modification, et seules les tuiles
   * modifiées sont de nouveaux objets : le renderer ne redessine que les morceaux concernés.
   */
  tiles: Tile[];
  treasury: number;
  /** Mois écoulés depuis Jan 2024. */
  month: number;
  taxRate: number;
  demand: Demand;
  stats: CityStats;
  lastIncome: number;
  lastExpenses: number;
  speed: Speed;
  paused: boolean;
  /** Voitures et piétons animés (désactivables pour économiser la batterie). */
  showAgents: boolean;

  tool: ToolId;
  selected: { x: number; y: number } | null;
  toast: Toast | null;
  /** Dernière tuile peinte pendant un glissé (pour combler les trous). */
  stroke: { x: number; y: number; warned: boolean } | null;

  setTool: (tool: ToolId) => void;
  tapTile: (x: number, y: number) => void;
  paintStart: (x: number, y: number) => void;
  paintMove: (x: number, y: number) => void;
  paintEnd: () => void;
  tick: () => void;
  setSpeed: (speed: Speed) => void;
  togglePause: () => void;
  toggleAgents: () => void;
  setTax: (rate: number) => void;
  newCity: () => void;
  loadDemoCity: () => void;
  hydrate: (save: SavedGame | null) => void;
  showToast: (text: string) => void;
  snapshot: () => SavedGame;
};

const INITIAL_DEMAND: Demand = { r: 0.6, c: 0.2, i: 0.6 };

function freshCity(tiles: Tile[], size: number, treasury: number) {
  const powered = applyPower(tiles, size);
  return {
    gridSize: size,
    tiles: powered,
    treasury,
    month: 0,
    taxRate: DEFAULT_TAX,
    demand: INITIAL_DEMAND,
    stats: computeStats(powered),
    lastIncome: 0,
    lastExpenses: 0,
    selected: null,
    stroke: null,
  };
}

let toastId = 0;

export const useGameStore = create<GameState>()((set, get) => {
  /** Applique l'outil courant sur une tuile ; renvoie la raison d'un refus éventuel. */
  const buildAt = (x: number, y: number): string | null => {
    const s = get();
    const res = applyTool(s.tiles, s.gridSize, s.tool, x, y, s.treasury);
    if (!res.ok) return res.reason || null;
    set({ tiles: res.tiles, treasury: s.treasury - res.cost, stats: computeStats(res.tiles) });
    Haptics.selectionAsync().catch(() => {});
    return null;
  };

  return {
    hydrated: false,
    ...freshCity(createEmptyMap(GRID_SIZE), GRID_SIZE, START_FUNDS),
    speed: 1,
    paused: false,
    showAgents: true,
    tool: 'inspect',
    toast: null,

    setTool: (tool) => set({ tool, selected: null }),

    tapTile: (x, y) => {
      if (get().tool === 'inspect') {
        set({ selected: { x, y } });
        return;
      }
      const reason = buildAt(x, y);
      if (reason) {
        get().showToast(reason);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      }
    },

    paintStart: (x, y) => {
      if (get().tool === 'inspect') return;
      const reason = buildAt(x, y);
      if (reason) get().showToast(reason);
      set({ stroke: { x, y, warned: !!reason } });
    },

    paintMove: (x, y) => {
      const { stroke } = get();
      if (!stroke || (stroke.x === x && stroke.y === y)) return;
      let warned = stroke.warned;
      for (const [px, py] of gridLine(stroke.x, stroke.y, x, y).slice(1)) {
        const reason = buildAt(px, py);
        // Un seul avertissement par glissé, pour ne pas spammer l'écran.
        if (reason && !warned && reason.startsWith('Fonds')) {
          get().showToast(reason);
          warned = true;
        }
      }
      set({ stroke: { x, y, warned } });
    },

    paintEnd: () => set({ stroke: null }),

    tick: () => {
      const s = get();
      if (s.paused || !s.hydrated) return;
      const res = simulateMonth({
        tiles: s.tiles,
        size: s.gridSize,
        treasury: s.treasury,
        taxRate: s.taxRate,
        demand: s.demand,
      });
      set({
        tiles: res.tiles,
        treasury: res.treasury,
        demand: res.demand,
        stats: res.stats,
        lastIncome: res.income,
        lastExpenses: res.expenses,
        month: s.month + 1,
      });
    },

    setSpeed: (speed) => set({ speed, paused: false }),
    togglePause: () => set({ paused: !get().paused }),
    toggleAgents: () => set({ showAgents: !get().showAgents }),
    setTax: (rate) => set({ taxRate: Math.max(MIN_TAX, Math.min(MAX_TAX, Math.round(rate))) }),

    newCity: () => set({ ...freshCity(createEmptyMap(GRID_SIZE), GRID_SIZE, START_FUNDS), paused: false }),
    loadDemoCity: () => set({ ...freshCity(createDemoMap(GRID_SIZE), GRID_SIZE, 50000), paused: false }),

    hydrate: (save) => {
      if (!save) {
        set({ hydrated: true });
        return;
      }
      const tiles = applyPower(save.tiles, save.gridSize);
      set({
        hydrated: true,
        gridSize: save.gridSize,
        tiles,
        treasury: save.treasury,
        month: save.month,
        taxRate: save.taxRate,
        demand: save.demand,
        speed: save.speed,
        stats: computeStats(tiles),
      });
    },

    showToast: (text) => set({ toast: { id: ++toastId, text } }),

    snapshot: () => {
      const s = get();
      return {
        gridSize: s.gridSize,
        tiles: s.tiles,
        treasury: s.treasury,
        month: s.month,
        taxRate: s.taxRate,
        demand: s.demand,
        speed: s.speed,
      };
    },
  };
});
