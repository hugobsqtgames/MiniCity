import * as Haptics from 'expo-haptics';
import { create } from 'zustand';

import { playSfx } from '../audio/sound';
import { focusTile } from '../engine/cameraBridge';
import { createDemoMap } from '../engine/demoMap';
import { createEmptyMap, isBuildableGround, isZone, type Tile } from '../engine/map';
import { createTerrainMap } from '../engine/terrain';
import { getAdvice, type Advice } from '../sim/advisors';
import { challengeContext, EMPTY_COUNTERS, newlyCompleted, type Counters } from '../sim/challenges';
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
  seasonOf,
  START_FUNDS,
  TOOL_BY_ID,
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
  EVENT_COST,
  EVENT_LABELS,
  simulateMonth,
  topComplaint,
  type Analysis,
  type CityEvent,
  type CityMaps,
  type CityStats,
  type Demand,
  type DisasterEvent,
  type DisasterKind,
  type Policy,
  type Weather,
} from '../sim/simulation';
import { dragModeOf, dragTiles, type Drag } from '../sim/drag';
import { applyTool, gridLine, toolCost } from '../sim/tools';
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

/** Onglets du menu (null = fermé). */
export type MenuTab = 'advisors' | 'city' | 'districts' | 'budget' | 'laws' | 'events' | 'news' | 'charts' | 'settings';

/** Une action à annuler : les tuiles modifiées (avant / après) et son coût. */
type UndoAction = { cells: { i: number; before: Tile; after: Tile }[]; cost: number };
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
  cityName: string;
  /** Ville de démonstration : les défis n'y comptent pas. */
  isDemo: boolean;
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
  analysis: Analysis | null;
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
  weather: Weather;
  cityEvents: CityEvent[];
  /** Lieux où le maire a organisé un événement pour le mois prochain. */
  forcedEvents: { x: number; y: number }[];
  advice: Advice[];
  counters: Counters;
  challenges: Record<string, number>;
  menuTab: MenuTab | null;
  challengesOpen: boolean;
  /** Demande de confirmation en cours (actions destructrices). */
  confirm: { title: string; message: string; label: string; onConfirm: () => void } | null;

  tool: ToolId;
  selected: { x: number; y: number } | null;
  citizen: CitizenInfo | null;
  toast: Toast | null;
  /** Dernière tuile peinte pendant un glissé (pour combler les trous). */
  stroke: { x: number; y: number; warned: boolean } | null;
  drag: Drag | null;
  past: UndoAction[];
  future: UndoAction[];

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
  organizeEvent: (x: number, y: number) => void;
  focusOn: (x: number, y: number, view?: DataView) => void;
  openMenu: (tab: MenuTab | null) => void;
  openChallenges: (open: boolean) => void;
  askConfirm: (title: string, message: string, label: string, onConfirm: () => void) => void;
  closeConfirm: () => void;
  setCityName: (name: string) => void;
  newCity: (size?: number) => void;
  loadDemoCity: () => void;
  hydrate: (save: SavedGame | null) => void;
  showToast: (text: string) => void;
  snapshot: () => SavedGame;
  policy: () => Policy;
};

const INITIAL_DEMAND: Demand = { r: 0.6, c: 0.2, i: 0.6 };
const DEFAULT_POLICY_STATE = { taxes: DEFAULT_TAXES, funding: DEFAULT_FUNDING, ordinances: DEFAULT_ORDINANCES };
const CITY_NAMES = ['Belle-Ville', 'Port-Joli', 'Montverdun', 'Val-Clair', 'Rivebelle', 'Saint-Aubin', 'Clairmont', 'Beaulieu'];
const randomCityName = () => CITY_NAMES[Math.floor(Math.random() * CITY_NAMES.length)];

function adviceFor(tiles: Tile[], size: number, a: Analysis, policy: Policy, treasury: number, net: number, month: number) {
  try {
    return getAdvice(tiles, size, a, policy, { treasury, net, month });
  } catch {
    return [];
  }
}

