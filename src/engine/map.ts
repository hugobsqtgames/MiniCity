export type ZoneType = 'R' | 'C' | 'I';

/** Bâtiments de service public (1 tuile chacun). */
export type ServiceType =
  | 'POLICE'
  | 'FIRE'
  | 'HOSPITAL'
  | 'SCHOOL'
  | 'WATER'
  | 'METRO'
  | 'PARK'
  | 'LANDFILL'
  | 'INCINERATOR'
  | 'RECYCLING'
  | 'BUSSTOP';

/** Monuments débloqués par paliers de population (un seul exemplaire chacun). */
export type MonumentType = 'UNIVERSITY' | 'AIRPORT' | 'LANDMARK';

/** Lieux d'événements (matchs, concerts, festivals, marchés), constructibles en plusieurs exemplaires. */
export type VenueType = 'STADIUM' | 'ARENA' | 'FAIR' | 'MARKET';

/** Centrales : charbon, éolienne, solaire, nucléaire. */
export type PlantType = 'POWER' | 'WIND' | 'SOLAR' | 'NUCLEAR';

/** Logistique : port (au bord de l'eau) et gare de fret, pour exporter la production industrielle. */
export type LogisticsType = 'PORT' | 'FREIGHT';

/** Routes : rue (2 voies), avenue (4 voies), autoroute (rapide, sans accès aux zones). */
export type RoadType = 'ROAD' | 'AVENUE' | 'HIGHWAY';

/** Terrain naturel. */
export type TerrainType = 'GRASS' | 'DIRT' | 'LAKE' | 'SAND' | 'FOREST';

export type TileType = TerrainType | RoadType | ZoneType | PlantType | ServiceType | MonumentType | VenueType | LogisticsType;

export type Tile = {
  x: number;
  y: number;
  type: TileType;
  /** 0-3 */
  density: number;
  powered: boolean;
  /** Raccordé au réseau d'eau. */
  water: boolean;
  value: number;
  /** Incendie : 0 = aucun, sinon nombre de mois depuis le départ du feu. */
  fire: number;
  /** Construit sur l'eau (pont pour une route). */
  lake: boolean;
  /** Déchets non ramassés (0-9) ; pour une décharge : taux de remplissage (0-9). */
  garbage: number;
  /** Mois restants hors service (inondation, panne) — 0 = normal. */
  flood: number;
  /** Contamination radioactive (0-9, baisse d'un cran par an) après un accident nucléaire. */
  rad: number;
};

export const SERVICE_TYPES: ServiceType[] = [
  'POLICE',
  'FIRE',
  'HOSPITAL',
  'SCHOOL',
  'WATER',
  'METRO',
  'PARK',
  'LANDFILL',
  'INCINERATOR',
  'RECYCLING',
  'BUSSTOP',
];
export const MONUMENT_TYPES: MonumentType[] = ['UNIVERSITY', 'AIRPORT', 'LANDMARK'];
export const VENUE_TYPES: VenueType[] = ['STADIUM', 'ARENA', 'FAIR', 'MARKET'];
export const PLANT_TYPES: PlantType[] = ['POWER', 'WIND', 'SOLAR', 'NUCLEAR'];
export const LOGISTICS_TYPES: LogisticsType[] = ['PORT', 'FREIGHT'];
export const ROAD_TYPES: RoadType[] = ['ROAD', 'AVENUE', 'HIGHWAY'];

export const isZone = (t: TileType): t is ZoneType => t === 'R' || t === 'C' || t === 'I';
export const isService = (t: TileType): t is ServiceType => (SERVICE_TYPES as TileType[]).includes(t);
export const isMonument = (t: TileType): t is MonumentType => (MONUMENT_TYPES as TileType[]).includes(t);
export const isVenue = (t: TileType): t is VenueType => (VENUE_TYPES as TileType[]).includes(t);
export const isPlant = (t: TileType): t is PlantType => (PLANT_TYPES as TileType[]).includes(t);
export const isLogistics = (t: TileType): t is LogisticsType => t === 'PORT' || t === 'FREIGHT';
export const isRoadType = (t: TileType): t is RoadType => t === 'ROAD' || t === 'AVENUE' || t === 'HIGHWAY';
/** Routes qui desservent les zones (l'autoroute n'a pas d'accès riverain). */
export const servesZones = (t: TileType) => t === 'ROAD' || t === 'AVENUE';
/** Terrain constructible sans bulldozer. */
export const isBuildableGround = (t: TileType) => t === 'GRASS' || t === 'DIRT' || t === 'SAND';
/** Bâtiment public ou industriel posé par le joueur (hors zones et routes). */
export const isFacility = (t: TileType) => isService(t) || isMonument(t) || isVenue(t) || isPlant(t) || isLogistics(t);
/** Tuile bâtie (zones construites, services, monuments, lieux, centrales, logistique). */
export const isBuilding = (t: Tile) => (isZone(t.type) && t.density > 0) || isFacility(t.type);

export function blankTile(x: number, y: number): Tile {
  return { x, y, type: 'GRASS', density: 0, powered: false, water: false, value: 0, fire: 0, lake: false, garbage: 0, flood: 0, rad: 0 };
}

export function createEmptyMap(size: number): Tile[] {
  const tiles: Tile[] = new Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) tiles[y * size + x] = blankTile(x, y);
  }
  return tiles;
}

/** Index 1D (row-major) : l'ordre du tableau EST l'ordre de rendu (y puis x). */
export const tileIndex = (x: number, y: number, size: number) => y * size + x;
