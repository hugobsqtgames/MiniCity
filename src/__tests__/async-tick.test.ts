/**
 * Le mois est calculé par tranches (l'écran ne fige pas). Ce que le joueur
 * construit pendant le calcul ne doit pas être perdu, ni son argent compté deux fois.
 */
import { useGameStore } from '../store/useGameStore';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock ne peut pas utiliser d'import statique
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../audio/sound', () => ({ playSfx: jest.fn(), setAmbience: jest.fn(), initAudio: jest.fn(async () => {}) }));
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
  NotificationFeedbackType: { Warning: 'w', Error: 'e', Success: 's' },
}));
jest.mock('../engine/cameraBridge', () => ({ focusTile: jest.fn() }));

describe('mois calculé par tranches', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('une construction faite pendant le calcul est gardée et payée une seule fois', () => {
    jest.useFakeTimers();
    // Horloge qui avance à chaque lecture : le calcul est forcément découpé en plusieurs tranches.
    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => (now += 4));
    const store = useGameStore;
    store.getState().hydrate(null);
    store.getState().loadDemoCity();
    store.setState({ paused: false, treasury: 100000 });
    const s = store.getState();
    const month = s.month;
    // Une case d'herbe libre pour y poser une rue.
    const free = s.tiles.find((t) => t.type === 'GRASS' && t.x > 2 && t.y > 2)!;
    s.tick();
    // Le calcul n'est pas fini : le mois n'a pas encore avancé.
    expect(store.getState().month).toBe(month);
    store.getState().setTool('road');
    const before = store.getState().treasury;
    store.getState().tapTile(free.x, free.y);
    const spent = before - store.getState().treasury;
    expect(spent).toBeGreaterThan(0);
    // Un second tick pendant le calcul est ignoré (pas de mois en double).
    store.getState().tick();
    jest.runAllTimers();
    const after = store.getState();
    expect(after.month).toBe(month + 1);
    expect(after.tiles[free.y * after.gridSize + free.x].type).toBe('ROAD');
    // Caisse = caisse au départ − rue + bilan du mois (une seule fois).
    expect(after.treasury).toBe(100000 - spent + after.lastIncome - after.lastExpenses);
  });

  it('changer de ville pendant le calcul annule le mois en cours', () => {
    jest.useFakeTimers();
    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => (now += 4));
    const store = useGameStore;
    store.getState().hydrate(null);
    store.getState().loadDemoCity();
    store.setState({ paused: false });
    store.getState().tick();
    store.getState().newCity(20);
    jest.runAllTimers();
    expect(store.getState().month).toBe(0);
    expect(store.getState().gridSize).toBe(20);
  });
});
