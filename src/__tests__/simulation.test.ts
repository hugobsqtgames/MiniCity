import { createEmptyMap, type Tile } from '../engine/map';
import { DEFAULT_FUNDING, DEFAULT_ORDINANCES, DEFAULT_TAXES, LANDFILL_LIMIT } from '../sim/constants';
import { applyPower, computePowerGrid } from '../sim/power';
import { analyzeCity, computeCoverage, computeDemand, DEFAULT_POLICY, simulateMonth, type Demand, type Policy } from '../sim/simulation';
import { place, seeded, smallCity } from './helpers';

const SIZE = 20;

/** Fait tourner la simulation N mois avec un aléa déterministe. */
function run(tiles: Tile[], months: number, policy: Policy = DEFAULT_POLICY, treasury = 50000) {
  let state = { tiles: applyPower(tiles, SIZE), treasury, demand: { r: 1, c: 0.5, i: 0.5 } as Demand };
  const random = seeded(7);
  let last = null as ReturnType<typeof simulateMonth> | null;
  for (let m = 0; m < months; m++) {
    last = simulateMonth({ ...state, size: SIZE, policy, random });
    state = { tiles: last.tiles, treasury: last.treasury, demand: last.demand };
  }
  return last!;
}

describe('électricité et eau', () => {
  it('le courant suit routes et zones depuis la centrale', () => {
    const tiles = applyPower(smallCity(SIZE), SIZE);
    const grid = computePowerGrid(tiles, SIZE);
    expect(grid[4 * SIZE + 2]).toBe(1); // maison au bout de la rue
    expect(tiles[4 * SIZE + 2].powered).toBe(true);
    // L'eau porte moins loin (12 cases) : la maison du bout de la rue est à sec.
    expect(tiles[4 * SIZE + 8].water).toBe(true);
    expect(tiles[4 * SIZE + 2].water).toBe(false);
  });

  it('sans centrale, rien n’est alimenté', () => {
    const tiles = smallCity(SIZE);
    tiles[4 * SIZE + 15].type = 'GRASS';
    const powered = applyPower(tiles, SIZE);
    expect(powered.some((t) => t.powered)).toBe(false);
    expect(powered.some((t) => t.water)).toBe(false);
  });

  it('une centrale en panne (catastrophe) ne produit plus', () => {
    const tiles = smallCity(SIZE);
    tiles[4 * SIZE + 15].flood = 2;
    expect(applyPower(tiles, SIZE).filter((t) => t.powered).length).toBe(0);
  });
});

describe('croissance de la ville', () => {
  it('les maisons alimentées poussent et la population grandit', () => {
    const res = run(smallCity(SIZE), 18);
    expect(res.stats.population).toBeGreaterThan(0);
    expect(res.tiles.some((t) => t.type === 'R' && t.density >= 2)).toBe(true);
  });

  it('les impôts rapportent de l’argent', () => {
    const res = run(smallCity(SIZE), 18);
    expect(res.income).toBeGreaterThan(0);
  });
});

