import { createEmptyMap, LINE_TRAM, tileIndex, type Tile, type TileType } from './map';

/**
 * Petite ville de démonstration générée de façon déterministe, pour juger le
 * rendu et la simulation (accessible depuis le menu ⚙︎).
 */
export function createDemoMap(size: number): Tile[] {
  const tiles = createEmptyMap(size);
  const set = (x: number, y: number, type: TileType, density = 0) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const t = tiles[tileIndex(x, y, size)];
    t.type = type;
    t.density = density;
  };
  const get = (x: number, y: number) => tiles[tileIndex(x, y, size)];
  const rand = (x: number, y: number) => {
    const h = Math.imul((x * 73856093) ^ (y * 19349663), 2654435761) >>> 0;
    return (h % 1000) / 1000;
  };

  // Réseau routier : 3 avenues horizontales, 4 verticales.
  for (const y of [12, 20, 28]) for (let x = 8; x <= 42; x++) set(x, y, 'ROAD');
  for (const x of [8, 18, 28, 38]) for (let y = 8; y <= 36; y++) set(x, y, 'ROAD');

  // Quartiers (bornes inclusives).
  const districts: { x0: number; x1: number; y0: number; y1: number; type: TileType; dense: number }[] = [
    { x0: 19, x1: 27, y0: 21, y1: 27, type: 'C', dense: 0.9 }, // centre-ville
    { x0: 19, x1: 27, y0: 13, y1: 19, type: 'R', dense: 0.75 },
    { x0: 9, x1: 17, y0: 13, y1: 19, type: 'R', dense: 0.4 },
    { x0: 9, x1: 17, y0: 21, y1: 27, type: 'R', dense: 0.55 },
    { x0: 29, x1: 37, y0: 13, y1: 19, type: 'C', dense: 0.5 },
    { x0: 29, x1: 37, y0: 21, y1: 27, type: 'R', dense: 0.6 },
    { x0: 9, x1: 27, y0: 29, y1: 35, type: 'I', dense: 0.5 },
    { x0: 29, x1: 37, y0: 29, y1: 35, type: 'R', dense: 0.3 },
  ];

  for (const d of districts) {
    for (let y = d.y0; y <= d.y1; y++) {
      for (let x = d.x0; x <= d.x1; x++) {
        if (get(x, y).type === 'ROAD') continue;
        const r = rand(x, y);
        // Un parc de temps en temps : on laisse l'herbe.
        if (r > 0.93) continue;
        const roll = rand(y, x);
        // Plus on s'approche du centre-ville, plus les immeubles montent.
        const urban = Math.max(0, 1 - Math.hypot(x - 23, y - 24) / 16);
        const score = urban * d.dense + rand(x + 101, y + 7) * 0.35;
        const density = roll < 0.1 ? 0 : score > 0.75 ? 3 : score > 0.42 ? 2 : 1;
        set(x, y, d.type, density);
      }
    }
  }

  // Centrales électriques (portée 15 tuiles) reliées au réseau par des routes.
  for (let y = 5; y <= 9; y++) for (let x = 39; x <= 44; x++) if (get(x, y).type === 'GRASS') set(x, y, 'DIRT');
  for (let x = 39; x <= 44; x++) set(x, 10, 'ROAD');
  set(40, 9, 'ROAD');
  set(42, 9, 'ROAD');
  set(40, 8, 'POWER');
  set(42, 8, 'POWER');
  for (let x = 8; x <= 28; x++) set(x, 36, 'ROAD');
  set(12, 37, 'POWER');
  set(22, 37, 'POWER');
  set(7, 15, 'POWER');
  set(28, 9, 'POWER');
  set(39, 22, 'POWER');
  set(39, 32, 'POWER');
  set(24, 24, 'POWER');

  // Châteaux d'eau à côté des centrales (ils ont besoin de courant pour pomper).
  for (const [x, y] of [
    [41, 8],
    [13, 37],
    [23, 37],
    [7, 16],
    [29, 9],
    [39, 23],
    [39, 33],
    [25, 24],
    [20, 14],
    [12, 24],
    [33, 16],
  ]) {
    set(x, y, 'WATER');
  }

  // Services publics répartis dans les quartiers.
  const services: [number, number, TileType][] = [
    [14, 17, 'POLICE'],
    [33, 25, 'POLICE'],
    [22, 30, 'POLICE'],
    [19, 14, 'FIRE'],
    [30, 18, 'FIRE'],
    [15, 33, 'FIRE'],
    [26, 16, 'HOSPITAL'],
    [11, 24, 'SCHOOL'],
    [33, 33, 'SCHOOL'],
    [20, 22, 'METRO'],
    [27, 26, 'METRO'],
    [13, 15, 'METRO'],
    [35, 15, 'METRO'],
    [16, 25, 'PARK'],
    [31, 29, 'PARK'],
    [23, 13, 'PARK'],
  ];
  for (const [x, y, type] of services) set(x, y, type);

  // Un incendie en cours dans le centre : les pompiers sont en route.
  const burning = get(21, 26);
  if (burning.type === 'C' || burning.type === 'R') {
    burning.density = Math.max(1, burning.density);
    burning.fire = 1;
  }

  // Quelques parcelles de terre battue en périphérie.
  for (let y = 38; y <= 41; y++) for (let x = 12; x <= 16; x++) if (rand(x, y) > 0.35) set(x, y, 'DIRT');

  // Grands axes : deux avenues qui se croisent au centre-ville.
  for (let x = 8; x <= 42; x++) set(x, 20, 'AVENUE');
  for (let y = 10; y <= 36; y++) set(28, y, 'AVENUE');
  for (let x = 8; x <= 42; x++) set(x, 28, 'AVENUE');
  for (let y = 8; y <= 36; y++) set(18, y, 'AVENUE');

  // Rivière au sud, bordée de plages, franchie par deux ponts.
  for (let x = 0; x < size; x++) {
    const mid = 44 + Math.round(Math.sin(x / 6) * 1.2);
    for (let y = mid - 1; y <= mid + 1; y++) set(x, y, 'LAKE');
    for (const y of [mid - 2, mid + 2]) if (get(x, y).type === 'GRASS' && rand(x, y) < 0.8) set(x, y, 'SAND');
  }
  // Lac au nord-ouest.
  for (let y = 0; y < 9; y++) for (let x = 0; x < 7; x++) if (Math.hypot(x - 2.5, y - 3.5) < 3.6) set(x, y, 'LAKE');
  for (const bx of [18, 38]) {
    for (let y = 37; y < size; y++) {
      const t = get(bx, y);
      if (t.type === 'LAKE') {
        t.type = 'ROAD';
        t.lake = true;
      } else if (t.type !== 'POWER' && t.type !== 'WATER') set(bx, y, 'ROAD');
    }
  }

  // Autoroute de contournement à l'est, reliée aux rues.
  for (let y = 0; y < 43; y++) set(46, y, 'HIGHWAY');
  for (let x = 43; x <= 45; x++) {
    set(x, 10, 'ROAD');
    set(x, 28, 'ROAD');
  }
  for (let x = 38; x <= 42; x++) set(x, 28, 'ROAD');

  // Forêts en lisière.
  for (let y = 10; y < 40; y++) for (let x = 0; x < 6; x++) if (get(x, y).type === 'GRASS' && rand(x * 3, y) < 0.7) set(x, y, 'FOREST');
  for (let y = 0; y < 5; y++) for (let x = 30; x < 45; x++) if (get(x, y).type === 'GRASS' && rand(x, y * 5) < 0.6) set(x, y, 'FOREST');

  // Arrêts de bus le long des rues desservant les quartiers.
  for (const [x, y] of [
    [17, 16],
    [27, 15],
    [19, 25],
    [29, 24],
    [17, 31],
    [37, 17],
  ]) {
    set(x, y, 'BUSSTOP');
  }

  // Gestion des déchets en périphérie.
  for (let y = 38; y <= 41; y++) for (let x = 40; x <= 44; x++) set(x, y, 'DIRT');
  set(41, 38, 'LANDFILL');
  get(41, 38).garbage = 5;
  set(42, 38, 'LANDFILL');
  get(42, 38).garbage = 2;
  set(43, 38, 'RECYCLING');
  set(41, 39, 'INCINERATOR');
  for (let x = 39; x <= 44; x++) set(x, 37, 'ROAD');
  // Incinérateurs et tri au cœur de la zone industrielle : la collecte couvre toute la ville.
  set(14, 32, 'INCINERATOR');
  set(24, 33, 'INCINERATOR');
  set(20, 31, 'RECYCLING');
  set(31, 10, 'LANDFILL');

  // Logistique : port sur la rivière (près du pont) et gare de fret à l'est.
  set(19, 42, 'PORT');
  set(37, 36, 'FREIGHT');
  set(7, 30, 'FREIGHT');

  // Énergies renouvelables au nord-est, reliées au réseau par la route.
  for (let x = 40; x <= 44; x++) set(x, 11, 'WIND');
  for (let x = 40; x <= 43; x++) set(x, 12, 'SOLAR');

  // Lieux d'événements.
  set(33, 23, 'STADIUM');
  set(25, 26, 'MARKET');
  set(12, 26, 'FAIR');
  set(35, 19, 'ARENA');

  // Monuments.
  set(24, 17, 'LANDMARK');
  set(10, 39, 'UNIVERSITY');
  for (let x = 8; x <= 11; x++) set(x, 38, 'ROAD');

  // Relief : collines boisées à l'ouest, montagne au nord percée d'un tunnel.
  for (let y = 10; y < 40; y++) {
    for (let x = 0; x < 6; x++) {
      const t = get(x, y);
      if (t.type === 'LAKE') continue;
      t.elev = Math.max(0, Math.min(3, Math.round(3 - x * 0.6 + Math.sin(y / 3) * 0.6)));
    }
  }
  for (let y = 0; y < 6; y++) {
    for (let x = 30; x < 46; x++) {
      const t = get(x, y);
      t.elev = Math.max(0, Math.min(3, 3 - Math.floor(y / 2) - (x < 32 || x > 43 ? 1 : 0)));
    }
  }
  for (let y = 0; y <= 7; y++) {
    set(38, y, 'ROAD');
    get(38, y).elev = y <= 1 ? 2 : y <= 3 ? 1 : 0;
  }
  for (let y = 0; y <= 7; y++) for (const x of [37, 39]) if (get(x, y).type === 'GRASS') get(x, y).elev = get(38, y).elev + (y <= 3 ? 1 : 0);

  // Tramway sur l'avenue centrale.
  for (let x = 8; x <= 42; x++) get(x, 20).line |= LINE_TRAM;

  // Voie ferrée à l'est (le long de l'autoroute) avec deux gares.
  for (let y = 4; y <= 40; y++) set(48, y, 'RAIL');
  set(48, 12, 'STATION');
  set(48, 30, 'STATION');
  set(47, 12, 'RAIL');
  set(47, 30, 'RAIL');

  // Tourisme : hôtel près de la tour, plages aménagées sur la rivière.
  set(26, 18, 'HOTEL');
  set(31, 22, 'HOTEL');
  let resorts = 0;
  for (let x = 22; x < size && resorts < 4; x += 3) {
    for (let y = 38; y < size; y++) {
      if (get(x, y).type === 'SAND' && (get(x, y + 1)?.type === 'LAKE' || get(x, y - 1)?.type === 'LAKE')) {
        set(x, y, 'RESORT');
        resorts++;
        break;
      }
    }
  }

  // Lycée, parkings du centre-ville, station d'épuration au bord de la rivière.
  set(31, 16, 'HIGHSCHOOL');
  for (const [x, y] of [
    [22, 25],
    [26, 22],
    [20, 23],
    [24, 27],
    [27, 25],
    [31, 14],
    [35, 14],
    [33, 18],
  ])
    set(x, y, 'PARKING');
  // Écoles supplémentaires et second lycée : une population instruite.
  for (const [x, y, type] of [
    [23, 15, 'SCHOOL'],
    [34, 27, 'SCHOOL'],
    [14, 21, 'SCHOOL'],
    [22, 22, 'SCHOOL'],
    [13, 26, 'HIGHSCHOOL'],
    [32, 32, 'HIGHSCHOOL'],
  ] as [number, number, TileType][])
    set(x, y, type);
  set(14, 40, 'TREATMENT');
  set(15, 40, 'ROAD');
  for (let y = 37; y <= 40; y++) set(16, y, 'ROAD');

  // Industries spécialisées : fermes et scierie près des bois, haute technologie à l'est.
  for (let y = 29; y <= 35; y++) {
    for (let x = 9; x <= 27; x++) {
      const t = get(x, y);
      if (t.type !== 'I' || t.density === 0) continue;
      t.spec = x <= 10 ? 2 : x <= 13 ? 1 : x >= 24 ? 3 : 0;
    }
  }

  return tiles;
}
