import * as Haptics from 'expo-haptics';
import { create } from 'zustand';

import { playSfx } from '../audio/sound';
import { createDemoMap } from '../engine/demoMap';
import { createEmptyMap, isZone, type Tile } from '../engine/map';
import { createTerrainMap } from '../engine/terrain';
import {
  DEFAULT_FUNDING,
  DEFAULT_MAP_SIZE,
  DEFAULT_ORDINANCES,
  DEFAULT_TAXES,
  JOBS_C,
  JOBS_I,
  MAX_TAX,
  MIN_TAX,
  RESIDENTS,
  START_FUNDS,
  type DataView,
  type Funding,
  type FundingKey,
  type OrdinanceId,
  type Ordinances,
  type Speed,
  type Taxes,
  type ToolId,
} from '../sim/constants';
import { applyPower } from '../sim/power';
import {
  analyzeCity,
  DISASTER_LABELS,
  simulateMonth,
  topComplaint,
  type CityMaps,
  type CityStats,
  type Demand,
  type DisasterEvent,
  type DisasterKind,
  type Policy,
} from '../sim/simulation';
import { applyTool, gridLine } from '../sim/tools';
import {
  DEFAULT_SETTINGS,
  EMPTY_HISTORY,
  saveSettings,
  type History,
  type NewsEntry,
  type SavedGame,
  type Settings,
} from './persistence';

export { createEmptyMap, tileIndex, type Tile, type TileType } from '../engine/map';

export const GRID_SIZE = DEFAULT_MAP_SIZE;

export type Toast = { id: number; text: string };

/** Fiche d'un citoyen touché à l'écran (voiture ou piéton). */
export type CitizenInfo = {
  name: string;
  age: number;
  role: string;
  mood: number;
  quote: string;
  home: { x: number; y: number } | null;
};

type Snapshot = { tiles: Tile[]; treasury: number };
const UNDO_LIMIT = 40;

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
  taxes: Taxes;
  funding: Funding;
  ordinances: Ordinances;
  disasters: boolean;
  pendingDisaster: DisasterKind | null;
  /** Dernière catastrophe (pour l'animer : tornade, secousse). */
  lastDisaster: { event: DisasterEvent; at: number } | null;
  demand: Demand;
  stats: CityStats;
  maps: CityMaps | null;
  lastIncome: number;
  lastExpenses: number;
  speed: Speed;
  paused: boolean;
  history: History;
  news: NewsEntry[];
  rotation: number;
  dataView: DataView;
  settings: Settings;
  /** Densité de PNJ (1 = haute, 0.6 = moyenne, 0.35 = basse), ajustée par la qualité. */
  agentScale: number;

  tool: ToolId;
  selected: { x: number; y: number } | null;
  citizen: CitizenInfo | null;
  toast: Toast | null;
  /** Dernière tuile peinte pendant un glissé (pour combler les trous). */
  stroke: { x: number; y: number; warned: boolean } | null;
  past: Snapshot[];
  future: Snapshot[];

  setTool: (tool: ToolId) => void;
  tapTile: (x: number, y: number) => void;
  paintStart: (x: number, y: number) => void;
  paintMove: (x: number, y: number) => void;
  paintEnd: () => void;
  undo: () => void;
  redo: () => void;
  tick: () => void;
  setSpeed: (speed: Speed) => void;
  togglePause: () => void;
  setTax: (zone: keyof Taxes, rate: number) => void;
  setFunding: (key: FundingKey, value: number) => void;
  toggleOrdinance: (id: OrdinanceId) => void;
  setDisasters: (on: boolean) => void;
  triggerDisaster: (kind: DisasterKind) => void;
  rotate: (dir: 1 | -1) => void;
  setDataView: (view: DataView) => void;
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  hydrateSettings: (settings: Settings) => void;
  setAgentScale: (scale: number) => void;
  showCitizen: (info: CitizenInfo | null) => void;
  newCity: (size?: number) => void;
  loadDemoCity: () => void;
  hydrate: (save: SavedGame | null) => void;
  showToast: (text: string) => void;
  snapshot: () => SavedGame;
  policy: () => Policy;
};

