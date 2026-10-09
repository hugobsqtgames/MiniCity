export type ZoneType = 'R' | 'C' | 'I';

/** Bâtiments de service public (1 tuile chacun). */
export type ServiceType = 'POLICE' | 'FIRE' | 'HOSPITAL' | 'SCHOOL' | 'WATER' | 'METRO' | 'PARK';

export type TileType = 'DIRT' | 'GRASS' | 'ROAD' | ZoneType | 'POWER' | ServiceType;

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
};

export const SERVICE_TYPES: ServiceType[] = ['POLICE', 'FIRE', 'HOSPITAL', 'SCHOOL', 'WATER', 'METRO', 'PARK'];

export const isZone = (t: TileType): t is ZoneType => t === 'R' || t === 'C' || t === 'I';
export const isService = (t: TileType): t is ServiceType => (SERVICE_TYPES as TileType[]).includes(t);
/** Tuile bâtie qui consomme courant et eau (zones construites, services, centrales). */
export const isBuilding = (t: Tile) => (isZone(t.type) && t.density > 0) || isService(t.type) || t.type === 'POWER';

export function createEmptyMap(size: number): Tile[] {
  const tiles: Tile[] = new Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      tiles[y * size + x] = { x, y, type: 'GRASS', density: 0, powered: false, water: false, value: 0, fire: 0 };
    }
  }
  return tiles;
}

/** Index 1D (row-major) : l'ordre du tableau EST l'ordre de rendu (y puis x). */
export const tileIndex = (x: number, y: number, size: number) => y * size + x;
