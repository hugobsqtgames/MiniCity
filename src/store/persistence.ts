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
import { EMPTY_COUNTERS, type Counters } from '../sim/challenges';
import { districtMap } from '../sim/districts';
import { MISSIONS, type Mission } from '../sim/missions';
import { EMPTY_RECORDS, sanitizeRecords, type CityRecords } from '../sim/records';
import type { CityEvent, Demand, Epidemic, Weather } from '../sim/simulation';

/** Stockage 100 % local (AsyncStorage) — aucune donnée ne quitte le téléphone. */
/** Ancienne sauvegarde unique (migrée vers l'emplacement 1). */
const LEGACY_SAVE_KEY = 'minicity/save/v1';
const SETTINGS_KEY = 'minicity/settings/v1';
const SLOTS_KEY = 'minicity/slots/v1';
export const SLOT_COUNT = 3;
const slotKey = (slot: number) => `minicity/save/slot${slot}`;

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
  cityName: string;
  counters: Counters;
  /** Défis réussis : identifiant -> mois de réussite. */
  challenges: Record<string, number>;
  isDemo: boolean;
  weather: Weather;
  cityEvents: CityEvent[];
  /** Événements payés par le maire, pas encore tenus. */
  forcedEvents: { x: number; y: number }[];
  /** Catastrophes « fun » (météorite, monstre). */
  funDisasters: boolean;
  epidemic: Epidemic | null;
  missions: Mission[];
  missionSeq: number;
  records: CityRecords;
  timelapse: TimelapseFrame[];
};

/** Image du timelapse : aperçu de la carte (au plus 50×50) à une date donnée. */
export type TimelapseFrame = { month: number; population: number; size: number; map: string; dens: string };
export const TIMELAPSE_MAX = 80;

/** Format compact : une chaîne de caractères par attribut de tuile. */
type SaveFile = {
  v: 1 | 2 | 3;
  savedAt: number;
  gridSize: number;
  types: string;
  density: string;
  fire?: string;
  lake?: string;
  garbage?: string;
  flood?: string;
  rad?: string;
  /** Parcelles sinistrées à reconstruire en priorité. */
  ruin?: string;
  /** Valeur foncière (2 chiffres par tuile). */
  val?: string;
  elev?: string;
  line?: string;
  spec?: string;
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
  cityName?: string;
  counters?: Counters;
  challenges?: Record<string, number>;
  isDemo?: boolean;
  weather?: Weather;
  cityEvents?: CityEvent[];
  forcedEvents?: { x: number; y: number }[];
  funDisasters?: boolean;
  epidemic?: Epidemic | null;
  missions?: Mission[];
  missionSeq?: number;
  records?: CityRecords;
  timelapse?: TimelapseFrame[];
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
  ARENA: '5',
  FAIR: '6',
  MARKET: '7',
  WIND: 'w',
  SOLAR: 'o',
  NUCLEAR: 'n',
  PORT: 't',
  FREIGHT: 'x',
  HIGHSCHOOL: 'j',
  PARKING: 'q',
  TREATMENT: 'u',
  STATION: 'v',
  RAIL: 'z',
  HOTEL: 'b',
  RESORT: 'e',
};
const CHAR_TO_TYPE = Object.fromEntries(Object.entries(TYPE_TO_CHAR).map(([k, v]) => [v, k])) as Record<string, TileType>;

const digits = (tiles: Tile[], get: (t: Tile) => number) => tiles.map((t) => String(Math.max(0, Math.min(9, get(t))))).join('');

export function serialize(game: SavedGame): string {
  const file: SaveFile = {
    v: 3,
    savedAt: Date.now(),
    gridSize: game.gridSize,
    types: game.tiles.map((t) => TYPE_TO_CHAR[t.type]).join(''),
    density: digits(game.tiles, (t) => t.density),
    fire: digits(game.tiles, (t) => t.fire),
    lake: digits(game.tiles, (t) => (t.lake ? 1 : 0)),
    garbage: digits(game.tiles, (t) => t.garbage),
    flood: digits(game.tiles, (t) => t.flood),
    rad: digits(game.tiles, (t) => t.rad),
    ruin: digits(game.tiles, (t) => (t.value < 0 ? 1 : 0)),
    val: game.tiles.map((t) => String(Math.max(0, Math.min(99, Math.round(t.value) || 0))).padStart(2, '0')).join(''),
    elev: digits(game.tiles, (t) => t.elev),
    line: digits(game.tiles, (t) => t.line),
    spec: digits(game.tiles, (t) => t.spec),
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
    cityName: game.cityName,
    counters: game.counters,
    challenges: game.challenges,
    isDemo: game.isDemo,
    weather: game.weather,
    cityEvents: game.cityEvents,
    forcedEvents: game.forcedEvents,
    funDisasters: game.funDisasters,
    epidemic: game.epidemic,
    missions: game.missions,
    missionSeq: game.missionSeq,
    records: game.records,
    timelapse: game.timelapse.slice(-TIMELAPSE_MAX),
  };
  return JSON.stringify(file);
}

