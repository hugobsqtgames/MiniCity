import { createEmptyMap } from '../engine/map';
import { BRIDGE_FACTOR, CLEAR_FOREST_COST, applyTool, gridLine, toolCost } from '../sim/tools';
import { MONUMENT_UNLOCK, TOOL_BY_ID } from '../sim/constants';
import { place } from './helpers';

const SIZE = 10;
const rich = { funds: 1e9, population: 1e6 };

describe('outils de construction', () => {
  it('une route sur l’eau devient un pont, plus cher', () => {
    const tiles = place(createEmptyMap(SIZE), SIZE, [[3, 3, 'LAKE']]);
    const res = applyTool(tiles, SIZE, 'road', 3, 3, rich);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cost).toBe(TOOL_BY_ID.road.cost * BRIDGE_FACTOR);
    expect(res.tiles[3 * SIZE + 3]).toMatchObject({ type: 'ROAD', lake: true });
    // Raser le pont rend l'eau.
    const back = applyTool(res.tiles, SIZE, 'bulldoze', 3, 3, rich);
    expect(back.ok && back.tiles[3 * SIZE + 3].type).toBe('LAKE');
  });

  it('on ne construit pas de bâtiment sur l’eau', () => {
    const tiles = place(createEmptyMap(SIZE), SIZE, [[3, 3, 'LAKE']]);
    expect(applyTool(tiles, SIZE, 'zoneR', 3, 3, rich).ok).toBe(false);
  });

  it('une rue peut monter en gamme (avenue, autoroute) mais pas l’inverse', () => {
    const tiles = place(createEmptyMap(SIZE), SIZE, [[2, 2, 'ROAD']]);
    const up = applyTool(tiles, SIZE, 'avenue', 2, 2, rich);
    expect(up.ok && up.tiles[2 * SIZE + 2].type).toBe('AVENUE');
    if (!up.ok) return;
    expect(applyTool(up.tiles, SIZE, 'road', 2, 2, rich).ok).toBe(false);
  });

  it('la forêt est défrichée automatiquement (petit surcoût)', () => {
    const tiles = place(createEmptyMap(SIZE), SIZE, [[1, 1, 'FOREST']]);
    expect(toolCost(tiles, SIZE, 'zoneR', 1, 1)).toBe(TOOL_BY_ID.zoneR.cost + CLEAR_FOREST_COST);
    const res = applyTool(tiles, SIZE, 'zoneR', 1, 1, rich);
    expect(res.ok && res.tiles[SIZE + 1].type).toBe('R');
  });

  it('le château d’eau coûte moitié prix au bord d’un lac', () => {
    const tiles = place(createEmptyMap(SIZE), SIZE, [[5, 5, 'LAKE']]);
    expect(toolCost(tiles, SIZE, 'water', 5, 6)).toBe(Math.round(TOOL_BY_ID.water.cost / 2));
    expect(toolCost(tiles, SIZE, 'water', 1, 1)).toBe(TOOL_BY_ID.water.cost);
  });

  it('les monuments sont débloqués par la population, en un seul exemplaire', () => {
    const tiles = createEmptyMap(SIZE);
    const poor = applyTool(tiles, SIZE, 'stadium', 1, 1, { funds: 1e9, population: MONUMENT_UNLOCK.STADIUM - 1 });
    expect(poor.ok).toBe(false);
    const ok = applyTool(tiles, SIZE, 'stadium', 1, 1, { funds: 1e9, population: MONUMENT_UNLOCK.STADIUM });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(applyTool(ok.tiles, SIZE, 'stadium', 4, 4, rich).ok).toBe(false);
  });

  it('refuse sans fonds suffisants', () => {
    const res = applyTool(createEmptyMap(SIZE), SIZE, 'power', 1, 1, { funds: 10, population: 0 });
    expect(res.ok).toBe(false);
  });

  it('gridLine relie deux points sans diagonale', () => {
    const line = gridLine(0, 0, 3, 2);
    expect(line[0]).toEqual([0, 0]);
    expect(line[line.length - 1]).toEqual([3, 2]);
    for (let i = 1; i < line.length; i++) {
      const d = Math.abs(line[i][0] - line[i - 1][0]) + Math.abs(line[i][1] - line[i - 1][1]);
      expect(d).toBe(1);
    }
  });
});
