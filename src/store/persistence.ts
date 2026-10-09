import AsyncStorage from '@react-native-async-storage/async-storage';

import { createEmptyMap, type Tile, type TileType } from '../engine/map';
import type { Speed } from '../sim/constants';
import type { Demand } from '../sim/simulation';

/** Stockage 100 % local (AsyncStorage) — aucune donnée ne quitte le téléphone. */
const SAVE_KEY = 'minicity/save/v1';

export type SavedGame = {
  gridSize: number;
  tiles: Tile[];
  treasury: number;
  month: number;
  taxRate: number;
  demand: Demand;
  speed: Speed;
};

/** Format compact : 2 500 tuiles tiennent dans deux chaînes de 2 500 caractères. */
type SaveFileV1 = {
  v: 1;
  savedAt: number;
  gridSize: number;
  types: string;
  density: string;
  /** Mois d'incendie par tuile (absent dans les anciennes sauvegardes). */
  fire?: string;
  treasury: number;
  month: number;
  taxRate: number;
  demand: Demand;
  speed: Speed;
};

const TYPE_TO_CHAR: Record<TileType, string> = {
  GRASS: 'g',
  DIRT: 'd',
  ROAD: '=',
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
};
const CHAR_TO_TYPE = Object.fromEntries(Object.entries(TYPE_TO_CHAR).map(([k, v]) => [v, k])) as Record<string, TileType>;

export function serialize(game: SavedGame): string {
  const file: SaveFileV1 = {
    v: 1,
    savedAt: Date.now(),
    gridSize: game.gridSize,
    types: game.tiles.map((t) => TYPE_TO_CHAR[t.type]).join(''),
    density: game.tiles.map((t) => String(t.density)).join(''),
    fire: game.tiles.map((t) => String(Math.min(9, t.fire))).join(''),
    treasury: game.treasury,
    month: game.month,
    taxRate: game.taxRate,
    demand: game.demand,
    speed: game.speed,
  };
  return JSON.stringify(file);
}

export function deserialize(json: string): SavedGame | null {
  try {
    const f = JSON.parse(json) as SaveFileV1;
    const n = f.gridSize * f.gridSize;
    if (f.v !== 1 || f.types.length !== n || f.density.length !== n) return null;
    const tiles = createEmptyMap(f.gridSize);
    for (let i = 0; i < n; i++) {
      tiles[i].type = CHAR_TO_TYPE[f.types[i]] ?? 'GRASS';
      tiles[i].density = Math.min(3, Math.max(0, Number(f.density[i]) || 0));
      tiles[i].fire = f.fire ? Number(f.fire[i]) || 0 : 0;
    }
    return {
      gridSize: f.gridSize,
      tiles,
      treasury: f.treasury,
      month: f.month,
      taxRate: f.taxRate,
      demand: f.demand,
      speed: f.speed,
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
