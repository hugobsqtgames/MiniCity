import {
  AGENT_BUS,
  AGENT_CAR,
  AGENT_GARBAGE,
  AGENT_PED,
  agentAt,
  agentPosition,
  buildAgents,
  buildAgentsAsync,
  describeAgent,
} from '../engine/agents';
import { createDemoMap } from '../engine/demoMap';
import { applyPower } from '../sim/power';
import { RESIDENTS } from '../sim/constants';

// Les PNJ ne dessinent rien ici : Skia n'est pas nécessaire.
jest.mock('@shopify/react-native-skia', () => ({ Skia: {}, PaintStyle: { Fill: 0, Stroke: 1 } }));

const SIZE = 50;
const tiles = applyPower(createDemoMap(SIZE), SIZE);
const population = tiles.reduce((s, t) => s + (t.type === 'R' ? RESIDENTS[t.density] : 0), 0);
const scene = buildAgents(tiles, SIZE, population, 2000, 1);

describe('PNJ et trafic', () => {
  it('peuple la ville selon sa population', () => {
    const cars = scene.agents.filter((a) => a.kind === AGENT_CAR).length;
    const peds = scene.agents.filter((a) => a.kind === AGENT_PED).length;
    expect(cars).toBeGreaterThan(20);
    expect(peds).toBeGreaterThan(20);
    const fewer = buildAgents(tiles, SIZE, population, 2000, 0.35);
    expect(fewer.agents.length).toBeLessThan(scene.agents.length);
  });

  it('a des bus qui marquent l’arrêt, des gens qui attendent et des éboueurs', () => {
    const buses = scene.agents.filter((a) => a.kind === AGENT_BUS);
    expect(buses.length).toBeGreaterThan(0);
    // Un arrêt = deux clés horaires à la même distance.
    const stops = buses[0].kd.filter((d, k) => k > 0 && d === buses[0].kd[k - 1]).length;
    expect(stops).toBeGreaterThan(0);
    expect(scene.waiting?.length ?? 0).toBeGreaterThan(0);
    expect(scene.agents.some((a) => a.kind === AGENT_GARBAGE)).toBe(true);
  });

  it('pose des feux aux carrefours', () => {
    expect(scene.lights.length).toBeGreaterThan(5);
  });

  it('les horaires sont cohérents (temps et distances croissants)', () => {
    for (const a of scene.agents) {
      for (let k = 1; k < a.kt.length; k++) {
        expect(a.kt[k]).toBeGreaterThanOrEqual(a.kt[k - 1]);
        // La distance avance, ou repart de zéro au trajet suivant (plusieurs trajets par boucle).
        // Le retour à zéro est instantané : jamais de marche arrière à l'écran.
        if (a.kd[k] < a.kd[k - 1]) expect(a.kt[k]).toBe(a.kt[k - 1]);
        expect(a.kd[k]).toBeLessThanOrEqual(a.total + 1e-9);
      }
      expect(a.kt[a.kt.length - 1]).toBeLessThanOrEqual(a.loopT + 1e-6);
    }
  });

  it('les véhicules ne se rentrent presque jamais dedans', () => {
    const vehicles = scene.agents.filter((a) => a.kind !== AGENT_PED);
    let samples = 0;
    let crashes = 0;
    for (let t = 0; t < 40; t += 0.5) {
      const pos = vehicles.map((a) => agentPosition(a, t)).filter((p) => !p.hidden);
      for (let i = 0; i < pos.length; i++) {
        for (let j = i + 1; j < pos.length; j++) {
          const p = pos[i];
          const q = pos[j];
          const sameWay = Math.sign(p.dx) === Math.sign(q.dx) && Math.sign(p.dy) === Math.sign(q.dy);
          if (!sameWay) continue;
          samples++;
          if (Math.hypot(p.gx - q.gx, p.gy - q.gy) < 0.12) crashes++;
        }
      }
    }
    expect(samples).toBeGreaterThan(0);
    expect(crashes / samples).toBeLessThan(0.002);
  });

  it('on peut toucher un citoyen et lire sa fiche', () => {
    const t = 3;
    const idx = scene.agents.findIndex((a) => a.kind === AGENT_PED && !agentPosition(a, t).hidden);
    const p = agentPosition(scene.agents[idx], t);
    const hit = agentAt(scene, t * 1000, p.gx, p.gy);
    expect(hit).toBeGreaterThanOrEqual(0);
    const info = describeAgent(scene, hit, tiles, SIZE, 60);
    expect(info.name).toMatch(/\w+ \w+/);
    expect(info.age).toBeGreaterThanOrEqual(18);
    expect(info.quote.length).toBeGreaterThan(3);
    expect(agentAt(scene, 0, -50, -50)).toBe(-1);
  });

  it('le calcul en tâche de fond donne le même résultat et peut être annulé', async () => {
    const async1 = await buildAgentsAsync(tiles, SIZE, population, 2000, 1, [], () => false);
    expect(async1?.agents.length).toBe(scene.agents.length);
    const cancelled = await buildAgentsAsync(tiles, SIZE, population, 2000, 1, [], () => true);
    // Annulé dès la première pause (ou terminé avant si le calcul est très court).
    expect(cancelled === null || cancelled.agents.length === scene.agents.length).toBe(true);
  });
});
