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
export type MonumentType = 'STADIUM' | 'UNIVERSITY' | 'AIRPORT' | 'LANDMARK';

/** Routes : rue (2 voies), avenue (4 voies), autoroute (rapide, sans accès aux zones). */
export type RoadType = 'ROAD' | 'AVENUE' | 'HIGHWAY';

/** Terrain naturel. */
export type TerrainType = 'GRASS' | 'DIRT' | 'LAKE' | 'SAND' | 'FOREST';

export type TileType = TerrainType | RoadType | ZoneType | 'POWER' | ServiceType | MonumentType;

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
export const MONUMENT_TYPES: MonumentType[] = ['STADIUM', 'UNIVERSITY', 'AIRPORT', 'LANDMARK'];
export const ROAD_TYPES: RoadType[] = ['ROAD', 'AVENUE', 'HIGHWAY'];

export const isZone = (t: TileType): t is ZoneType => t === 'R' || t === 'C' || t === 'I';
export const isService = (t: TileType): t is ServiceType => (SERVICE_TYPES as TileType[]).includes(t);
export const isMonument = (t: TileType): t is MonumentType => (MONUMENT_TYPES as TileType[]).includes(t);
export const isRoadType = (t: TileType): t is RoadType => t === 'ROAD' || t === 'AVENUE' || t === 'HIGHWAY';
/** Routes qui desservent les zones (l'autoroute n'a pas d'accès riverain). */
export const servesZones = (t: TileType) => t === 'ROAD' || t === 'AVENUE';
/** Terrain constructible sans bulldozer. */
export const isBuildableGround = (t: TileType) => t === 'GRASS' || t === 'DIRT' || t === 'SAND';
/** Tuile bâtie qui consomme courant et eau (zones construites, services, monuments, centrales). */
export const isBuilding = (t: Tile) =>
  (isZone(t.type) && t.density > 0) || isService(t.type) || isMonument(t.type) || t.type === 'POWER';

export function blankTile(x: number, y: number): Tile {
  return { x, y, type: 'GRASS', density: 0, powered: false, water: false, value: 0, fire: 0, lake: false, garbage: 0, flood: 0 };
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
