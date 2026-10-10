import AsyncStorage from '@react-native-async-storage/async-storage';

import { createEmptyMap, type Tile, type TileType } from '../engine/map';
import {
  DEFAULT_FUNDING,
  DEFAULT_ORDINANCES,
  DEFAULT_TAXES,
  type Funding,
  type Ordinances,
  type Speed,
  type Taxes,
} from '../sim/constants';
import type { Demand } from '../sim/simulation';

/** Stockage 100 % local (AsyncStorage) — aucune donnée ne quitte le téléphone. */
const SAVE_KEY = 'minicity/save/v1';
const SETTINGS_KEY = 'minicity/settings/v1';

export type History = { pop: number[]; money: number[]; happy: number[]; crime: number[]; pollution: number[] };
export const EMPTY_HISTORY: History = { pop: [], money: [], happy: [], crime: [], pollution: [] };
export type NewsEntry = { month: number; icon: string; text: string };

export type SavedGame = {
  gridSize: number;
  tiles: Tile[];
  treasury: number;
  month: number;
  taxes: Taxes;
  funding: Funding;
  ordinances: Ordinances;
  disasters: boolean;
  demand: Demand;
  speed: Speed;
  history: History;
  news: NewsEntry[];
  rotation: number;
};

/** Format compact : une chaîne de caractères par attribut de tuile. */
type SaveFile = {
  v: 1 | 2;
  savedAt: number;
  gridSize: number;
  types: string;
  density: string;
  fire?: string;
  lake?: string;
  garbage?: string;
  flood?: string;
  treasury: number;
  month: number;
  /** v1 : taux unique. */
  taxRate?: number;
  taxes?: Taxes;
  funding?: Funding;
  ordinances?: Ordinances;
  disasters?: boolean;
  demand: Demand;
  speed: Speed;
  history?: History;
  news?: NewsEntry[];
  rotation?: number;
};

const TYPE_TO_CHAR: Record<TileType, string> = {
  GRASS: 'g',
  DIRT: 'd',
  LAKE: '~',
  SAND: 's',
  FOREST: 'f',
  ROAD: '=',
  AVENUE: '#',
  HIGHWAY: 'h',
  R: 'r',
  C: 'c',
  I: 'i',
  POWER: 'p',
  POLICE: 'P',
  FIRE: 'F',
  HOSPITAL: 'H',
  SCHOOL: 'S',
  WATER: 'W',
  METRO: 'M',
  PARK: 'k',
  LANDFILL: 'L',
  INCINERATOR: 'N',
  RECYCLING: 'Y',
  BUSSTOP: 'B',
  STADIUM: '1',
  UNIVERSITY: '2',
  AIRPORT: '3',
  LANDMARK: '4',
};
const CHAR_TO_TYPE = Object.fromEntries(Object.entries(TYPE_TO_CHAR).map(([k, v]) => [v, k])) as Record<string, TileType>;

const digits = (tiles: Tile[], get: (t: Tile) => number) => tiles.map((t) => String(Math.max(0, Math.min(9, get(t))))).join('');

export function serialize(game: SavedGame): string {
  const file: SaveFile = {
    v: 2,
    savedAt: Date.now(),
    gridSize: game.gridSize,
    types: game.tiles.map((t) => TYPE_TO_CHAR[t.type]).join(''),
    density: digits(game.tiles, (t) => t.density),
    fire: digits(game.tiles, (t) => t.fire),
    lake: digits(game.tiles, (t) => (t.lake ? 1 : 0)),
    garbage: digits(game.tiles, (t) => t.garbage),
    flood: digits(game.tiles, (t) => t.flood),
    treasury: game.treasury,
    month: game.month,
    taxes: game.taxes,
    funding: game.funding,
    ordinances: game.ordinances,
    disasters: game.disasters,
    demand: game.demand,
    speed: game.speed,
    // Historique : les 20 dernières années suffisent.
    history: Object.fromEntries(Object.entries(game.history).map(([k, v]) => [k, v.slice(-240)])) as History,
    news: game.news.slice(0, 40),
    rotation: game.rotation,
  };
  return JSON.stringify(file);
}

export function deserialize(json: string): SavedGame | null {
  try {
    const f = JSON.parse(json) as SaveFile;
    const n = f.gridSize * f.gridSize;
    if ((f.v !== 1 && f.v !== 2) || f.types.length !== n || f.density.length !== n) return null;
    const tiles = createEmptyMap(f.gridSize);
    const num = (s: string | undefined, i: number) => (s ? Number(s[i]) || 0 : 0);
    for (let i = 0; i < n; i++) {
      tiles[i].type = CHAR_TO_TYPE[f.types[i]] ?? 'GRASS';
      tiles[i].density = Math.min(3, num(f.density, i));
      tiles[i].fire = num(f.fire, i);
      tiles[i].lake = num(f.lake, i) === 1;
      tiles[i].garbage = num(f.garbage, i);
      tiles[i].flood = num(f.flood, i);
    }
    const legacyTax = f.taxRate ?? DEFAULT_TAXES.R;
    return {
      gridSize: f.gridSize,
      tiles,
      treasury: f.treasury,
      month: f.month,
      taxes: { ...DEFAULT_TAXES, ...(f.taxes ?? { R: legacyTax, C: legacyTax, I: legacyTax }) },
      funding: { ...DEFAULT_FUNDING, ...f.funding },
      ordinances: { ...DEFAULT_ORDINANCES, ...f.ordinances },
      disasters: f.disasters ?? false,
      demand: f.demand,
      speed: f.speed,
      history: { ...EMPTY_HISTORY, ...f.history },
      news: f.news ?? [],
      rotation: f.rotation ?? 0,
    };
  } catch {
    return null;
  }
}

export async function saveGame(game: SavedGame): Promise<void> {
  await AsyncStorage.setItem(SAVE_KEY, serialize(game));
}

export async function loadGame(): Promise<SavedGame | null> {
  const json = await AsyncStorage.getItem(SAVE_KEY);
  return json ? deserialize(json) : null;
}

export async function clearSave(): Promise<void> {
  await AsyncStorage.removeItem(SAVE_KEY);
}

// ---------------------------------------------------------------------------
// Réglages (indépendants de la partie)
// ---------------------------------------------------------------------------

export type Quality = 'auto' | 'high' | 'medium' | 'low';
export type Settings = {
  music: boolean;
  sounds: boolean;
  quality: Quality;
  showAgents: boolean;
  /** Cycle jour / nuit. */
  dayNight: boolean;
  /** Étape du tutoriel (-1 = terminé ou passé). */
  tutorial: number;
};
export const DEFAULT_SETTINGS: Settings = { music: true, sounds: true, quality: 'auto', showAgents: true, dayNight: true, tutorial: 0 };

export async function loadSettings(): Promise<Settings> {
  try {
    const json = await AsyncStorage.getItem(SETTINGS_KEY);
    return json ? { ...DEFAULT_SETTINGS, ...(JSON.parse(json) as Partial<Settings>) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
