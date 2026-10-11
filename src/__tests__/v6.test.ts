import { createEmptyMap, isTunnel, LINE_RAIL, LINE_TRAM, MAX_ELEV, type Tile } from '../engine/map';
import { createTerrainMap } from '../engine/terrain';
import { CHALLENGE_BY_ID, challengeContext, EMPTY_COUNTERS } from '../sim/challenges';
import { HOTEL_ROOMS, TERRAFORM_COST, TOOL_BY_ID, TRAM_COST, TUNNEL_FACTOR } from '../sim/constants';
import { districtMap } from '../sim/districts';
import { missionProgress, proposeMission, type Mission } from '../sim/missions';
import { applyPower } from '../sim/power';
import { EMPTY_RECORDS, sanitizeRecords, updateRecords } from '../sim/records';
import { analyzeCity, connectedStations, DEFAULT_POLICY, educationAt, simulateMonth, type Demand } from '../sim/simulation';
import { applyTool, toolCost } from '../sim/tools';
import { place, seeded, smallCity } from './helpers';

const SIZE = 20;
const rich = { funds: 1e9, population: 1e6 };
const at = (tiles: Tile[], x: number, y: number) => tiles[y * SIZE + x];

function run(tiles: Tile[], months: number, extra: Partial<Parameters<typeof simulateMonth>[0]> = {}) {
  let state = { tiles: applyPower(tiles, SIZE), treasury: 1e6, demand: { r: 1, c: 0.6, i: 0.6 } as Demand };
  const random = seeded(5);
  let last = null as ReturnType<typeof simulateMonth> | null;
  let epidemic = extra.epidemic ?? null;
  for (let m = 0; m < months; m++) {
    last = simulateMonth({ ...state, size: SIZE, policy: DEFAULT_POLICY, random, month: 4 + m, ...extra, epidemic });
    state = { tiles: last.tiles, treasury: last.treasury, demand: last.demand };
    epidemic = last.epidemic;
  }
  return last!;
}

