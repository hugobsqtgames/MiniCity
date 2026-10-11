import type { LogisticsType, MonumentType, PlantType, ServiceType, TileType, VenueType, ZoneType } from '../engine/map';

/** 1 tick = 1 mois de jeu = 2 secondes réelles (vitesse 1×). */
export const TICK_MS = 2000;
export const SPEEDS = [1, 2, 3] as const;
export type Speed = (typeof SPEEDS)[number];

export const START_FUNDS = 20000;
export const START_YEAR = 2024;
export const DEFAULT_TAX = 9;
export const MIN_TAX = 0;
export const MAX_TAX = 20;
/** Recette mensuelle d'une zone = base × (taux / 100) × INCOME_PER_UNIT. */
export const INCOME_PER_CITIZEN = 10;
/** Recette par emploi (impôt sur les entreprises C et I). */
export const INCOME_PER_JOB = 6;

/** Tailles de carte proposées pour une nouvelle ville. */
export const MAP_SIZES = [50, 100] as const;
export const DEFAULT_MAP_SIZE = 100;

/** Portée maximale du réseau électrique depuis une centrale (en tuiles). */
export const POWER_RANGE = 15;
/** Portée des canalisations depuis un château d'eau (en tuiles) ; + bonus s'il pompe dans un lac. */
export const WATER_RANGE = 12;
export const WATER_LAKE_BONUS = 4;
/** Distance maximale (Manhattan) entre une zone et une route. */
export const ROAD_ACCESS_RANGE = 3;

/** Habitants / emplois par niveau de densité (0 à 3). */
export const RESIDENTS = [0, 12, 45, 140];
export const JOBS_C = [0, 10, 30, 80];
export const JOBS_I = [0, 20, 45, 90];
/** Part des habitants en âge de travailler. */
export const WORKFORCE_RATIO = 0.6;

/** Capacité de trafic (trajets/mois) par type de route : au-delà, embouteillages. */
export const ROAD_CAPACITY = { ROAD: 160, AVENUE: 420, HIGHWAY: 900 } as const;

/** Déchets produits par mois et par niveau de densité. */
export const GARBAGE_PER_LEVEL: Record<ZoneType, number> = { R: 1, C: 1.5, I: 3 };
/** Capacités mensuelles de traitement. */
export const WASTE_CAPACITY = { LANDFILL: 180, INCINERATOR: 420, RECYCLING: 0.3 } as const;
/** Une décharge se remplit : au-delà de ce cumul elle est pleine. */
export const LANDFILL_LIMIT = 9000;

/** Rayon d'action des services (en tuiles) — le rayonnement décroît avec la distance. */
export const SERVICE_RADIUS: Record<ServiceType, number> = {
  POLICE: 10,
  FIRE: 10,
  HOSPITAL: 12,
  SCHOOL: 9,
  WATER: 0, // l'eau passe par le réseau, pas par un rayon
  METRO: 6,
  PARK: 4,
  LANDFILL: 22,
  INCINERATOR: 22,
  RECYCLING: 22,
  BUSSTOP: 5,
  HIGHSCHOOL: 14,
  PARKING: 4,
  TREATMENT: 14,
  STATION: 8,
};

/** Entretien mensuel. */
export const UPKEEP: Partial<Record<TileType, number>> = {
  ROAD: 1,
  AVENUE: 2,
  HIGHWAY: 3,
  POWER: 120,
  POLICE: 50,
  FIRE: 50,
  HOSPITAL: 80,
  SCHOOL: 60,
  WATER: 30,
  METRO: 40,
  PARK: 4,
  LANDFILL: 25,
  INCINERATOR: 70,
  RECYCLING: 60,
  BUSSTOP: 6,
  RAIL: 2,
  HIGHSCHOOL: 90,
  PARKING: 8,
  TREATMENT: 70,
  STATION: 60,
  HOTEL: 30,
  RESORT: 15,
  WIND: 12,
  SOLAR: 18,
  NUCLEAR: 380,
  PORT: 110,
  FREIGHT: 70,
  MARKET: 20,
  FAIR: 55,
  ARENA: 90,
  STADIUM: 150,
  UNIVERSITY: 180,
  AIRPORT: 250,
  LANDMARK: 60,
};

// ---------------------------------------------------------------------------
// Budget par service (financement 0-120 %)
// ---------------------------------------------------------------------------

