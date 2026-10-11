import { createEmptyMap, type Tile } from '../engine/map';
import { getAdvice } from '../sim/advisors';
import { CHALLENGES, challengeContext, EMPTY_COUNTERS, layoutTree, newlyCompleted } from '../sim/challenges';
import { seasonOf } from '../sim/constants';
import { aLieu, deLieu, districtAt, districtMap } from '../sim/districts';
import { dragTiles } from '../sim/drag';
import { applyPower, computeGrid, plantFactor } from '../sim/power';
import { analyzeCity, DEFAULT_POLICY, exportPenalty, planEvents, simulateMonth, type Demand } from '../sim/simulation';
import { applyTool } from '../sim/tools';
import { place, seeded, smallCity } from './helpers';

const SIZE = 20;
const rich = { funds: 1e9, population: 1e6 };

function run(tiles: Tile[], months: number, startMonth = 1) {
  let state = { tiles: applyPower(tiles, SIZE), treasury: 50000, demand: { r: 1, c: 0.5, i: 0.5 } as Demand };
  const random = seeded(7);
  let last = null as ReturnType<typeof simulateMonth> | null;
  for (let m = 0; m < months; m++) {
    last = simulateMonth({ ...state, size: SIZE, policy: DEFAULT_POLICY, random, month: startMonth + m });
    state = { tiles: last.tiles, treasury: last.treasury, demand: last.demand };
  }
  return last!;
}

describe('énergie', () => {
  it('une éolienne seule ne suffit pas : les consommateurs les plus lointains sont délestés', () => {
    const tiles = smallCity(SIZE);
    tiles[4 * SIZE + 15].type = 'WIND';
    for (const t of tiles) if (t.type === 'R' || t.type === 'C' || t.type === 'I') t.density = 3;
    const grid = computeGrid(tiles, SIZE, 3);
    expect(grid.supply).toBeLessThan(grid.demand);
    expect(grid.served).toBeLessThanOrEqual(grid.supply);
    // La maison la plus proche est servie, la plus lointaine non.
    expect(grid.powered[6 * SIZE + 14]).toBe(1);
    expect(grid.powered[4 * SIZE + 2]).toBe(0);
  });

  it('une centrale à charbon alimente toute la petite ville', () => {
    const grid = computeGrid(smallCity(SIZE), SIZE, 3);
    expect(grid.served).toBe(grid.demand);
  });

  it('le solaire produit moins l’hiver, l’éolien plus', () => {
    expect(seasonOf(0)).toBe('winter');
    expect(seasonOf(6)).toBe('summer');
    expect(plantFactor('SOLAR', 0)).toBeLessThan(plantFactor('SOLAR', 6));
    expect(plantFactor('WIND', 0)).toBeGreaterThan(plantFactor('WIND', 6));
  });

  it('le nucléaire est verrouillé avant 4 000 habitants', () => {
    const tiles = createEmptyMap(SIZE);
    expect(applyTool(tiles, SIZE, 'nuclear', 3, 3, { funds: 1e9, population: 100 }).ok).toBe(false);
    expect(applyTool(tiles, SIZE, 'nuclear', 3, 3, rich).ok).toBe(true);
  });

  it('un accident nucléaire contamine la zone, où l’on ne peut plus construire', () => {
    const city = place(smallCity(SIZE), SIZE, [[12, 7, 'NUCLEAR']]);
    const res = simulateMonth({ tiles: applyPower(city, SIZE), size: SIZE, treasury: 1e5, demand: { r: 0, c: 0, i: 0 }, trigger: 'meltdown', random: seeded(2), month: 3 });
    expect(res.events.disasters[0].kind).toBe('meltdown');
    const contaminated = res.tiles.filter((t) => t.rad > 0);
    expect(contaminated.length).toBeGreaterThan(20);
    const spot = contaminated.find((t) => t.type === 'GRASS')!;
    expect(applyTool(res.tiles, SIZE, 'park', spot.x, spot.y, rich).ok).toBe(false);
  });
});