const INITIAL_DEMAND: Demand = { r: 0.6, c: 0.2, i: 0.6 };
const DEFAULT_POLICY_STATE = { taxes: DEFAULT_TAXES, funding: DEFAULT_FUNDING, ordinances: DEFAULT_ORDINANCES };

function freshCity(tiles: Tile[], size: number, treasury: number) {
  const powered = applyPower(tiles, size);
  const a = analyzeCity(powered, size);
  return {
    gridSize: size,
    tiles: powered,
    treasury,
    month: 0,
    ...DEFAULT_POLICY_STATE,
    demand: INITIAL_DEMAND,
    stats: a.stats,
    maps: a.maps,
    lastIncome: 0,
    lastExpenses: 0,
    selected: null,
    citizen: null,
    stroke: null,
    history: EMPTY_HISTORY,
    news: [] as NewsEntry[],
    past: [] as Snapshot[],
    future: [] as Snapshot[],
    lastDisaster: null,
    pendingDisaster: null,
  };
}

/** Recompte rapide (population, emplois) après une construction, sans analyse complète. */
function quickStats(prev: CityStats, tiles: Tile[]): CityStats {
  let population = 0;
  let jobsC = 0;
  let jobsI = 0;
  let roads = 0;
  let zones = 0;
  for (const t of tiles) {
    if (t.type === 'ROAD' || t.type === 'AVENUE' || t.type === 'HIGHWAY') roads++;
    if (!isZone(t.type)) continue;
    zones++;
    if (t.fire > 0) continue;
    if (t.type === 'R') population += RESIDENTS[t.density];
    else if (t.type === 'C') jobsC += JOBS_C[t.density];
    else jobsI += JOBS_I[t.density];
  }
  return { ...prev, population, jobsC, jobsI, roads, zones };
}

const pushCapped = (arr: number[], v: number) => (arr.length >= 240 ? [...arr.slice(1), v] : [...arr, v]);

let toastId = 0;

