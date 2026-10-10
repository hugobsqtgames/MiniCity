import { getOrigin, gridToWorld, screenToTile, worldToGridFloat } from '../engine/iso';
import { createEmptyMap } from '../engine/map';
import { fromView, pointFromView, pointToView, remapToView, RotatedTiles, toView, vectorToView } from '../engine/rotation';
import { createTerrainMap, mulberry32 } from '../engine/terrain';
import { GREEN_TIME, LIGHT_GREEN, LIGHT_PERIOD, LIGHT_RED, lightState } from '../engine/traffic';

describe('projection isométrique 2:1', () => {
  const origin = getOrigin(50);

  it('respecte la formule imposée', () => {
    const p = gridToWorld(3, 1, origin);
    expect(p.x).toBe(origin.originX + (3 - 1) * 32);
    expect(p.y).toBe(origin.originY + (3 + 1) * 16);
  });

  it('la projection inverse retrouve la grille', () => {
    for (const [x, y] of [
      [0, 0],
      [12.5, 7.25],
      [49, 3],
    ]) {
      const w = gridToWorld(x, y, origin);
      const g = worldToGridFloat(w.x, w.y, origin);
      expect(g.x).toBeCloseTo(x, 6);
      expect(g.y).toBeCloseTo(y, 6);
    }
  });

  it('un toucher au centre d’un losange tombe sur la bonne tuile', () => {
    const w = gridToWorld(10.5, 20.5, origin);
    expect(screenToTile(w.x, w.y, 0, 0, 1, 50)).toEqual({ x: 10, y: 20 });
  });
});

describe('rotation de la vue', () => {
  it('quatre quarts de tour reviennent au départ', () => {
    for (let r = 0; r < 4; r++) {
      const [vx, vy] = toView(3, 7, 20, r);
      expect(fromView(vx, vy, 20, r)).toEqual([3, 7]);
    }
    expect(toView(3, 7, 20, 1)).toEqual([20 - 1 - 7, 3]);
    expect(toView(3, 7, 20, 4)).toEqual([3, 7]);
  });

  it('les points continus et les vecteurs tournent de façon cohérente', () => {
    const [a, b] = pointToView(2.5, 4.25, 10, 3);
    const back = pointFromView(a, b, 10, 3);
    expect(back[0]).toBeCloseTo(2.5);
    expect(back[1]).toBeCloseTo(4.25);
    expect(vectorToView(1, 0, 1)).toEqual([-0, 1]);
  });

  it('RotatedTiles réutilise les tuiles non modifiées', () => {
    const tiles = createEmptyMap(8);
    const rt = new RotatedTiles();
    const v1 = rt.get(tiles, 8, 1);
    const changed = tiles.slice();
    changed[5] = { ...tiles[5], type: 'ROAD' };
    const v2 = rt.get(changed, 8, 1);
    const [x, y] = toView(5, 0, 8, 1);
    expect(v2[y * 8 + x].type).toBe('ROAD');
    expect(v2[y * 8 + x]).not.toBe(v1[y * 8 + x]);
    const [ox, oy] = toView(0, 0, 8, 1);
    expect(v2[oy * 8 + ox]).toBe(v1[oy * 8 + ox]);
  });

  it('remapToView place chaque valeur sous sa tuile tournée', () => {
    const v = new Float32Array(16);
    v[1 * 4 + 2] = 7; // (2, 1)
    const out = remapToView(v, 4, 1);
    const [x, y] = toView(2, 1, 4, 1);
    expect(out[y * 4 + x]).toBe(7);
  });
});

describe('terrain naturel', () => {
  it('est déterministe pour une graine donnée', () => {
    const a = createTerrainMap(60, 1234).map((t) => t.type).join();
    const b = createTerrainMap(60, 1234).map((t) => t.type).join();
    expect(a).toBe(b);
  });

  it('contient de l’eau, de la forêt et un centre constructible', () => {
    const size = 100;
    const tiles = createTerrainMap(size, 77);
    const count = (type: string) => tiles.filter((t) => t.type === type).length;
    expect(count('LAKE')).toBeGreaterThan(50);
    expect(count('FOREST')).toBeGreaterThan(50);
    const c = tiles[50 * size + 50];
    expect(['GRASS', 'DIRT', 'SAND']).toContain(c.type);
  });

  it('mulberry32 produit des nombres dans [0, 1[', () => {
    const r = mulberry32(9);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('feux tricolores', () => {
  it('les deux axes ne sont jamais verts en même temps', () => {
    for (let t = 0; t < LIGHT_PERIOD * 3; t += 0.05) {
      const x = lightState(t, 1.3, 0);
      const y = lightState(t, 1.3, 1);
      expect(x === LIGHT_GREEN && y === LIGHT_GREEN).toBe(false);
    }
  });

  it('chaque axe passe au vert puis au rouge à chaque cycle', () => {
    expect(lightState(0, 0, 0)).toBe(LIGHT_GREEN);
    expect(lightState(GREEN_TIME + 1, 0, 0)).toBe(LIGHT_RED);
    expect(lightState(GREEN_TIME + 1, 0, 1)).toBe(LIGHT_GREEN);
  });
});