describe('port et gare de fret', () => {
  it('le port se construit au bord de l’eau seulement', () => {
    const tiles = place(createEmptyMap(SIZE), SIZE, [[5, 5, 'LAKE']]);
    expect(applyTool(tiles, SIZE, 'port', 9, 9, rich).ok).toBe(false);
    expect(applyTool(tiles, SIZE, 'port', 5, 6, rich).ok).toBe(true);
  });

  it('une gare de fret reliée par la route permet d’exporter', () => {
    const city = smallCity(SIZE);
    for (const t of city) if (t.type === 'I') t.density = 3;
    const without = analyzeCity(applyPower(city, SIZE), SIZE).stats;
    expect(without.exports.capacity).toBe(0);
    const withFreight = analyzeCity(applyPower(place(city, SIZE, [[18, 4, 'FREIGHT']]), SIZE), SIZE).stats;
    expect(withFreight.exports.capacity).toBeGreaterThan(0);
    expect(withFreight.exports.connected).toBe(withFreight.exports.jobs);
    // Une grande ville sans export voit la demande industrielle pénalisée.
    expect(exportPenalty({ ...without, population: 5000 })).toBeGreaterThan(0);
    expect(exportPenalty({ ...withFreight, population: 5000 })).toBe(0);
  });
});

describe('lieux et événements', () => {
  const venues = () => applyPower(place(smallCity(SIZE), SIZE, [[9, 6, 'STADIUM'], [10, 6, 'MARKET'], [11, 6, 'FAIR']]), SIZE);

  it('marché de Noël en décembre et feu d’artifice en juillet', () => {
    const dec = planEvents(venues(), 11, 'snow', seeded(1));
    expect(dec.some((e) => e.kind === 'christmas')).toBe(true);
    const jul = planEvents(venues(), 6, 'clear', seeded(1));
    expect(jul.some((e) => e.kind === 'fireworks')).toBe(true);
  });

  it('un événement organisé par le maire a toujours lieu', () => {
    const tiles = venues();
    for (let k = 0; k < 10; k++) {
      const ev = planEvents(tiles, 3, 'clear', seeded(k), [{ x: 9, y: 6 }]);
      expect(ev.some((e) => e.kind === 'match')).toBe(true);
    }
  });

  it('les événements rapportent du tourisme et de la satisfaction', () => {
    const tiles = applyPower(venues().map((t) => (t.type === 'R' ? { ...t, density: 2 } : t)), SIZE);
    const ev = planEvents(tiles, 3, 'clear', seeded(1), [{ x: 9, y: 6 }]);
    const a = analyzeCity(tiles, SIZE, DEFAULT_POLICY, 3, ev);
    const b = analyzeCity(tiles, SIZE, DEFAULT_POLICY, 3, []);
    expect(a.stats.tourism).toBeGreaterThan(b.stats.tourism);
    expect(a.stats.eventBonus).toBeGreaterThan(0);
  });
});

describe('reconstruction', () => {
  it('un bâtiment détruit garde son zonage puis se reconstruit', () => {
    const city = run(smallCity(SIZE), 18);
    const victim = city.tiles.find((t) => t.type === 'R' && t.density > 0)!;
    const tiles = city.tiles.slice();
    tiles[victim.y * SIZE + victim.x] = { ...victim, fire: 3 };
    // Pas de pompiers : le feu détruit le bâtiment au mois suivant.
    const burnt = simulateMonth({ tiles, size: SIZE, treasury: 1e5, demand: city.demand, random: seeded(4), month: 20 });
    const lot = burnt.tiles[victim.y * SIZE + victim.x];
    expect(lot.type).toBe('R');
    expect(lot.density).toBe(0);
    expect(lot.value).toBe(-1);
    let state = burnt;
    let rebuilt = false;
    for (let m = 0; m < 12 && !rebuilt; m++) {
      state = simulateMonth({ tiles: state.tiles, size: SIZE, treasury: 1e5, demand: state.demand, random: seeded(10 + m), month: 21 + m });
      rebuilt = state.tiles[victim.y * SIZE + victim.x].density > 0;
    }
    expect(rebuilt).toBe(true);
  });
});

