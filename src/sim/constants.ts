import type { ServiceType, TileType } from '../engine/map';

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
/** Portée des canalisations depuis un château d'eau (en tuiles). */
export const WATER_RANGE = 12;
/** Distance maximale (Manhattan) entre une zone et une route. */
export const ROAD_ACCESS_RANGE = 3;

/** Habitants / emplois par niveau de densité (0 à 3). */
export const RESIDENTS = [0, 12, 45, 140];
export const JOBS_C = [0, 10, 30, 80];
export const JOBS_I = [0, 20, 45, 90];
/** Part des habitants en âge de travailler. */
export const WORKFORCE_RATIO = 0.6;

/** Rayon d'action des services (en tuiles) — le rayonnement décroît avec la distance. */
export const SERVICE_RADIUS: Record<ServiceType, number> = {
  POLICE: 10,
  FIRE: 10,
  HOSPITAL: 12,
  SCHOOL: 9,
  WATER: 0, // l'eau passe par le réseau, pas par un rayon
  METRO: 6,
  PARK: 4,
};

/** Entretien mensuel. */
export const UPKEEP: Partial<Record<TileType, number>> = {
  ROAD: 1,
  POWER: 120,
  POLICE: 50,
  FIRE: 50,
  HOSPITAL: 80,
  SCHOOL: 60,
  WATER: 30,
  METRO: 40,
  PARK: 4,
};

export type ToolId =
  | 'inspect'
  | 'road'
  | 'zoneR'
  | 'zoneC'
  | 'zoneI'
  | 'power'
  | 'water'
  | 'police'
  | 'fire'
  | 'hospital'
  | 'school'
  | 'metro'
  | 'park'
  | 'bulldoze';

export type ToolGroup = 'base' | 'zones' | 'networks' | 'services';

export type ToolDef = {
  id: ToolId;
  label: string;
  icon: string;
  cost: number;
  color: string;
  group: ToolGroup;
  /** Type de tuile posé (null pour inspecter / bulldozer). */
  places: TileType | null;
};

export const TOOLS: ToolDef[] = [
  { id: 'inspect', label: 'Explorer', icon: '🔍', cost: 0, color: '#ecf0f1', group: 'base', places: null },
  { id: 'bulldoze', label: 'Bulldozer', icon: '🚜', cost: 1, color: '#e67e22', group: 'base', places: null },
  { id: 'road', label: 'Route', icon: '🛣️', cost: 10, color: '#95a5a6', group: 'zones', places: 'ROAD' },
  { id: 'zoneR', label: 'Résidentiel', icon: '🏠', cost: 20, color: '#2ecc71', group: 'zones', places: 'R' },
  { id: 'zoneC', label: 'Commerce', icon: '🏬', cost: 20, color: '#3498db', group: 'zones', places: 'C' },
  { id: 'zoneI', label: 'Industrie', icon: '🏭', cost: 20, color: '#f1c40f', group: 'zones', places: 'I' },
  { id: 'power', label: 'Centrale', icon: '⚡', cost: 3000, color: '#34495e', group: 'networks', places: 'POWER' },
  { id: 'water', label: "Château d'eau", icon: '💧', cost: 400, color: '#5dade2', group: 'networks', places: 'WATER' },
  { id: 'metro', label: 'Métro', icon: '🚇', cost: 700, color: '#16a085', group: 'networks', places: 'METRO' },
  { id: 'police', label: 'Police', icon: '🚓', cost: 500, color: '#2e4a8a', group: 'services', places: 'POLICE' },
  { id: 'fire', label: 'Pompiers', icon: '🚒', cost: 500, color: '#c0392b', group: 'services', places: 'FIRE' },
  { id: 'hospital', label: 'Hôpital', icon: '🏥', cost: 800, color: '#ecf0f1', group: 'services', places: 'HOSPITAL' },
  { id: 'school', label: 'École', icon: '🏫', cost: 600, color: '#e67e22', group: 'services', places: 'SCHOOL' },
  { id: 'park', label: 'Parc', icon: '🌳', cost: 50, color: '#27ae60', group: 'services', places: 'PARK' },
];

export const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t])) as Record<ToolId, ToolDef>;

/** Service dont l'outil affiche la carte de couverture quand il est sélectionné. */
export const COVERAGE_TOOL: Partial<Record<ToolId, ServiceType>> = {
  police: 'POLICE',
  fire: 'FIRE',
  hospital: 'HOSPITAL',
  school: 'SCHOOL',
  metro: 'METRO',
  park: 'PARK',
};

export const MONTHS = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