describe('budget et impôts', () => {
  it('des impôts plus élevés rapportent plus, mais font baisser la demande', () => {
    const tiles = applyPower(smallCity(SIZE), SIZE);
    const stats = analyzeCity(tiles, SIZE).stats;
    const low = computeDemand(stats, { R: 4, C: 4, I: 4 });
    const high = computeDemand(stats, { R: 18, C: 18, I: 18 });
    expect(high.r).toBeLessThan(low.r);
    expect(high.c).toBeLessThan(low.c);
    expect(high.i).toBeLessThan(low.i);
  });

  it('les taxes R/C/I sont indépendantes', () => {
    const tiles = applyPower(smallCity(SIZE), SIZE);
    const stats = analyzeCity(tiles, SIZE).stats;
    const base = computeDemand(stats, DEFAULT_TAXES);
    const onlyI = computeDemand(stats, { ...DEFAULT_TAXES, I: 20 });
    expect(onlyI.i).toBeLessThan(base.i);
    expect(onlyI.r).toBeCloseTo(base.r, 5);
  });

  it('un service sans budget se met en grève et ne couvre plus rien', () => {
    let tiles = place(smallCity(SIZE), SIZE, [[5, 7, 'POLICE']]);
    tiles = applyPower(tiles, SIZE);
    const ok = computeCoverage(tiles, SIZE, DEFAULT_FUNDING).POLICE;
    const strike = computeCoverage(tiles, SIZE, { ...DEFAULT_FUNDING, police: 20 }).POLICE;
    expect(ok.some((v) => v > 0)).toBe(true);
    expect(strike.every((v) => v === 0)).toBe(true);
    expect(analyzeCity(tiles, SIZE, { ...DEFAULT_POLICY, funding: { ...DEFAULT_FUNDING, police: 20 } }).stats.strikes).toContain('police');
  });

  it('les ordonnances coûtent de l’argent chaque mois', () => {
    const city = run(smallCity(SIZE), 18);
    const base = { tiles: city.tiles, size: SIZE, treasury: 10000, demand: city.demand, random: seeded(1) };
    const without = simulateMonth({ ...base, policy: DEFAULT_POLICY });
    const withLaws = simulateMonth({
      ...base,
      random: seeded(1),
      policy: { ...DEFAULT_POLICY, ordinances: { ...DEFAULT_ORDINANCES, freeTransit: true, trees: true } },
    });
    expect(withLaws.expenses).toBeGreaterThan(without.expenses);
  });
});

describe('déchets', () => {
  it('sans décharge, les ordures s’accumulent ; une décharge les ramasse', () => {
    const dirty = run(smallCity(SIZE), 24);
    const clean = run(place(smallCity(SIZE), SIZE, [[12, 6, 'LANDFILL']]), 24);
    const garbage = (ts: Tile[]) => ts.filter((t) => t.type === 'R').reduce((s, t) => s + t.garbage, 0);
    expect(garbage(dirty.tiles)).toBeGreaterThan(garbage(clean.tiles));
    expect(clean.stats.coverage.waste).toBeGreaterThan(0);
    expect(LANDFILL_LIMIT).toBeGreaterThan(0);
  });
});

describe('catastrophes', () => {
  it.each(['earthquake', 'tornado', 'flood', 'blackout'] as const)('%s déclenché à la main', (kind) => {
    // Un petit lac au bord des maisons, pour que l'inondation ait de l'eau.
    const city = run(place(smallCity(SIZE), SIZE, [[4, 2, 'LAKE'], [5, 2, 'LAKE'], [4, 1, 'LAKE']]), 12);
    const res = simulateMonth({ tiles: city.tiles, size: SIZE, treasury: 10000, demand: city.demand, trigger: kind, random: seeded(3) });
    expect(res.events.disasters).toHaveLength(1);
    expect(res.events.disasters[0].kind).toBe(kind);
    expect(res.events.news.length).toBeGreaterThan(0);
  });

  it('pas de catastrophe aléatoire quand l’option est coupée', () => {
    const city = run(smallCity(SIZE), 6);
    for (let k = 0; k < 40; k++) {
      const res = simulateMonth({ tiles: city.tiles, size: SIZE, treasury: 10000, demand: city.demand, disasters: false, random: seeded(k) });
      expect(res.events.disasters).toHaveLength(0);
    }
  });

  it('une panne coupe la centrale pendant quelques mois', () => {
    const city = run(smallCity(SIZE), 12);
    const res = simulateMonth({ tiles: city.tiles, size: SIZE, treasury: 10000, demand: city.demand, trigger: 'blackout', random: seeded(3) });
    expect(res.tiles.find((t) => t.type === 'POWER')!.flood).toBeGreaterThan(0);
  });
});

describe('trafic', () => {
  it('les habitants trouvent un emploi par la route et le trajet est mesuré', () => {
    const res = run(smallCity(SIZE), 24);
    expect(res.stats.commute).toBeGreaterThan(0);
    expect(res.maps.traffic.some((v) => v > 0)).toBe(true);
  });

  it('une carte vide ne plante pas', () => {
    const a = analyzeCity(createEmptyMap(10), 10);
    expect(a.stats.population).toBe(0);
    expect(a.stats.congestion).toBe(0);
  });
});
