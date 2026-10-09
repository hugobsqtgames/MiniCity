import type { TileType } from '../engine/map';

/** 1 tick = 1 mois de jeu = 2 secondes réelles (vitesse 1×). */
export const TICK_MS = 2000;
export const SPEEDS = [1, 2, 3] as const;
export type Speed = (typeof SPEEDS)[number];

export const START_FUNDS = 20000;
export const START_YEAR = 2024;
export const DEFAULT_TAX = 9;
export const MIN_TAX = 0;
export const MAX_TAX = 20;
/** Recette mensuelle = population × (taux / 100) × INCOME_PER_CITIZEN. */
export const INCOME_PER_CITIZEN = 10;

/** Portée maximale du réseau électrique depuis une centrale (en tuiles). */
export const POWER_RANGE = 15;
/** Distance maximale (Manhattan) entre une zone et une route. */
export const ROAD_ACCESS_RANGE = 3;

/** Habitants / emplois par niveau de densité (0 à 3). */
export const RESIDENTS = [0, 12, 45, 140];
export const JOBS_C = [0, 10, 30, 80];
export const JOBS_I = [0, 20, 45, 90];

/** Entretien mensuel. */
export const UPKEEP = { ROAD: 1, POWER: 120 } as const;

export type ToolId = 'inspect' | 'road' | 'zoneR' | 'zoneC' | 'zoneI' | 'power' | 'bulldoze';

export type ToolDef = {
  id: ToolId;
  label: string;
  icon: string;
  cost: number;
  color: string;
  /** Type de tuile posé (null pour inspecter / bulldozer). */
  places: TileType | null;
};

export const TOOLS: ToolDef[] = [
  { id: 'inspect', label: 'Explorer', icon: '🔍', cost: 0, color: '#ecf0f1', places: null },
  { id: 'road', label: 'Route', icon: '🛣️', cost: 10, color: '#95a5a6', places: 'ROAD' },
  { id: 'zoneR', label: 'Résidentiel', icon: '🏠', cost: 20, color: '#2ecc71', places: 'R' },
  { id: 'zoneC', label: 'Commerce', icon: '🏬', cost: 20, color: '#3498db', places: 'C' },
  { id: 'zoneI', label: 'Industrie', icon: '🏭', cost: 20, color: '#f1c40f', places: 'I' },
  { id: 'power', label: 'Centrale', icon: '⚡', cost: 3000, color: '#34495e', places: 'POWER' },
  { id: 'bulldoze', label: 'Bulldozer', icon: '🚜', cost: 1, color: '#e67e22', places: null },
];

export const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t])) as Record<ToolId, ToolDef>;

export const MONTHS = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