describe('météo', () => {
  it('neige l’hiver, jamais l’été', () => {
    const summer = new Set(Array.from({ length: 60 }, (_, k) => run(smallCity(SIZE), 1, 6 + (k % 3)).weather));
    expect(summer.has('snow')).toBe(false);
  });
});

describe('quartiers', () => {
  it('découpage stable et nommé', () => {
    const a = districtMap(100);
    expect(a.list.length).toBe(16);
    expect(districtMap(100)).toBe(a);
    expect(districtAt(100, 0, 0).name.length).toBeGreaterThan(2);
    expect(new Set(a.list.map((d) => d.name)).size).toBe(16);
  });

  it('accorde les noms de quartier en français', () => {
    expect(aLieu('Les Vignes')).toBe('aux Vignes');
    expect(aLieu('Le Faubourg')).toBe('au Faubourg');
    expect(aLieu('La Pinède')).toBe('à la Pinède');
    expect(deLieu('Les Forges')).toBe('des Forges');
    expect(deLieu('Haut-Bois')).toBe('de Haut-Bois');
    expect(deLieu('Belle-Rive')).toBe('de Belle-Rive');
  });
});

describe('conseillers', () => {
  it('signalent l’absence de centrale', () => {
    const tiles = smallCity(SIZE);
    tiles[4 * SIZE + 15].type = 'GRASS';
    const a = analyzeCity(applyPower(tiles, SIZE), SIZE);
    const advice = getAdvice(tiles, SIZE, a, DEFAULT_POLICY, { treasury: 1000, net: 10, month: 3 });
    expect(advice[0].id).toBe('no-power');
  });

  it('expliquent un bouchon et pointent la rue saturée', () => {
    const city = run(smallCity(SIZE), 24);
    // Une seule rue étroite pour toute une ville dense : bouchon garanti.
    const tiles = city.tiles.map((t) => (t.type === 'R' ? { ...t, density: 3 } : t));
    const a = analyzeCity(applyPower(tiles, SIZE), SIZE);
    const advice = getAdvice(tiles, SIZE, a, DEFAULT_POLICY, { treasury: 1000, net: 10, month: 3 });
    const jam = advice.find((x) => x.advisor === 'transport' && x.target);
    expect(jam).toBeDefined();
    expect(jam!.view).toBe('traffic');
    expect(tiles[jam!.target!.y * SIZE + jam!.target!.x].type).toBe('ROAD');
  });
});

describe('arbre de défis', () => {
  it('chaque défi a une place unique et un parent existant', () => {
    const { nodes } = layoutTree();
    expect(nodes.length).toBe(CHALLENGES.length);
    const seen = new Set(nodes.map((n) => `${n.col},${n.row}`));
    expect(seen.size).toBe(nodes.length);
    const ids = new Set(CHALLENGES.map((c) => c.id));
    for (const c of CHALLENGES) if (c.parent) expect(ids.has(c.parent)).toBe(true);
  });

  it('un défi ne se débloque qu’après son parent', () => {
    const city = run(smallCity(SIZE), 18);
    const ctx = challengeContext(city.tiles, city.stats, 60000, 18, EMPTY_COUNTERS, DEFAULT_POLICY);
    const won = newlyCompleted(ctx, {}).map((c) => c.id);
    expect(won).toContain('start');
    expect(won).toContain('power');
    expect(won).toContain('money50k');
    // Sans « start », rien d'autre ne se débloque.
    const ctx2 = { ...ctx, stats: { ...ctx.stats, roads: 0 } };
    expect(newlyCompleted(ctx2, {})).toHaveLength(0);
  });
});

describe('zonage rapide', () => {
  it('rectangle et route droite', () => {
    expect(dragTiles({ ax: 2, ay: 2, bx: 4, by: 5, mode: 'rect' })).toHaveLength(12);
    const line = dragTiles({ ax: 1, ay: 1, bx: 6, by: 3, mode: 'line' });
    expect(line).toHaveLength(6);
    expect(line.every(([, y]) => y === 1)).toBe(true);
    expect(dragTiles({ ax: 5, ay: 5, bx: 5, by: 1, mode: 'line' })).toHaveLength(5);
  });
});