function freshCity(tiles: Tile[], size: number, treasury: number, name = randomCityName(), isDemo = false) {
  const powered = applyPower(tiles, size, 0);
  const a = analyzeCity(powered, size, undefined, 0);
  return {
    gridSize: size,
    tiles: powered,
    treasury,
    month: 0,
    cityName: name,
    isDemo,
    ...DEFAULT_POLICY_STATE,
    demand: INITIAL_DEMAND,
    stats: a.stats,
    maps: a.maps,
    analysis: a,
    advice: adviceFor(powered, size, a, { taxes: DEFAULT_TAXES, funding: DEFAULT_FUNDING, ordinances: DEFAULT_ORDINANCES }, treasury, 0, 0),
    lastIncome: 0,
    lastExpenses: 0,
    selected: null,
    citizen: null,
    stroke: null,
    drag: null,
    history: EMPTY_HISTORY,
    news: [] as NewsEntry[],
    past: [] as UndoAction[],
    future: [] as UndoAction[],
    lastDisaster: null,
    pendingDisaster: null,
    weather: 'clear' as Weather,
    cityEvents: [] as CityEvent[],
    forcedEvents: [] as { x: number; y: number }[],
    counters: EMPTY_COUNTERS,
    challenges: {} as Record<string, number>,
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
  /** Vibrations, si elles sont activées dans les réglages. */
  const haptic = (kind: 'select' | 'warn' | 'error' | 'success') => {
    if (!get().settings.haptics) return;
    const p =
      kind === 'select'
        ? Haptics.selectionAsync()
        : Haptics.notificationAsync(
            kind === 'warn' ? Haptics.NotificationFeedbackType.Warning : kind === 'error' ? Haptics.NotificationFeedbackType.Error : Haptics.NotificationFeedbackType.Success,
          );
    p.catch(() => {});
  };

  /** Action en cours d'enregistrement (glissé) : toutes ses tuiles forment une seule entrée d'annulation. */
  let pending: UndoAction | null = null;
  const pushUndo = (action: UndoAction) => {
    if (!action.cells.length) return;
    set({ past: [...get().past.slice(-(UNDO_LIMIT - 1)), action], future: [] });
  };

  /** Applique l'outil courant sur une tuile ; renvoie la raison d'un refus éventuel. */
  const buildAt = (x: number, y: number, recordUndo: boolean, quiet = false): string | null => {
    const s = get();
    const res = applyTool(s.tiles, s.gridSize, s.tool, x, y, { funds: s.treasury, population: s.stats.population, month: s.month });
    if (!res.ok) return res.reason || null;
    const i = y * s.gridSize + x;
    const cell = { i, before: s.tiles[i], after: res.tiles[i] };
    set({ tiles: res.tiles, treasury: s.treasury - res.cost, stats: quickStats(s.stats, res.tiles) });
    if (pending) {
      pending.cells.push(cell);
      pending.cost += res.cost;
    } else if (recordUndo) pushUndo({ cells: [cell], cost: res.cost });
    if (!quiet) {
      haptic('select');
      playSfx(s.tool === 'bulldoze' ? 'bulldoze' : 'build');
    }
    return null;
  };

  /**
   * Annuler / rétablir par différences : seules les tuiles posées par l'action sont
   * remises dans leur état précédent (si elles n'ont pas changé entre-temps). La
   * croissance de la ville et les mois écoulés ne sont jamais effacés.
   */
  const replay = (action: UndoAction, direction: 'undo' | 'redo'): number => {
    const s = get();
    const tiles = s.tiles.slice();
    let applied = 0;
    const cells = direction === 'undo' ? [...action.cells].reverse() : action.cells;
    for (const c of cells) {
      const from = direction === 'undo' ? c.after : c.before;
      const to = direction === 'undo' ? c.before : c.after;
      const cur = tiles[c.i];
      if (cur.type !== from.type || cur.lake !== from.lake) continue;
      tiles[c.i] = { ...to, fire: 0, flood: 0, garbage: 0, rad: cur.rad };
      applied++;
    }
    if (!applied) return 0;
    const next = applyPower(tiles, s.gridSize, s.month);
    const share = applied / cells.length;
    const money = Math.round(action.cost * share);
    set({ tiles: next, treasury: s.treasury + (direction === 'undo' ? money : -money), stats: quickStats(s.stats, next) });
    return applied;
  };

  const persistSettings = () => saveSettings(get().settings).catch(() => {});

  return {
    hydrated: false,
    ...freshCity(createEmptyMap(50), 50, START_FUNDS, 'Ma ville'),
    disasters: false,
    speed: 1,
    paused: false,
    rotation: 0,
    dataView: 'none',
    settings: DEFAULT_SETTINGS,
    agentScale: 1,
    tool: 'inspect',
    toast: null,
    menuTab: null,
    challengesOpen: false,
    confirm: null,

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
        haptic('warn');
      }
    },

    paintStart: (x, y) => {
      const s = get();
      if (s.tool === 'inspect') return;
      const mode = dragModeOf(s.tool);
      if (mode) {
        // Zonage en rectangle / route droite : rien n'est posé avant de lever le doigt.
        set({ drag: { ax: x, ay: y, bx: x, by: y, mode } });
        return;
      }
      // Tout le glissé ne forme qu'une seule action à annuler.
      pending = { cells: [], cost: 0 };
      const reason = buildAt(x, y, false);
      if (reason) get().showToast(reason);
      set({ stroke: { x, y, warned: !!reason } });
    },

    paintMove: (x, y) => {
      const { stroke, drag } = get();
      if (drag) {
        if (drag.bx !== x || drag.by !== y) set({ drag: { ...drag, bx: x, by: y } });
        return;
      }
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
      if (s.drag) {
        const cells = dragTiles(s.drag).filter(([x, y]) => x >= 0 && y >= 0 && x < s.gridSize && y < s.gridSize);
        set({ drag: null });
        pending = { cells: [], cost: 0 };
        let placed = 0;
        let broke = false;
        let firstReason: string | null = null;
        for (const [x, y] of cells) {
          const t = get().tiles[y * s.gridSize + x];
          // Zonage : on saute en silence ce qui n'est pas constructible (routes, bâtiments…).
          if (s.tool !== 'bulldoze' && isZone(TOOL_BY_ID[s.tool].places ?? 'GRASS') && !isBuildableGround(t.type) && t.type !== 'FOREST') continue;
          const reason = buildAt(x, y, false, true);
          if (!reason) placed++;
          else if (reason.startsWith('Fonds')) {
            broke = true;
            break;
          } else firstReason ??= reason;
        }
        const action = pending;
        pending = null;
        pushUndo(action);
        if (placed > 0) {
          haptic('select');
          playSfx(s.tool === 'bulldoze' ? 'bulldoze' : 'build');
        }
        if (broke) get().showToast(`Fonds insuffisants 💸 — ${placed} tuile(s) posée(s)`);
        else if (!placed && firstReason) get().showToast(firstReason);
        return;
      }
      if (pending) {
        const action = pending;
        pending = null;
        pushUndo(action);
      }
      set({ stroke: null });
    },

    undo: () => {
      const s = get();
      const action = s.past[s.past.length - 1];
      if (!action) return;
      const applied = replay(action, 'undo');
      set({ past: get().past.slice(0, -1), future: applied ? [...get().future, action] : get().future });
      get().showToast(applied ? '↶ Action annulée (remboursée)' : '↶ Impossible : la ville a changé depuis');
      playSfx('click');
    },

    redo: () => {
      const s = get();
      const action = s.future[s.future.length - 1];
      if (!action) return;
      if (s.treasury < action.cost) {
        get().showToast('Fonds insuffisants 💸');
        return;
      }
      const applied = replay(action, 'redo');
      set({ future: get().future.slice(0, -1), past: applied ? [...get().past, action] : get().past });
      get().showToast(applied ? '↷ Action rétablie' : '↷ Impossible : la ville a changé depuis');
      playSfx('click');
    },

    tick: () => {
      const s = get();
      if (s.paused || !s.hydrated) return;
      const month = s.month + 1;
      const policy = s.policy();
      const res = simulateMonth({
        tiles: s.tiles,
        size: s.gridSize,
        treasury: s.treasury,
        policy,
        demand: s.demand,
        disasters: s.disasters,
        trigger: s.pendingDisaster,
        month,
        forcedEvents: s.forcedEvents,
      });

      // Événements du mois : on prévient le joueur comme dans SimCity.
      const disaster = res.events.disasters[0];
      if (disaster) {
        const L = DISASTER_LABELS[disaster.kind];
        get().showToast(`${L.icon} ${L.label} ! ${disaster.damage} tuile(s) touchée(s)`);
        playSfx('alarm');
        haptic('error');
        // La caméra file vers la catastrophe.
        focusTile(disaster.x, disaster.y);
      } else if (res.events.newFires > 0) {
        get().showToast(res.stats.coverage.fire > 0 ? '🔥 Incendie ! Les pompiers interviennent' : '🔥 Incendie ! Construisez une caserne 🚒');
        playSfx('siren');
        haptic('error');
      } else if (res.events.destroyed > 0) {
        get().showToast(`💥 ${res.events.destroyed} bâtiment(s) détruit(s) par le feu`);
      } else if (res.cityEvents.length > 0) {
        const e = res.cityEvents[0];
        get().showToast(`${EVENT_LABELS[e.kind].icon} ${EVENT_LABELS[e.kind].label}${res.cityEvents.length > 1 ? ` (+${res.cityEvents.length - 1})` : ''}`);
      }

      // Compteurs cumulés (pour les défis).
      const c = { ...s.counters };
      c.extinguished += res.events.extinguished;
      c.disasters += res.events.disasters.length;
      c.rebuilt += res.events.rebuilt;
      c.events += res.cityEvents.length;
      for (const e of res.cityEvents) c[e.kind] += 1;
      if (seasonOf(month) === 'winter' && s.funding.transport >= 80 && res.stats.population >= 1000) c.winterOk += 1;
      const net = res.income - res.expenses;
      c.surplusStreak = net > 0 ? c.surplusStreak + 1 : 0;

      // Défis réussis : récompense, fanfare et annonce.
      let treasury = res.treasury;
      const done = { ...s.challenges };
      // La ville de démo est déjà construite : ses défis ne comptent pas.
      const won = s.isDemo ? [] : newlyCompleted(challengeContext(res.tiles, res.stats, treasury, month, c, policy), done);
      const news = res.events.news.map((n) => ({ ...n, month }));
      // Événement organisé mais impossible (lieu hors service ou rasé) : remboursé.
      const cancelled = s.forcedEvents.filter((f) => !res.cityEvents.some((e) => e.x === f.x && e.y === f.y));
      if (cancelled.length) {
        treasury += cancelled.length * EVENT_COST;
        news.push({ icon: '↩️', text: `Événement annulé (lieu hors service) : ${cancelled.length * EVENT_COST} $ remboursés.`, month });
      }
      for (const w of won) {
        done[w.id] = month;
        treasury += w.reward;
        news.push({ icon: '🏆', text: `Défi réussi : ${w.title} (+${w.reward} $)`, month });
      }
      if (won.length) {
        get().showToast(`🏆 Défi réussi : ${won[0].title} (+${won[0].reward} $)`);
        playSfx('fanfare');
        haptic('success');
      }

      // Journal : une plainte de temps en temps.
      const complaint = month % 6 === 0 ? topComplaint(res.stats, s.taxes) : null;
      if (complaint) news.push({ ...complaint, month });
      if (treasury < 0 && s.treasury >= 0) news.push({ icon: '📉', text: 'La ville est dans le rouge !', month });
      if (!won.length && news.some((n) => n.icon === '🎉' || n.icon === '🏛️')) playSfx('fanfare');

      set({
        tiles: res.tiles,
        treasury,
        demand: res.demand,
        stats: res.stats,
        maps: res.maps,
        analysis: res.analysis,
        // Les conseillers coûtent cher à calculer : tous les 3 mois, ou en continu si leur onglet est ouvert.
        advice: month % 3 === 0 || s.menuTab === 'advisors' || disaster ? adviceFor(res.tiles, s.gridSize, res.analysis, policy, treasury, net, month) : s.advice,
        lastIncome: res.income,
        lastExpenses: res.expenses,
        month,
        weather: res.weather,
        cityEvents: res.cityEvents,
        forcedEvents: [],
        counters: c,
        challenges: done,
        pendingDisaster: null,
        lastDisaster: disaster ? { event: disaster, at: Date.now() } : s.lastDisaster,
        news: news.length ? [...news.reverse(), ...s.news].slice(0, 60) : s.news,
        history: {
          pop: pushCapped(s.history.pop, res.stats.population),
          money: pushCapped(s.history.money, Math.round(treasury)),
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

    organizeEvent: (x, y) => {
      const s = get();
      if (s.forcedEvents.some((f) => f.x === x && f.y === y)) return;
      if (s.treasury < EVENT_COST) {
        get().showToast('Fonds insuffisants 💸');
        return;
      }
      set({ treasury: s.treasury - EVENT_COST, forcedEvents: [...s.forcedEvents, { x, y }] });
      get().showToast('🎉 Événement programmé pour le mois prochain');
      playSfx('click');
    },

    focusOn: (x, y, view) => {
      focusTile(x, y, 1.1);
      set({ menuTab: null, ...(view ? { dataView: view } : {}) });
    },
    openMenu: (tab) => {
      const s = get();
      if (tab === 'advisors' && s.analysis) {
        set({ menuTab: tab, advice: adviceFor(s.tiles, s.gridSize, s.analysis, s.policy(), s.treasury, s.lastIncome - s.lastExpenses, s.month) });
      } else set({ menuTab: tab });
    },
    openChallenges: (open) => set({ challengesOpen: open }),
    askConfirm: (title, message, label, onConfirm) => set({ confirm: { title, message, label, onConfirm } }),
    closeConfirm: () => set({ confirm: null }),
    setCityName: (name) => set({ cityName: name.slice(0, 24) || 'Ma ville' }),

    newCity: (size = GRID_SIZE) =>
      set({ ...freshCity(createTerrainMap(size), size, START_FUNDS), paused: false, rotation: 0, dataView: 'none', disasters: get().disasters }),
    loadDemoCity: () => set({ ...freshCity(createDemoMap(50), 50, 50000, 'Démoville', true), paused: false, rotation: 0, dataView: 'none' }),

    hydrate: (save) => {
      if (!save) {
        // Première partie : une carte naturelle neuve.
        set({ ...freshCity(createTerrainMap(GRID_SIZE), GRID_SIZE, START_FUNDS), hydrated: true });
        return;
      }
      const tiles = applyPower(save.tiles, save.gridSize, save.month);
      const policy = { taxes: save.taxes, funding: save.funding, ordinances: save.ordinances };
      const a = analyzeCity(tiles, save.gridSize, policy, save.month);
      set({
        hydrated: true,
        gridSize: save.gridSize,
        tiles,
        treasury: save.treasury,
        month: save.month,
        cityName: save.cityName,
        isDemo: save.isDemo,
        taxes: save.taxes,
        funding: save.funding,
        ordinances: save.ordinances,
        disasters: save.disasters,
        demand: save.demand,
        speed: save.speed,
        history: save.history,
        news: save.news,
        rotation: save.rotation,
        counters: save.counters,
        challenges: save.challenges,
        stats: a.stats,
        maps: a.maps,
        analysis: a,
        advice: adviceFor(tiles, save.gridSize, a, policy, save.treasury, 0, save.month),
        cityEvents: save.cityEvents,
        forcedEvents: save.forcedEvents,
        weather: save.weather,
        selected: null,
        citizen: null,
        drag: null,
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
        cityName: s.cityName,
        counters: s.counters,
        challenges: s.challenges,
        isDemo: s.isDemo,
        weather: s.weather,
        cityEvents: s.cityEvents,
        forcedEvents: s.forcedEvents,
      };
    },
  };
});

export { dragModeOf, dragTiles, toolCost, type Drag };
