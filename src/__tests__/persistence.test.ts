import { createEmptyMap } from '../engine/map';
import { EMPTY_COUNTERS } from '../sim/challenges';
import { DEFAULT_FUNDING, DEFAULT_ORDINANCES } from '../sim/constants';
import { deserialize, EMPTY_HISTORY, makePreview, previewType, serialize, type SavedGame } from '../store/persistence';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock ne peut pas utiliser d'import statique
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

function game(): SavedGame {
  const tiles = createEmptyMap(6);
  tiles[0] = { ...tiles[0], type: 'ROAD', lake: true };
  tiles[1] = { ...tiles[1], type: 'R', density: 3, garbage: 4 };
  tiles[7] = { ...tiles[7], type: 'C', density: 0, value: -1 };
  tiles[2] = { ...tiles[2], type: 'POWER', flood: 2 };
  tiles[3] = { ...tiles[3], type: 'STADIUM' };
  tiles[4] = { ...tiles[4], type: 'FOREST', rad: 3 };
  tiles[5] = { ...tiles[5], type: 'NUCLEAR' };
  tiles[6] = { ...tiles[6], type: 'PORT' };
  return {
    gridSize: 6,
    tiles,
    treasury: 1234,
    month: 17,
    taxes: { R: 5, C: 11, I: 14 },
    funding: { ...DEFAULT_FUNDING, police: 120 },
    ordinances: { ...DEFAULT_ORDINANCES, recycling: true },
    disasters: true,
    demand: { r: 0.1, c: 0.2, i: -0.3 },
    speed: 2,
    history: { ...EMPTY_HISTORY, pop: [1, 2, 3] },
    news: [{ month: 3, icon: '🎉', text: 'Bravo' }],
    rotation: 3,
    cityName: 'Belle-Rive',
    counters: { ...EMPTY_COUNTERS, match: 4 },
    challenges: { start: 2, pop100: 9 },
    isDemo: true,
    weather: 'snow',
    cityEvents: [{ kind: 'match', x: 1, y: 2, venue: 'STADIUM', bonus: 3, tourism: 450 }],
    forcedEvents: [{ x: 3, y: 4 }],
  };
}

describe('sauvegarde locale', () => {
  it('aller-retour sans perte (v2)', () => {
    const g = game();
    const back = deserialize(serialize(g))!;
    expect(back).not.toBeNull();
    expect(back.tiles.map((t) => [t.type, t.density, t.lake, t.garbage, t.flood, t.rad])).toEqual(g.tiles.map((t) => [t.type, t.density, t.lake, t.garbage, t.flood, t.rad]));
    expect(back.cityName).toBe('Belle-Rive');
    expect(back.counters.match).toBe(4);
    expect(back.challenges).toEqual({ start: 2, pop100: 9 });
    expect(back.isDemo).toBe(true);
    expect(back.tiles[7].value).toBe(-1);
    expect(back.weather).toBe('snow');
    expect(back.cityEvents[0].kind).toBe('match');
    expect(back.forcedEvents).toEqual([{ x: 3, y: 4 }]);
    expect(back.taxes).toEqual(g.taxes);
    expect(back.funding.police).toBe(120);
    expect(back.ordinances.recycling).toBe(true);
    expect(back.rotation).toBe(3);
    expect(back.history.pop).toEqual([1, 2, 3]);
    expect(back.news[0].text).toBe('Bravo');
  });

  it('relit une ancienne sauvegarde v1 (taux d’impôt unique)', () => {
    const v1 = JSON.stringify({
      v: 1,
      savedAt: 0,
      gridSize: 2,
      types: '=rcp',
      density: '0210',
      treasury: 500,
      month: 4,
      taxRate: 12,
      demand: { r: 0, c: 0, i: 0 },
      speed: 1,
    });
    const g = deserialize(v1)!;
    expect(g.tiles.map((t) => t.type)).toEqual(['ROAD', 'R', 'C', 'POWER']);
    expect(g.taxes).toEqual({ R: 12, C: 12, I: 12 });
    expect(g.funding).toEqual(DEFAULT_FUNDING);
    expect(g.rotation).toBe(0);
    expect(g.challenges).toEqual({});
    expect(g.counters.events).toBe(0);
  });

  it('fabrique un aperçu sous-échantillonné pour les emplacements', () => {
    const tiles = createEmptyMap(100);
    tiles[0] = { ...tiles[0], type: 'ROAD' };
    const { preview, previewSize } = makePreview(tiles, 100);
    expect(previewSize).toBe(50);
    expect(preview.length).toBe(2500);
    expect(previewType(preview[0])).toBe('ROAD');
  });

  it('refuse un fichier corrompu', () => {
    expect(deserialize('{pas du json')).toBeNull();
    expect(deserialize(JSON.stringify({ v: 2, gridSize: 3, types: 'gg', density: '00' }))).toBeNull();
  });
});
