/**
 * Monkey test du store : des milliers d'actions au hasard (outils, glissers,
 * annuler / rétablir, mois qui passent, rotation, budget, catastrophes,
 * sauvegarde / rechargement…). Après chaque action, la ville doit rester valide.
 */
import { applyPower } from '../sim/power';
import { TOOLS } from '../sim/constants';
import { deserialize, serialize } from '../store/persistence';
import { useGameStore, type MenuTab } from '../store/useGameStore';
import { int, pick, rng, statsProblems, tileProblems } from './fuzzlib';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock ne peut pas utiliser d'import statique
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../audio/sound', () => ({ playSfx: jest.fn(), setAmbience: jest.fn(), initAudio: jest.fn(async () => {}) }));
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
  NotificationFeedbackType: { Warning: 'w', Error: 'e', Success: 's' },
}));
jest.mock('../engine/cameraBridge', () => ({ focusTile: jest.fn() }));

const TABS: (MenuTab | null)[] = [null, 'advisors', 'city', 'districts', 'budget', 'laws', 'events', 'news', 'charts', 'records', 'settings'];
const KINDS = ['earthquake', 'flood', 'tornado', 'blackout', 'meltdown', 'wildfire', 'meteor', 'monster', 'epidemic'] as const;

function check(step: string) {
  const s = useGameStore.getState();
  const p = tileProblems(s.tiles, s.gridSize);
  if (p.length) throw new Error(`${step} : ${p.join(' ; ')}`);
  const sp = statsProblems(s.stats);
  if (sp.length) throw new Error(`${step} stats : ${sp.join(' ; ')}`);
  if (!Number.isFinite(s.treasury)) throw new Error(`${step} : caisse ${s.treasury}`);
  if (s.past.length > 40) throw new Error(`${step} : historique d'annulation trop long`);
  if (s.rotation < 0 || s.rotation > 3) throw new Error(`${step} : rotation ${s.rotation}`);
  if (s.timelapse.length > 80) throw new Error(`${step} : timelapse trop long`);
  if (s.missions.length > 2) throw new Error(`${step} : trop de missions`);
}

/** Tuiles comparables (sans les réseaux, recalculés à chaque fois). */
const shape = (tiles: { type: string; density: number; elev: number; line: number; lake: boolean }[]) => tiles.map((t) => `${t.type}:${t.density}:${t.elev}:${t.line}:${t.lake}`).join('|');

// Campagne longue : MONKEY_SEEDS=20 MONKEY_STEPS=5000 npx jest monkey
const SEEDS = Number(process.env.MONKEY_SEEDS ?? 2);
const STEPS = Number(process.env.MONKEY_STEPS ?? 700);

describe('monkey test du store', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`graine ${seed} : ${STEPS} actions au hasard sans état invalide`, () => {
      const r = rng(seed * 7919);
      const store = useGameStore;
      store.getState().hydrate(null);
      store.getState().newCity(20);
      store.setState({ treasury: 200000 });
      for (let step = 0; step < STEPS; step++) {
        const s = store.getState();
        const n = s.gridSize;
        const x = int(r, -1, n);
        const y = int(r, -1, n);
        const roll = r();
        const label = `graine ${seed} étape ${step}`;
        if (roll < 0.2) s.setTool(pick(r, TOOLS).id);
        else if (roll < 0.35) s.tapTile(Math.max(0, Math.min(n - 1, x)), Math.max(0, Math.min(n - 1, y)));
        else if (roll < 0.45) {
          // Glisser : début, quelques mouvements, fin.
          s.paintStart(Math.max(0, Math.min(n - 1, x)), Math.max(0, Math.min(n - 1, y)));
          for (let k = 0; k < int(r, 0, 6); k++) store.getState().paintMove(int(r, 0, n - 1), int(r, 0, n - 1));
          store.getState().paintEnd();
        } else if (roll < 0.5) {
          // Action puis annulation immédiate : la carte doit revenir exactement à l'état d'avant.
          const before = shape(store.getState().tiles);
          const money = store.getState().treasury;
          const pastLen = store.getState().past.length;
          store.getState().tapTile(int(r, 0, n - 1), int(r, 0, n - 1));
          if (store.getState().past.length > pastLen) {
            store.getState().undo();
            if (shape(store.getState().tiles) !== before) throw new Error(`${label} : l’annulation ne restaure pas la carte`);
            if (Math.abs(store.getState().treasury - money) > 1) throw new Error(`${label} : remboursement ${money} → ${store.getState().treasury}`);
            store.getState().redo();
          }
        } else if (roll < 0.56) s.undo();
        else if (roll < 0.6) s.redo();
        else if (roll < 0.78) s.tick();
        else if (roll < 0.8) s.rotate(r() < 0.5 ? 1 : -1);
        else if (roll < 0.82) s.setTax(pick(r, ['R', 'C', 'I'] as const), int(r, -5, 30));
        else if (roll < 0.84) s.setFunding(pick(r, ['police', 'fire', 'health', 'education', 'transport', 'utilities', 'waste'] as const), int(r, -50, 200));
        else if (roll < 0.85) s.setDisasters(r() < 0.5);
        else if (roll < 0.86) s.setFunDisasters(r() < 0.5);
        else if (roll < 0.875) s.triggerDisaster(pick(r, KINDS));
        else if (roll < 0.885) s.organizeEvent(int(r, 0, n - 1), int(r, 0, n - 1));
        else if (roll < 0.9) s.openMenu(pick(r, TABS));
        else if (roll < 0.905) s.openTimelapse(r() < 0.5);
        else if (roll < 0.91) s.togglePause();
        else if (roll < 0.92) {
          // Sauvegarde puis rechargement.
          const back = deserialize(serialize(s.snapshot()));
          if (!back) throw new Error(`${label} : sauvegarde illisible`);
          const before = shape(applyPower(s.tiles, n, s.month));
          s.hydrate(back);
          if (shape(store.getState().tiles) !== before) throw new Error(`${label} : la carte change au rechargement`);
        } else if (roll < 0.925) s.newCity(pick(r, [12, 20]));
        else if (roll < 0.93) s.loadDemoCity();
        else if (roll < 0.95) s.focusOn(int(r, 0, n - 1), int(r, 0, n - 1));
        else s.setSpeed(pick(r, [1, 2, 3] as const));
        check(label);
      }
    }, 600000);
  }
});