export type FundingKey = 'police' | 'fire' | 'health' | 'education' | 'transport' | 'utilities' | 'waste';
export type Funding = Record<FundingKey, number>;
export const DEFAULT_FUNDING: Funding = {
  police: 100,
  fire: 100,
  health: 100,
  education: 100,
  transport: 100,
  utilities: 100,
  waste: 100,
};
export const FUNDING_LABELS: Record<FundingKey, string> = {
  police: '🚓 Police',
  fire: '🚒 Pompiers',
  health: '🏥 Santé',
  education: '🏫 Éducation',
  transport: '🚇 Transports',
  utilities: '⚡ Énergie & eau',
  waste: '♻️ Déchets',
};
/** Sous ce financement, le personnel se met en grève : le service ne fonctionne plus. */
export const STRIKE_BELOW = 40;

/** Catégorie budgétaire de chaque type de tuile. */
export function fundingOf(t: TileType): FundingKey | null {
  switch (t) {
    case 'POLICE':
      return 'police';
    case 'FIRE':
      return 'fire';
    case 'HOSPITAL':
      return 'health';
    case 'SCHOOL':
    case 'HIGHSCHOOL':
    case 'UNIVERSITY':
      return 'education';
    case 'ROAD':
    case 'AVENUE':
    case 'HIGHWAY':
    case 'METRO':
    case 'BUSSTOP':
    case 'RAIL':
    case 'STATION':
    case 'PARKING':
      return 'transport';
    case 'POWER':
    case 'WIND':
    case 'SOLAR':
    case 'NUCLEAR':
    case 'WATER':
    case 'TREATMENT':
      return 'utilities';
    case 'PORT':
    case 'FREIGHT':
      return 'transport';
    case 'LANDFILL':
    case 'INCINERATOR':
    case 'RECYCLING':
      return 'waste';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Taxes séparées R / C / I
// ---------------------------------------------------------------------------

export type Taxes = Record<ZoneType, number>;
export const DEFAULT_TAXES: Taxes = { R: DEFAULT_TAX, C: DEFAULT_TAX, I: DEFAULT_TAX };

// ---------------------------------------------------------------------------
// Ordonnances municipales
// ---------------------------------------------------------------------------

export type OrdinanceId = 'smoking' | 'recycling' | 'gambling' | 'watch' | 'energy' | 'curfew' | 'freeTransit' | 'trees';
export type OrdinanceDef = {
  id: OrdinanceId;
  label: string;
  icon: string;
  /** Coût (ou recette si négatif) mensuel par tranche de 100 habitants. */
  costPer100: number;
  effect: string;
};
export const ORDINANCES: OrdinanceDef[] = [
  { id: 'smoking', label: 'Interdiction de fumer', icon: '🚭', costPer100: 1, effect: '+ santé, − demande commerciale' },
  { id: 'recycling', label: 'Tri obligatoire', icon: '♻️', costPer100: 3, effect: '− 25 % de déchets' },
  { id: 'gambling', label: 'Casinos autorisés', icon: '🎰', costPer100: -6, effect: '+ recettes, + criminalité' },
  { id: 'watch', label: 'Voisins vigilants', icon: '👀', costPer100: 1, effect: '− criminalité' },
  { id: 'energy', label: 'Économies d’énergie', icon: '💡', costPer100: 2, effect: '− pollution des centrales' },
  { id: 'curfew', label: 'Couvre-feu', icon: '🌙', costPer100: 1, effect: '−− criminalité, − satisfaction' },
  { id: 'freeTransit', label: 'Transports gratuits', icon: '🎫', costPer100: 4, effect: '+ usagers bus/métro, − trafic' },
  { id: 'trees', label: 'Plantation d’arbres', icon: '🌳', costPer100: 2, effect: '+ valeur foncière, − pollution' },
];
export type Ordinances = Record<OrdinanceId, boolean>;
export const DEFAULT_ORDINANCES = Object.fromEntries(ORDINANCES.map((o) => [o.id, false])) as Ordinances;

// ---------------------------------------------------------------------------
// Monuments (débloqués par la population, un exemplaire chacun)
// ---------------------------------------------------------------------------

export const MONUMENT_UNLOCK: Record<MonumentType, number> = {
  UNIVERSITY: 6000,
  AIRPORT: 10000,
  LANDMARK: 16000,
};
/** Recettes touristiques mensuelles apportées par chaque monument. */
export const MONUMENT_TOURISM: Record<MonumentType, number> = {
  UNIVERSITY: 150,
  AIRPORT: 900,
  LANDMARK: 700,
};
export const MONUMENT_RADIUS: Record<MonumentType, number> = {
  UNIVERSITY: 20,
  AIRPORT: 18,
  LANDMARK: 12,
};

// ---------------------------------------------------------------------------
// Énergie : production (MW) de chaque centrale, consommation des bâtiments
// ---------------------------------------------------------------------------

export const PLANT_OUTPUT: Record<PlantType, number> = { POWER: 450, WIND: 70, SOLAR: 90, NUCLEAR: 2200 };
/** Pollution émise par une centrale en service. */
export const PLANT_POLLUTION: Record<PlantType, number> = { POWER: 22, WIND: 0, SOLAR: 0, NUCLEAR: 0 };
/** Population nécessaire pour construire une centrale nucléaire. */
export const NUCLEAR_UNLOCK = 4000;
/** Consommation par niveau de densité, et forfaits des équipements. */
export const POWER_USE = { R: 1, C: 1.6, I: 3, lot: 0, service: 3, water: 4, venue: 6, logistics: 6, monument: 8 } as const;

// ---------------------------------------------------------------------------
// Logistique : exporter la production industrielle
// ---------------------------------------------------------------------------

/** Emplois industriels dont la production peut être exportée par chaque équipement. */
export const LOGISTICS_CAPACITY: Record<LogisticsType, number> = { PORT: 2500, FREIGHT: 1200 };
/** Au-delà de cette population, l'industrie a besoin d'exporter pour se développer. */
export const EXPORT_NEEDED_AT = 1500;

// ---------------------------------------------------------------------------
// Lieux d'événements
// ---------------------------------------------------------------------------

export const VENUE_UNLOCK: Record<VenueType, number> = { MARKET: 0, FAIR: 400, ARENA: 1500, STADIUM: 3000 };
/** Recettes touristiques de base (hors événements). */
export const VENUE_TOURISM: Record<VenueType, number> = { MARKET: 20, FAIR: 60, ARENA: 120, STADIUM: 200 };

// ---------------------------------------------------------------------------
// Tourisme, éducation, transports, relief
// ---------------------------------------------------------------------------

/** Chambres d'un hôtel : sans hôtels, seuls les touristes d'un jour viennent (recettes réduites de moitié). */
export const HOTEL_ROOMS = 400;
/** Attrait touristique d'une plage aménagée (visiteurs par mois). */
export const RESORT_VISITORS = 150;
/** Recette par visiteur. */
export const SPEND_PER_VISITOR = 1.6;
/** Populations nécessaires pour débloquer certains équipements. */
export const UNLOCK: Partial<Record<TileType, number>> = { HIGHSCHOOL: 1000, STATION: 1500, HOTEL: 800, NUCLEAR: 4000 };
/** Population à partir de laquelle les commerces de niveau 3 ont besoin d'un parking. */
export const PARKING_NEEDED_AT = 2500;
/** Coût d'un niveau de terrassement (monter / abaisser une tuile). */
export const TERRAFORM_COST = 25;
/** Hauteur d'un niveau de relief, en pixels écran. */
export const LEVEL_H = 12;
/** Une route sur une tuile d'altitude ≥ 2 est un tunnel (coût multiplié). */
export const TUNNEL_FACTOR = 3;
/** Coût de la pose du tramway sur une tuile d'avenue. */
export const TRAM_COST = 40;

// ---------------------------------------------------------------------------
// Saisons
// ---------------------------------------------------------------------------

export type Season = 'winter' | 'spring' | 'summer' | 'autumn';
export const SEASON_LABELS: Record<Season, { icon: string; label: string }> = {
  winter: { icon: '❄️', label: 'Hiver' },
  spring: { icon: '🌸', label: 'Printemps' },
  summer: { icon: '☀️', label: 'Été' },
  autumn: { icon: '🍂', label: 'Automne' },
};
export function seasonOf(month: number): Season {
  const m = ((month % 12) + 12) % 12;
  return m === 11 || m <= 1 ? 'winter' : m <= 4 ? 'spring' : m <= 7 ? 'summer' : 'autumn';
}

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

export type ToolId =
  | 'inspect'
  | 'road'
  | 'avenue'
  | 'highway'
  | 'zoneR'
  | 'zoneC'
  | 'zoneI'
  | 'power'
  | 'water'
  | 'metro'
  | 'busstop'
  | 'raise'
  | 'lower'
  | 'rail'
  | 'station'
  | 'tram'
  | 'parking'
  | 'highschool'
  | 'treatment'
  | 'hotel'
  | 'resort'
  | 'wind'
  | 'solar'
  | 'nuclear'
  | 'port'
  | 'freight'
  | 'market'
  | 'fair'
  | 'arena'
  | 'police'
  | 'fire'
  | 'hospital'
  | 'school'
  | 'park'
  | 'landfill'
  | 'incinerator'
  | 'recycling'
  | 'stadium'
  | 'university'
  | 'airport'
  | 'landmark'
  | 'bulldoze';

export type ToolGroup = 'base' | 'zones' | 'energy' | 'networks' | 'services' | 'waste' | 'leisure' | 'monuments';

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
  { id: 'raise', label: 'Monter', icon: '⛰️', cost: 25, color: '#a04000', group: 'base', places: null },
  { id: 'lower', label: 'Creuser', icon: '🕳️', cost: 25, color: '#6e2c00', group: 'base', places: null },
  { id: 'road', label: 'Rue', icon: '🛣️', cost: 10, color: '#95a5a6', group: 'zones', places: 'ROAD' },
  { id: 'avenue', label: 'Avenue', icon: '🛤️', cost: 25, color: '#7f8c8d', group: 'zones', places: 'AVENUE' },
  { id: 'highway', label: 'Autoroute', icon: '🛣', cost: 40, color: '#566573', group: 'zones', places: 'HIGHWAY' },
  { id: 'zoneR', label: 'Résidentiel', icon: '🏠', cost: 20, color: '#2ecc71', group: 'zones', places: 'R' },
  { id: 'zoneC', label: 'Commerce', icon: '🏬', cost: 20, color: '#3498db', group: 'zones', places: 'C' },
  { id: 'zoneI', label: 'Industrie', icon: '🏭', cost: 20, color: '#f1c40f', group: 'zones', places: 'I' },
  { id: 'power', label: 'Charbon', icon: '🏭', cost: 3000, color: '#34495e', group: 'energy', places: 'POWER' },
  { id: 'wind', label: 'Éolienne', icon: '🌬️', cost: 700, color: '#ecf0f1', group: 'energy', places: 'WIND' },
  { id: 'solar', label: 'Solaire', icon: '☀️', cost: 1100, color: '#2e86c1', group: 'energy', places: 'SOLAR' },
  { id: 'nuclear', label: 'Nucléaire', icon: '⚛️', cost: 16000, color: '#a9cce3', group: 'energy', places: 'NUCLEAR' },
  { id: 'water', label: "Château d'eau", icon: '💧', cost: 400, color: '#5dade2', group: 'networks', places: 'WATER' },
  { id: 'metro', label: 'Métro', icon: '🚇', cost: 700, color: '#16a085', group: 'networks', places: 'METRO' },
  { id: 'busstop', label: 'Arrêt de bus', icon: '🚏', cost: 80, color: '#f39c12', group: 'networks', places: 'BUSSTOP' },
  { id: 'tram', label: 'Tramway', icon: '🚋', cost: 40, color: '#27ae60', group: 'networks', places: null },
  { id: 'rail', label: 'Voie ferrée', icon: '🚆', cost: 30, color: '#6e2c00', group: 'networks', places: 'RAIL' },
  { id: 'station', label: 'Gare', icon: '🚉', cost: 2000, color: '#a93226', group: 'networks', places: 'STATION' },
  { id: 'parking', label: 'Parking', icon: '🅿️', cost: 300, color: '#2874a6', group: 'networks', places: 'PARKING' },
  { id: 'treatment', label: 'Épuration', icon: '🫧', cost: 1800, color: '#48c9b0', group: 'networks', places: 'TREATMENT' },
  { id: 'port', label: 'Port', icon: '⚓', cost: 5000, color: '#1f618d', group: 'networks', places: 'PORT' },
  { id: 'freight', label: 'Gare de fret', icon: '🚂', cost: 2500, color: '#784212', group: 'networks', places: 'FREIGHT' },
  { id: 'police', label: 'Police', icon: '🚓', cost: 500, color: '#2e4a8a', group: 'services', places: 'POLICE' },
  { id: 'fire', label: 'Pompiers', icon: '🚒', cost: 500, color: '#c0392b', group: 'services', places: 'FIRE' },
  { id: 'hospital', label: 'Hôpital', icon: '🏥', cost: 800, color: '#ecf0f1', group: 'services', places: 'HOSPITAL' },
  { id: 'school', label: 'École', icon: '🏫', cost: 600, color: '#e67e22', group: 'services', places: 'SCHOOL' },
  { id: 'highschool', label: 'Lycée', icon: '🎒', cost: 1500, color: '#ca6f1e', group: 'services', places: 'HIGHSCHOOL' },
  { id: 'park', label: 'Parc', icon: '🌳', cost: 50, color: '#27ae60', group: 'services', places: 'PARK' },
  { id: 'landfill', label: 'Décharge', icon: '🗑️', cost: 300, color: '#8d6e63', group: 'waste', places: 'LANDFILL' },
  { id: 'incinerator', label: 'Incinérateur', icon: '🔥', cost: 1500, color: '#6d4c41', group: 'waste', places: 'INCINERATOR' },
  { id: 'recycling', label: 'Recyclage', icon: '♻️', cost: 1200, color: '#43a047', group: 'waste', places: 'RECYCLING' },
  { id: 'market', label: 'Marché', icon: '🛒', cost: 900, color: '#e59866', group: 'leisure', places: 'MARKET' },
  { id: 'resort', label: 'Plage', icon: '🏖️', cost: 400, color: '#f7dc6f', group: 'leisure', places: 'RESORT' },
  { id: 'hotel', label: 'Hôtel', icon: '🏨', cost: 3000, color: '#af7ac5', group: 'leisure', places: 'HOTEL' },
  { id: 'fair', label: 'Fête foraine', icon: '🎡', cost: 2500, color: '#ec7063', group: 'leisure', places: 'FAIR' },
  { id: 'arena', label: 'Concerts', icon: '🎵', cost: 4000, color: '#8e44ad', group: 'leisure', places: 'ARENA' },
  { id: 'stadium', label: 'Stade', icon: '🏟️', cost: 6000, color: '#e74c3c', group: 'leisure', places: 'STADIUM' },
  { id: 'university', label: 'Université', icon: '🎓', cost: 8000, color: '#8e44ad', group: 'monuments', places: 'UNIVERSITY' },
  { id: 'airport', label: 'Aéroport', icon: '✈️', cost: 15000, color: '#bdc3c7', group: 'monuments', places: 'AIRPORT' },
  { id: 'landmark', label: 'Tour', icon: '🗼', cost: 12000, color: '#f1c40f', group: 'monuments', places: 'LANDMARK' },
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
  busstop: 'BUSSTOP',
  highschool: 'HIGHSCHOOL',
  parking: 'PARKING',
  treatment: 'TREATMENT',
  station: 'STATION',
  landfill: 'LANDFILL',
  incinerator: 'INCINERATOR',
  recycling: 'RECYCLING',
};

/** Vues de données (cartes thématiques, comme dans SimCity). */
export type DataView = 'none' | 'traffic' | 'pollution' | 'crime' | 'value' | 'garbage' | 'happiness' | 'districts' | 'power' | 'water' | 'health';
export const DATA_VIEWS: { id: DataView; label: string; icon: string }[] = [
  { id: 'none', label: 'Normale', icon: '🗺️' },
  { id: 'traffic', label: 'Trafic', icon: '🚗' },
  { id: 'pollution', label: 'Pollution', icon: '🏭' },
  { id: 'crime', label: 'Criminalité', icon: '🚨' },
  { id: 'value', label: 'Valeur', icon: '💎' },
  { id: 'garbage', label: 'Déchets', icon: '🗑️' },
  { id: 'happiness', label: 'Satisfaction', icon: '😊' },
  { id: 'power', label: 'Électricité', icon: '⚡' },
  { id: 'water', label: 'Eau polluée', icon: '🫧' },
  { id: 'health', label: 'Santé', icon: '🦠' },
  { id: 'districts', label: 'Quartiers', icon: '🏘️' },
];

export const MONTHS = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