export const useGameStore = create<GameState>()((set, get) => {
  /** Applique l'outil courant sur une tuile ; renvoie la raison d'un refus éventuel. */
  const buildAt = (x: number, y: number, recordUndo: boolean): string | null => {
    const s = get();
    const res = applyTool(s.tiles, s.gridSize, s.tool, x, y, { funds: s.treasury, population: s.stats.population });
    if (!res.ok) return res.reason || null;
    const undo = recordUndo ? { past: [...s.past.slice(-(UNDO_LIMIT - 1)), { tiles: s.tiles, treasury: s.treasury }], future: [] } : {};
    set({ tiles: res.tiles, treasury: s.treasury - res.cost, stats: quickStats(s.stats, res.tiles), ...undo });
    Haptics.selectionAsync().catch(() => {});
    playSfx(s.tool === 'bulldoze' ? 'bulldoze' : 'build');
    return null;
  };

  const persistSettings = () => saveSettings(get().settings).catch(() => {});

  return {
    hydrated: false,
    ...freshCity(createEmptyMap(50), 50, START_FUNDS),
    disasters: false,
    speed: 1,
    paused: false,
    rotation: 0,
    dataView: 'none',
    settings: DEFAULT_SETTINGS,
    agentScale: 1,
    tool: 'inspect',
    toast: null,

    setTool: (tool) => set({ tool, selected: null, citizen: null }),

    tapTile: (x, y) => {
      if (get().tool === 'inspect') {
        set({ selected: { x, y }, citizen: null });
        return;
      }
      const reason = buildAt(x, y, true);
      if (reason) {
        get().showToast(reason);
        playSfx('error');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      }
    },

    paintStart: (x, y) => {
      if (get().tool === 'inspect') return;
      // Tout le glissé ne forme qu'une seule action à annuler.
      const s = get();
      set({ past: [...s.past.slice(-(UNDO_LIMIT - 1)), { tiles: s.tiles, treasury: s.treasury }], future: [] });
      const reason = buildAt(x, y, false);
      if (reason) get().showToast(reason);
      set({ stroke: { x, y, warned: !!reason } });
    },

    paintMove: (x, y) => {
      const { stroke } = get();
      if (!stroke || (stroke.x === x && stroke.y === y)) return;
      let warned = stroke.warned;
      for (const [px, py] of gridLine(stroke.x, stroke.y, x, y).slice(1)) {
        const reason = buildAt(px, py, false);
        // Un seul avertissement par glissé, pour ne pas spammer l'écran.
        if (reason && !warned && reason.startsWith('Fonds')) {
          get().showToast(reason);
          warned = true;
        }
      }
      set({ stroke: { x, y, warned } });
    },

    paintEnd: () => {
      const s = get();
      // Glissé sans aucun effet : on retire l'entrée d'annulation inutile.
      const last = s.past[s.past.length - 1];
      if (last && last.tiles === s.tiles) set({ past: s.past.slice(0, -1) });
      set({ stroke: null });
    },

    undo: () => {
      const s = get();
      const prev = s.past[s.past.length - 1];
      if (!prev) return;
      set({
        tiles: prev.tiles,
        treasury: prev.treasury,
        past: s.past.slice(0, -1),
        future: [...s.future, { tiles: s.tiles, treasury: s.treasury }],
        stats: quickStats(s.stats, prev.tiles),
      });
      get().showToast('↶ Action annulée (remboursée)');
      playSfx('click');
    },

    redo: () => {
      const s = get();
      const next = s.future[s.future.length - 1];
      if (!next) return;
      set({
        tiles: next.tiles,
        treasury: next.treasury,
        future: s.future.slice(0, -1),
        past: [...s.past, { tiles: s.tiles, treasury: s.treasury }],
        stats: quickStats(s.stats, next.tiles),
      });
      get().showToast('↷ Action rétablie');
      playSfx('click');
    },

    tick: () => {
      const s = get();
      if (s.paused || !s.hydrated) return;
      const res = simulateMonth({
        tiles: s.tiles,
        size: s.gridSize,
        treasury: s.treasury,
        policy: s.policy(),
        demand: s.demand,
        disasters: s.disasters,
        trigger: s.pendingDisaster,
      });
      const month = s.month + 1;

      // Événements du mois : on prévient le joueur comme dans SimCity.
      const disaster = res.events.disasters[0];
      if (disaster) {
        const L = DISASTER_LABELS[disaster.kind];
        get().showToast(`${L.icon} ${L.label} ! ${disaster.damage} tuile(s) touchée(s)`);
        playSfx('alarm');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      } else if (res.events.newFires > 0) {
        get().showToast(res.stats.coverage.fire > 0 ? '🔥 Incendie ! Les pompiers interviennent' : '🔥 Incendie ! Construisez une caserne 🚒');
        playSfx('siren');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      } else if (res.events.destroyed > 0) {
        get().showToast(`💥 ${res.events.destroyed} bâtiment(s) détruit(s) par le feu`);
      }

      // Journal : événements + une plainte de temps en temps.
      const news = res.events.news.map((n) => ({ ...n, month }));
      const complaint = month % 6 === 0 ? topComplaint(res.stats, s.taxes) : null;
      if (complaint) news.push({ ...complaint, month });
      if (res.treasury < 0 && s.treasury >= 0) news.push({ icon: '📉', text: 'La ville est dans le rouge !', month });
      if (news.some((n) => n.icon === '🎉' || n.icon === '🏛️')) playSfx('fanfare');

      set({
        tiles: res.tiles,
        treasury: res.treasury,
        demand: res.demand,
        stats: res.stats,
        maps: res.maps,
        lastIncome: res.income,
        lastExpenses: res.expenses,
        month,
        pendingDisaster: null,
        lastDisaster: disaster ? { event: disaster, at: Date.now() } : s.lastDisaster,
        news: news.length ? [...news.reverse(), ...s.news].slice(0, 60) : s.news,
        history: {
          pop: pushCapped(s.history.pop, res.stats.population),
          money: pushCapped(s.history.money, Math.round(res.treasury)),
          happy: pushCapped(s.history.happy, res.stats.happiness),
          crime: pushCapped(s.history.crime, res.stats.crime),
          pollution: pushCapped(s.history.pollution, res.stats.pollution),
        },
      });
    },

    setSpeed: (speed) => set({ speed, paused: false }),
    togglePause: () => set({ paused: !get().paused }),
    setTax: (zone, rate) => set({ taxes: { ...get().taxes, [zone]: Math.max(MIN_TAX, Math.min(MAX_TAX, Math.round(rate))) } }),
    setFunding: (key, value) => set({ funding: { ...get().funding, [key]: Math.max(0, Math.min(120, Math.round(value / 10) * 10)) } }),
    toggleOrdinance: (id) => set({ ordinances: { ...get().ordinances, [id]: !get().ordinances[id] } }),
    setDisasters: (on) => set({ disasters: on }),
    triggerDisaster: (kind) => {
      set({ pendingDisaster: kind, paused: false });
      get().showToast(`${DISASTER_LABELS[kind].icon} ${DISASTER_LABELS[kind].label} imminent…`);
    },
    rotate: (dir) => {
      set({ rotation: (get().rotation + dir + 4) % 4, selected: null });
      playSfx('click');
    },
    setDataView: (view) => set({ dataView: view }),
    setSetting: (key, value) => {
      set({ settings: { ...get().settings, [key]: value } });
      persistSettings();
    },
    hydrateSettings: (settings) => set({ settings }),
    setAgentScale: (scale) => {
      if (get().agentScale !== scale) set({ agentScale: scale });
    },
    showCitizen: (info) => set({ citizen: info, selected: null }),

    newCity: (size = GRID_SIZE) =>
      set({ ...freshCity(createTerrainMap(size), size, START_FUNDS), paused: false, rotation: 0, dataView: 'none', disasters: get().disasters }),
    loadDemoCity: () => set({ ...freshCity(createDemoMap(50), 50, 50000), paused: false, rotation: 0, dataView: 'none' }),

    hydrate: (save) => {
      if (!save) {
        // Première partie : une carte naturelle neuve.
        set({ ...freshCity(createTerrainMap(GRID_SIZE), GRID_SIZE, START_FUNDS), hydrated: true });
        return;
      }
      const tiles = applyPower(save.tiles, save.gridSize);
      const a = analyzeCity(tiles, save.gridSize, { taxes: save.taxes, funding: save.funding, ordinances: save.ordinances });
      set({
        hydrated: true,
        gridSize: save.gridSize,
        tiles,
        treasury: save.treasury,
        month: save.month,
        taxes: save.taxes,
        funding: save.funding,
        ordinances: save.ordinances,
        disasters: save.disasters,
        demand: save.demand,
        speed: save.speed,
        history: save.history,
        news: save.news,
        rotation: save.rotation,
        stats: a.stats,
        maps: a.maps,
        past: [],
        future: [],
      });
    },

    showToast: (text) => set({ toast: { id: ++toastId, text } }),

    policy: () => {
      const s = get();
      return { taxes: s.taxes, funding: s.funding, ordinances: s.ordinances };
    },

    snapshot: () => {
      const s = get();
      return {
        gridSize: s.gridSize,
        tiles: s.tiles,
        treasury: s.treasury,
        month: s.month,
        taxes: s.taxes,
        funding: s.funding,
        ordinances: s.ordinances,
        disasters: s.disasters,
        demand: s.demand,
        speed: s.speed,
        history: s.history,
        news: s.news,
        rotation: s.rotation,
      };
    },
  };
});