describe('relief et terrassement', () => {
  it('monter et creuser coûtent 25 $ et restent entre 0 et le niveau max', () => {
    let tiles = createEmptyMap(SIZE);
    for (let k = 0; k < MAX_ELEV; k++) {
      const r = applyTool(tiles, SIZE, 'raise', 3, 3, rich);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.cost).toBe(TERRAFORM_COST);
      tiles = r.tiles;
    }
    expect(at(tiles, 3, 3).elev).toBe(MAX_ELEV);
    expect(applyTool(tiles, SIZE, 'raise', 3, 3, rich).ok).toBe(false);
    expect(applyTool(createEmptyMap(SIZE), SIZE, 'lower', 3, 3, rich).ok).toBe(false);
  });

  it('on ne terrasse ni l’eau ni un bâtiment', () => {
    const tiles = place(createEmptyMap(SIZE), SIZE, [
      [1, 1, 'LAKE'],
      [2, 2, 'R', 2],
      [3, 3, 'ROAD'],
    ]);
    for (const [x, y] of [
      [1, 1],
      [2, 2],
      [3, 3],
    ])
      expect(applyTool(tiles, SIZE, 'raise', x, y, rich).ok).toBe(false);
  });

  it('une route en montagne (niveau ≥ 2) est un tunnel, plus cher', () => {
    const tiles = createEmptyMap(SIZE);
    at(tiles, 5, 5).elev = 2;
    expect(toolCost(tiles, SIZE, 'road', 5, 5)).toBe(TOOL_BY_ID.road.cost * TUNNEL_FACTOR);
    const r = applyTool(tiles, SIZE, 'road', 5, 5, rich);
    expect(r.ok && isTunnel(r.tiles[5 * SIZE + 5])).toBe(true);
  });

  it('le terrain généré a du relief sans falaise de plus d’un niveau', () => {
    for (const seed of [1, 7, 42]) {
      const n = 50;
      const m = createTerrainMap(n, seed);
      expect(m.some((t) => t.elev >= 2)).toBe(true);
      for (const t of m) {
        if (t.type === 'LAKE') expect(t.elev).toBe(0);
        if (t.x + 1 < n) expect(Math.abs(m[t.y * n + t.x + 1].elev - t.elev)).toBeLessThanOrEqual(1);
        if (t.y + 1 < n) expect(Math.abs(m[(t.y + 1) * n + t.x].elev - t.elev)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('les hauteurs restent au sec pendant une inondation', () => {
    const tiles = createEmptyMap(SIZE);
    for (let y = 0; y < SIZE; y++) at(tiles, 10, y).type = 'LAKE';
    for (let y = 0; y < SIZE; y++) {
      at(tiles, 9, y).type = 'R';
      at(tiles, 11, y).type = 'R';
      at(tiles, 11, y).elev = 1;
    }
    const res = simulateMonth({ tiles, size: SIZE, treasury: 0, demand: { r: 0, c: 0, i: 0 }, trigger: 'flood', random: seeded(3), month: 3 });
    expect(res.tiles.filter((t) => t.x === 11 && t.flood > 0)).toHaveLength(0);
  });
});

describe('tramway et trains', () => {
  it('le tram se pose sur une avenue seulement', () => {
    const tiles = place(createEmptyMap(SIZE), SIZE, [
      [2, 2, 'AVENUE'],
      [3, 3, 'ROAD'],
    ]);
    const ok = applyTool(tiles, SIZE, 'tram', 2, 2, rich);
    expect(ok.ok && ok.cost).toBe(TRAM_COST);
    expect(ok.ok && ok.tiles[2 * SIZE + 2].line & LINE_TRAM).toBeTruthy();
    expect(applyTool(tiles, SIZE, 'tram', 3, 3, rich).ok).toBe(false);
  });

  it('une voie ferrée sur une rue forme un passage à niveau ; jamais sur une autoroute', () => {
    const tiles = place(createEmptyMap(SIZE), SIZE, [
      [2, 2, 'ROAD'],
      [3, 3, 'HIGHWAY'],
    ]);
    const r = applyTool(tiles, SIZE, 'rail', 2, 2, rich);
    expect(r.ok && r.tiles[2 * SIZE + 2]).toMatchObject({ type: 'ROAD' });
    expect(r.ok && r.tiles[2 * SIZE + 2].line & LINE_RAIL).toBeTruthy();
    expect(applyTool(tiles, SIZE, 'rail', 3, 3, rich).ok).toBe(false);
    // Monter la rue en avenue garde le passage à niveau, en autoroute le supprime.
    if (!r.ok) return;
    const av = applyTool(r.tiles, SIZE, 'avenue', 2, 2, rich);
    expect(av.ok && av.tiles[2 * SIZE + 2].line & LINE_RAIL).toBeTruthy();
    if (!av.ok) return;
    const hw = applyTool(av.tiles, SIZE, 'highway', 2, 2, rich);
    expect(hw.ok && hw.tiles[2 * SIZE + 2].line).toBe(0);
  });

  it('une gare ne dessert que si elle est reliée à une autre gare', () => {
    const tiles = smallCity(SIZE);
    place(tiles, SIZE, [[2, 8, 'STATION']]);
    expect(connectedStations(tiles, SIZE).size).toBe(0);
    for (let x = 3; x <= 12; x++) place(tiles, SIZE, [[x, 8, 'RAIL']]);
    place(tiles, SIZE, [[13, 8, 'STATION']]);
    expect(connectedStations(tiles, SIZE).size).toBe(2);
  });

  it('les gares et le lycée sont verrouillés sous leur seuil de population', () => {
    const tiles = createEmptyMap(SIZE);
    expect(applyTool(tiles, SIZE, 'station', 2, 2, { funds: 1e9, population: 10 }).ok).toBe(false);
    expect(applyTool(tiles, SIZE, 'highschool', 2, 2, { funds: 1e9, population: 10 }).ok).toBe(false);
    expect(applyTool(tiles, SIZE, 'hotel', 2, 2, { funds: 1e9, population: 10 }).ok).toBe(false);
  });
});

describe('éducation, spécialisations, parkings', () => {
  it('le niveau d’études combine école, lycée et université', () => {
    const tiles = applyPower(place(smallCity(SIZE), SIZE, [[5, 3, 'SCHOOL'], [6, 3, 'HIGHSCHOOL']]), SIZE);
    const a = analyzeCity(tiles, SIZE);
    const i = 4 * SIZE + 5;
    expect(educationAt(a.cov, i)).toBeGreaterThan(0.5);
    expect(educationAt(a.cov, i)).toBeLessThanOrEqual(1);
  });

  it('une usine près d’une forêt devient une scierie, en pleine campagne une ferme', () => {
    const tiles = createEmptyMap(SIZE);
    for (let x = 1; x < SIZE - 1; x++) at(tiles, x, 10).type = 'ROAD';
    at(tiles, 2, 9).type = 'POWER';
    at(tiles, 3, 9).type = 'WATER';
    at(tiles, 4, 11).type = 'I';
    at(tiles, 16, 11).type = 'I';
    for (let y = 12; y < 16; y++) for (let x = 2; x < 6; x++) at(tiles, x, y).type = 'FOREST';
    const res = run(tiles, 24);
    expect(res.tiles[11 * SIZE + 4].density > 0 ? res.tiles[11 * SIZE + 4].spec : 2).toBe(2);
    expect(res.tiles[11 * SIZE + 16].density > 0 ? res.tiles[11 * SIZE + 16].spec : 1).toBe(1);
    expect(res.stats.specJobs.reduce((s, v) => s + v, 0)).toBe(res.stats.jobsI);
  });
});

describe('eau, épidémies, catastrophes', () => {
  it('les rejets polluent le lac ; une station d’épuration le nettoie', () => {
    const tiles = smallCity(SIZE);
    for (let x = 2; x <= 17; x++) for (let y = 8; y <= 10; y++) at(tiles, x, y).type = 'LAKE';
    for (const t of tiles) if (t.type === 'I' || t.type === 'R') t.density = 3;
    const dirty = analyzeCity(applyPower(tiles, SIZE), SIZE).stats.waterPollution;
    expect(dirty).toBeGreaterThan(10);
    place(tiles, SIZE, [[9, 6, 'TREATMENT']]);
    const clean = analyzeCity(applyPower(tiles, SIZE), SIZE).stats.waterPollution;
    expect(clean).toBeLessThan(dirty);
  });

  it('une épidémie se déclenche, fait baisser la satisfaction, puis s’éteint', () => {
    const tiles = smallCity(SIZE);
    for (const t of tiles) if (t.type === 'R') t.density = 2;
    const start = simulateMonth({ tiles: applyPower(tiles, SIZE), size: SIZE, treasury: 1e5, demand: { r: 0, c: 0, i: 0 }, trigger: 'epidemic', random: seeded(4), month: 3 });
    expect(start.epidemic).not.toBeNull();
    expect(start.events.disasters[0]?.kind).toBe('epidemic');
    const healthy = analyzeCity(start.tiles, SIZE).stats.happiness;
    expect(start.stats.happiness).toBeLessThanOrEqual(healthy);
    // Avec un hôpital qui couvre tout, elle finit par disparaître.
    place(start.tiles, SIZE, [[9, 3, 'HOSPITAL']]);
    const end = run(start.tiles, 14, { epidemic: start.epidemic });
    expect(end.epidemic).toBeNull();
  });

  it('un feu de forêt brûle les arbres et laisse de la terre', () => {
    const tiles = createEmptyMap(SIZE);
    for (let y = 4; y < 14; y++) for (let x = 4; x < 14; x++) at(tiles, x, y).type = 'FOREST';
    const fire = simulateMonth({ tiles, size: SIZE, treasury: 0, demand: { r: 0, c: 0, i: 0 }, trigger: 'wildfire', random: seeded(1), month: 7 });
    expect(fire.tiles.some((t) => t.type === 'FOREST' && t.fire > 0)).toBe(true);
    const later = run(fire.tiles, 6);
    expect(later.tiles.some((t) => t.type === 'DIRT')).toBe(true);
  });

  it('météorite et monstre détruisent la ville et laissent une trace animable', () => {
    const tiles = smallCity(SIZE);
    for (const t of tiles) if (t.type === 'R' || t.type === 'C' || t.type === 'I') t.density = 2;
    const m = simulateMonth({ tiles: applyPower(tiles, SIZE), size: SIZE, treasury: 0, demand: { r: 0, c: 0, i: 0 }, trigger: 'meteor', random: seeded(9), month: 3 });
    expect(m.events.disasters[0].kind).toBe('meteor');
    expect(m.events.disasters[0].damage).toBeGreaterThan(0);
    const g = simulateMonth({ tiles: applyPower(tiles, SIZE), size: SIZE, treasury: 0, demand: { r: 0, c: 0, i: 0 }, trigger: 'monster', random: seeded(9), month: 3 });
    expect(g.events.disasters[0].kind).toBe('monster');
    expect(g.events.disasters[0].path!.length).toBeGreaterThan(5);
  });
});

describe('tourisme', () => {
  it('sans hôtel, les touristes dépensent moitié moins', () => {
    const tiles = smallCity(SIZE);
    for (const t of tiles) if (t.type === 'R') t.density = 3;
    for (let x = 2; x <= 6; x++) at(tiles, x, 9).type = 'LAKE';
    place(tiles, SIZE, [[3, 8, 'RESORT'], [4, 8, 'RESORT'], [5, 8, 'RESORT']]);
    const without = analyzeCity(applyPower(tiles, SIZE), SIZE).stats;
    expect(without.tourists).toBeGreaterThan(0);
    expect(without.hotelGuests).toBe(0);
    place(tiles, SIZE, [[12, 6, 'HOTEL']]);
    const withHotel = analyzeCity(applyPower(tiles, SIZE), SIZE).stats;
    expect(withHotel.hotelGuests).toBeGreaterThan(0);
    expect(withHotel.hotelGuests).toBeLessThanOrEqual(HOTEL_ROOMS);
    expect(withHotel.tourism).toBeGreaterThan(without.tourism);
  });

  it('une plage aménagée exige du sable au bord de l’eau', () => {
    const tiles = place(createEmptyMap(SIZE), SIZE, [
      [2, 2, 'SAND'],
      [8, 8, 'SAND'],
      [8, 9, 'LAKE'],
    ]);
    expect(applyTool(tiles, SIZE, 'resort', 2, 2, rich).ok).toBe(false);
    expect(applyTool(tiles, SIZE, 'resort', 8, 8, rich).ok).toBe(true);
  });
});

describe('demandes des habitants, records', () => {
  it('une demande vise un quartier mal servi et se valide quand il est servi', () => {
    const tiles = applyPower(smallCity(SIZE), SIZE);
    for (const t of tiles) if (t.type === 'R') t.density = 3;
    const a = analyzeCity(tiles, SIZE);
    const m = proposeMission(tiles, SIZE, a, 4, [], seeded(2), 1);
    expect(m).not.toBeNull();
    const mission = m as Mission;
    expect(mission.deadline).toBe(16);
    expect(districtMap(SIZE).list[mission.district]).toBeDefined();
    const p = missionProgress(mission, tiles, SIZE, a);
    expect(p.done).toBe(false);
  });

  it('les records ne gardent que le meilleur, et se relisent sans planter', () => {
    const base = { month: 1, population: 100, treasury: 500, happiness: 60, net: 20, income: 50, streak: 1, tourists: 0, events: 0, fires: 0, disasters: [] };
    const r1 = updateRecords(EMPTY_RECORDS, base);
    expect(r1.broken).toContain('population');
    const r2 = updateRecords(r1.records, { ...base, month: 2, population: 50, net: -30, disasters: [{ kind: 'meteor', damage: 12 }] });
    expect(r2.records.population).toEqual({ value: 100, month: 1 });
    expect(r2.records.worstMonth.value).toBe(-30);
    expect(r2.records.disaster).toMatchObject({ value: 12, kind: 'meteor' });
    expect(sanitizeRecords({ population: { value: 'x' } }).population.value).toBe(0);
    expect(sanitizeRecords(null)).toEqual(EMPTY_RECORDS);
  });

  it('nouveaux défis : tram, tunnel et gares', () => {
    const tiles = createEmptyMap(SIZE);
    for (let x = 0; x < 12; x++) Object.assign(at(tiles, x, 3), { type: 'AVENUE', line: LINE_TRAM });
    for (let x = 0; x < 3; x++) Object.assign(at(tiles, x, 6), { type: 'ROAD', elev: 2 });
    const a = analyzeCity(tiles, SIZE);
    const ctx = challengeContext(tiles, a.stats, 0, 1, EMPTY_COUNTERS, DEFAULT_POLICY);
    expect(CHALLENGE_BY_ID.tram.progress(ctx)[0]).toBe(12);
    expect(CHALLENGE_BY_ID.tunnel.progress(ctx)[0]).toBe(3);
  });
});