export function deserialize(json: string): SavedGame | null {
  try {
    const f = JSON.parse(json) as SaveFile;
    const n = f.gridSize * f.gridSize;
    if ((f.v !== 1 && f.v !== 2 && f.v !== 3) || !Number.isInteger(f.gridSize) || f.gridSize < 1 || f.gridSize > 200) return null;
    if (typeof f.types !== 'string' || typeof f.density !== 'string' || f.types.length !== n || f.density.length !== n) return null;
    const fin = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const districts = districtMap(f.gridSize).list.length;
    const tiles = createEmptyMap(f.gridSize);
    const num = (s: string | undefined, i: number) => (s ? Number(s[i]) || 0 : 0);
    for (let i = 0; i < n; i++) {
      tiles[i].type = CHAR_TO_TYPE[f.types[i]] ?? 'GRASS';
      tiles[i].density = Math.min(3, num(f.density, i));
      tiles[i].fire = num(f.fire, i);
      tiles[i].lake = num(f.lake, i) === 1;
      tiles[i].garbage = num(f.garbage, i);
      tiles[i].flood = num(f.flood, i);
      tiles[i].rad = num(f.rad, i);
      if (f.val && f.val.length === n * 2) tiles[i].value = Number(f.val.slice(i * 2, i * 2 + 2)) || 0;
      if (num(f.ruin, i) === 1) tiles[i].value = -1;
      tiles[i].elev = Math.min(3, num(f.elev, i));
      tiles[i].line = num(f.line, i) & 3;
      tiles[i].spec = Math.min(3, num(f.spec, i));
    }
    const legacyTax = f.taxRate ?? DEFAULT_TAXES.R;
    return {
      gridSize: f.gridSize,
      tiles,
      treasury: fin(f.treasury, 0),
      month: Math.max(0, Math.floor(fin(f.month, 0))),
      taxes: { ...DEFAULT_TAXES, ...(f.taxes ?? { R: legacyTax, C: legacyTax, I: legacyTax }) },
      funding: { ...DEFAULT_FUNDING, ...f.funding },
      ordinances: { ...DEFAULT_ORDINANCES, ...f.ordinances },
      disasters: f.disasters ?? false,
      demand: { r: fin(f.demand?.r, 0), c: fin(f.demand?.c, 0), i: fin(f.demand?.i, 0) },
      speed: f.speed === 1 || f.speed === 2 || f.speed === 3 ? f.speed : 1,
      history: Object.fromEntries(
        (Object.keys(EMPTY_HISTORY) as (keyof History)[]).map((k) => [k, Array.isArray(f.history?.[k]) ? f.history![k].filter((v) => Number.isFinite(v)) : []]),
      ) as History,
      news: Array.isArray(f.news) ? f.news.filter((e) => e && typeof e.text === 'string') : [],
      rotation: f.rotation === 1 || f.rotation === 2 || f.rotation === 3 ? f.rotation : 0,
      cityName: typeof f.cityName === 'string' && f.cityName ? f.cityName.slice(0, 24) : 'Ma ville',
      counters: Object.fromEntries(Object.entries(EMPTY_COUNTERS).map(([k, d]) => [k, fin((f.counters as Record<string, unknown> | undefined)?.[k], d)])) as Counters,
      challenges: f.challenges && typeof f.challenges === 'object' ? Object.fromEntries(Object.entries(f.challenges).filter(([, v]) => Number.isFinite(v))) : {},
      isDemo: f.isDemo ?? false,
      weather: f.weather ?? 'clear',
      cityEvents: Array.isArray(f.cityEvents) ? f.cityEvents : [],
      forcedEvents: Array.isArray(f.forcedEvents) ? f.forcedEvents : [],
      funDisasters: f.funDisasters ?? false,
      epidemic: validEpidemic(f.epidemic, districts),
      missions: Array.isArray(f.missions)
        ? f.missions.filter((m) => m && MISSIONS[m.kind] !== undefined && Number.isFinite(m.deadline) && Number.isInteger(m.district) && m.district >= 0 && m.district < districts)
        : [],
      missionSeq: Number.isFinite(f.missionSeq) ? f.missionSeq! : 0,
      records: f.records ? sanitizeRecords(f.records) : EMPTY_RECORDS,
      timelapse: Array.isArray(f.timelapse)
        ? f.timelapse.filter((fr) => fr && typeof fr.map === 'string' && typeof fr.dens === 'string' && fr.map.length === fr.size * fr.size && fr.dens.length === fr.map.length).slice(-TIMELAPSE_MAX)
        : [],
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Emplacements de sauvegarde (3), avec un aperçu léger de chaque ville
// ---------------------------------------------------------------------------

export type SlotMeta = {
  slot: number;
  savedAt: number;
  cityName: string;
  population: number;
  month: number;
  treasury: number;
  gridSize: number;
  /** Aperçu : un caractère de type par tuile, sous-échantillonné (au plus 50×50). */
  preview: string;
  previewSize: number;
};

/** Aperçu sous-échantillonné de la carte (un caractère par tuile). */
export function makePreview(tiles: Tile[], gridSize: number): { preview: string; previewSize: number } {
  const step = Math.max(1, Math.ceil(gridSize / 50));
  const ps = Math.ceil(gridSize / step);
  let out = '';
  for (let y = 0; y < ps; y++) {
    for (let x = 0; x < ps; x++) {
      const t = tiles[Math.min(gridSize - 1, y * step) * gridSize + Math.min(gridSize - 1, x * step)];
      out += TYPE_TO_CHAR[t.type];
    }
  }
  return { preview: out, previewSize: ps };
}

export const previewType = (c: string): TileType => CHAR_TO_TYPE[c] ?? 'GRASS';

/** Image de timelapse : types et densités sous-échantillonnés. */
export function makeFrame(tiles: Tile[], gridSize: number, month: number, population: number): TimelapseFrame {
  const { preview, previewSize } = makePreview(tiles, gridSize);
  const step = Math.max(1, Math.ceil(gridSize / 50));
  let dens = '';
  for (let y = 0; y < previewSize; y++) {
    for (let x = 0; x < previewSize; x++) dens += String(tiles[Math.min(gridSize - 1, y * step) * gridSize + Math.min(gridSize - 1, x * step)].density);
  }
  return { month, population, size: previewSize, map: preview, dens };
}

function validEpidemic(e: unknown, districts: number): Epidemic | null {
  if (!e || typeof e !== 'object') return null;
  const { district, severity, months } = e as Epidemic;
  if (![district, severity, months].every(Number.isFinite) || severity <= 0 || !Number.isInteger(district) || district < 0 || district >= districts) return null;
  return { district, severity: Math.min(100, severity), months };
}

async function readSlots(): Promise<SlotMeta[]> {
  try {
    const json = await AsyncStorage.getItem(SLOTS_KEY);
    return json ? (JSON.parse(json) as SlotMeta[]) : [];
  } catch {
    return [];
  }
}

export async function listSlots(): Promise<(SlotMeta | null)[]> {
  const metas = await readSlots();
  return Array.from({ length: SLOT_COUNT }, (_, i) => metas.find((m) => m.slot === i + 1) ?? null);
}

export async function saveGame(game: SavedGame, slot = 1): Promise<void> {
  await AsyncStorage.setItem(slotKey(slot), serialize(game));
  const metas = (await readSlots()).filter((m) => m.slot !== slot);
  const population = game.history.pop[game.history.pop.length - 1] ?? 0;
  metas.push({
    slot,
    savedAt: Date.now(),
    cityName: game.cityName,
    population,
    month: game.month,
    treasury: Math.round(game.treasury),
    gridSize: game.gridSize,
    ...makePreview(game.tiles, game.gridSize),
  });
  await AsyncStorage.setItem(SLOTS_KEY, JSON.stringify(metas));
}

export async function loadGame(slot = 1): Promise<SavedGame | null> {
  let json = await AsyncStorage.getItem(slotKey(slot));
  // Migration : l'ancienne sauvegarde unique devient l'emplacement 1.
  if (!json && slot === 1) {
    json = await AsyncStorage.getItem(LEGACY_SAVE_KEY);
    const legacy = json ? deserialize(json) : null;
    if (legacy) {
      await saveGame(legacy, 1);
      await AsyncStorage.removeItem(LEGACY_SAVE_KEY);
    }
    return legacy;
  }
  return json ? deserialize(json) : null;
}

export async function deleteSlot(slot: number): Promise<void> {
  await AsyncStorage.removeItem(slotKey(slot));
  const metas = (await readSlots()).filter((m) => m.slot !== slot);
  await AsyncStorage.setItem(SLOTS_KEY, JSON.stringify(metas));
}

export async function clearSave(): Promise<void> {
  for (let s = 1; s <= SLOT_COUNT; s++) await AsyncStorage.removeItem(slotKey(s));
  await AsyncStorage.removeItem(SLOTS_KEY);
  await AsyncStorage.removeItem(LEGACY_SAVE_KEY);
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
  /** Météo animée (pluie, neige, brouillard, nuages). */
  weather: boolean;
  /** Emplacement de sauvegarde en cours (1 à 3). */
  slot: number;
  /** Accessibilité : taille du texte, palette daltonienne, vibrations. */
  textScale: number;
  colorblind: boolean;
  haptics: boolean;
  /** Mini-carte affichée. */
  minimap: boolean;
  /** Ambiance sonore (ville, oiseaux, pluie…). */
  ambience: boolean;
};
export const DEFAULT_SETTINGS: Settings = {
  music: true,
  sounds: true,
  quality: 'auto',
  showAgents: true,
  dayNight: true,
  tutorial: 0,
  weather: true,
  slot: 1,
  textScale: 1,
  colorblind: false,
  haptics: true,
  minimap: true,
  ambience: true,
};

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
