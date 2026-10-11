import { BlendMode, Canvas, createPicture, Group, PaintStyle, Path, Picture, Rect, Skia, useClock, type SkPicture } from '@shopify/react-native-skia';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import {
  useAnimatedReaction,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withDecay,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import {
  agentAt,
  agentsSignature,
  BUBBLE_CRIME,
  BUBBLE_GARBAGE,
  BUBBLE_JOBS,
  BUBBLE_MONEY,
  BUBBLE_POLLUTION,
  BUBBLE_TRAFFIC,
  buildAgents,
  buildAgentsAsync,
  describeAgent,
  drawAgents,
  drawFires,
  drawMetro,
  type AgentsScene,
} from '../engine/agents';
import { camera as sharedCamera, focusRequest } from '../engine/cameraBridge';
import { getOrigin, getWorldSize, gridToWorld, HALF_H, HALF_W, screenToTile, worldToGridFloat } from '../engine/iso';
import { useMapLayers } from '../engine/mapLayers';
import { isBuildableGround, isFacility, isPlant, isRoadType, isZone } from '../engine/map';
import { buildCoveragePicture, buildDataPicture, buildOccluderPicture, buildPreviewPicture, buildSnowMask, COLORS, diamondPath, hueColor } from '../engine/renderer';
import { fromView, pointFromView, pointToView, remapToView, RotatedTiles, toView, vectorToView } from '../engine/rotation';
import { useDebounced } from '../hooks/useDebounced';
import { usePerformanceGovernor } from '../hooks/usePerformanceGovernor';
import { COVERAGE_TOOL, seasonOf, TOOL_BY_ID } from '../sim/constants';
import { districtMap, localHappiness } from '../sim/districts';
import { computeCoverage } from '../sim/simulation';
import { dragTiles, useGameStore, type Tile } from '../store/useGameStore';
import { WeatherLayer } from './WeatherLayer';

/** Clé des itinéraires : ils ne sont recalculés que si les routes ou la population (par paliers) changent. */
function agentsKey(tiles: Tile[], size: number, population: number, riders: number, scale: number, issues: number[], extra: string) {
  return `${size}:${agentsSignature(tiles, population)}:${riders > 0 ? Math.floor(Math.log(riders) / Math.log(1.25)) : -1}:${scale}:${issues.join(',')}:${extra}`;
}

/** Bulles d'humeur possibles selon les problèmes de la ville. */
function cityIssues(s: { congestion: number; crime: number; pollution: number; garbage: number; unemployment: number }, tax: number): number[] {
  const out: number[] = [];
  if (s.congestion > 55) out.push(BUBBLE_TRAFFIC);
  if (s.crime > 30) out.push(BUBBLE_CRIME);
  if (s.pollution > 35) out.push(BUBBLE_POLLUTION);
  if (s.garbage > 25) out.push(BUBBLE_GARBAGE);
  if (tax > 12) out.push(BUBBLE_MONEY);
  if (s.unemployment > 15) out.push(BUBBLE_JOBS);
  return out;
}

const EMPTY_SCENE: AgentsScene = { agents: [], fires: [], lights: [], metro: [] };

/** En dessous de ce zoom, les PNJ font moins d'un pixel : inutile de les dessiner. */
const AGENTS_MIN_SCALE = 0.3;
/** Une journée dure 4 minutes réelles. */
const DAY_SECONDS = 240;

const MIN_SCALE = 0.12;
const MAX_SCALE = 3;
const INITIAL_SCALE = 0.6;

type Camera = { tx: SharedValue<number>; ty: SharedValue<number>; scale: SharedValue<number>; width: number; height: number };

/** Rectangle visible en coordonnées monde (+ marge). */
function viewRect(cam: Camera, margin: number) {
  'worklet';
  const s = cam.scale.get();
  return {
    x0: -cam.tx.get() / s - margin,
    y0: -cam.ty.get() / s - margin,
    x1: (cam.width - cam.tx.get()) / s + margin,
    y1: (cam.height - cam.ty.get()) / s + margin,
  };
}

/** Obscurité de la nuit (0 = plein jour, 1 = pleine nuit) selon l'heure du cycle. */
export function nightAmount(ms: number): number {
  'worklet';
  const p = ((ms / 1000) % DAY_SECONDS) / DAY_SECONDS;
  const ramp = (a: number, b: number, x: number) => Math.min(1, Math.max(0, (x - a) / (b - a)));
  return ramp(0.55, 0.68, p) * (1 - ramp(0.9, 0.99, p));
}

/**
 * Rejoue uniquement les blocs de la carte visibles à l'écran (culling).
 * Recalculé sur le thread UI quand la caméra bouge ; aucun re-render React.
 */
function useVisiblePicture(
  pictures: SkPicture[][],
  bounds: { x0: number; x1: number; y0: number; y1: number }[],
  cam: Camera,
  worldRect: { width: number; height: number },
  alpha?: SharedValue<number>,
) {
  return useDerivedValue(() => {
    const a = alpha ? alpha.get() : 1;
    const v = viewRect(cam, 0);
    return createPicture((canvas) => {
      if (a < 0.02) return;
      // Calque isolé : les effacements (mode Clear) des lumières restent dans ce calque,
      // et l'opacité s'applique aussi aux images enregistrées.
      const layer = alpha ? Skia.Paint() : null;
      if (layer) {
        layer.setAlphaf(a);
        canvas.saveLayer(layer);
      }
      for (const list of pictures) {
        for (let i = 0; i < list.length; i++) {
          const b = bounds[i];
          if (b.x1 < v.x0 || b.x0 > v.x1 || b.y1 < v.y0 || b.y0 > v.y1) continue;
          canvas.drawPicture(list[i]);
        }
      }
      if (layer) canvas.restore();
    }, { x: 0, y: 0, ...worldRect });
  }, [pictures, bounds, alpha]);
}

/** Voile de nuit appliqué uniquement aux pixels déjà dessinés du calque (mode srcATop). */
const NIGHT_TINT = '#0a1236';

function AgentsLayer({
  scene,
  gridSize,
  camera,
  clock,
  night,
  rotation,
  top,
  showMetro = false,
}: {
  scene: AgentsScene;
  gridSize: number;
  camera: Camera;
  clock: SharedValue<number>;
  night: SharedValue<number>;
  rotation: number;
  top?: boolean;
  showMetro?: boolean;
}) {
  const world = getWorldSize(gridSize);
  const picture = useDerivedValue(() => {
    const now = clock.get();
    const visible = camera.scale.get() >= AGENTS_MIN_SCALE;
    const view = viewRect(camera, 20);
    const n = night.get();
    return createPicture((canvas) => {
      if (top) {
        drawFires(canvas, scene.fires, now, gridSize, view, rotation);
        if (showMetro) drawMetro(canvas, scene, now, gridSize, rotation);
        return;
      }
      if (!visible) return;
      if (n > 0.02) {
        // Véhicules assombris par la nuit, puis phares et feux par-dessus. Les bâtiments,
        // dessinés dans le calque suivant, masquent naturellement les phares cachés.
        canvas.saveLayer();
        drawAgents(canvas, scene, now, gridSize, view, rotation, 'bodies', n);
        const tint = Skia.Paint();
        tint.setColor(Skia.Color(NIGHT_TINT));
        tint.setAlphaf(n * 0.62);
        tint.setBlendMode(BlendMode.SrcATop);
        canvas.drawRect({ x: view.x0, y: view.y0, width: view.x1 - view.x0, height: view.y1 - view.y0 }, tint);
        canvas.restore();
        if (n > 0.15) drawAgents(canvas, scene, now, gridSize, view, rotation, 'lights', n);
      } else drawAgents(canvas, scene, now, gridSize, view, rotation, 'bodies', 0);
    }, { x: 0, y: 0, ...world });
  });
  return <Picture picture={picture} />;
}

/** Smog au-dessus des quartiers pollués + tornade en cours : effets animés du calque du dessus. */
type Spinner = { kind: 'wind' | 'wheel'; x: number; y: number; seed: number; occ: SkPicture };
type Burst = { x: number; y: number; big: boolean };

function EffectsLayer({
  haze,
  tornado,
  clock,
  gridSize,
  spinners,
  bursts,
  night,
}: {
  haze: { x: number; y: number; v: number }[];
  tornado: { path: { x: number; y: number }[]; start: SharedValue<number> } | null;
  clock: SharedValue<number>;
  gridSize: number;
  spinners: Spinner[];
  bursts: Burst[];
  night: SharedValue<number>;
}) {
  const world = getWorldSize(gridSize);
  // Pales d'éoliennes et grandes roues qui tournent, feux d'artifice au-dessus des fêtes.
  const motion = useDerivedValue(() => {
    const t = clock.get() / 1000;
    const n = night.get();
    return createPicture((canvas) => {
      const bladePaint = hazePaint(0.95, '#fdfefe');
      const rim = hazePaint(0.9, '#ecf0f1');
      rim.setStyle(PaintStyle.Stroke);
      rim.setStrokeWidth(1.2);
      const cabinPaint = hazePaint(0.95, '#e74c3c');
      // Chaque objet dans son propre calque, puis effacé là où un bâtiment le cache.
      for (const sp of spinners) {
        canvas.saveLayer();
        if (sp.kind === 'wind') {
          const blades = Skia.PathBuilder.Make();
          const a0 = t * 2.2 + sp.seed;
          for (let k = 0; k < 3; k++) {
            const a = a0 + (k * Math.PI * 2) / 3;
            const ex = sp.x + Math.cos(a) * 17;
            const ey = sp.y + Math.sin(a) * 17;
            const nx = -Math.sin(a) * 1.4;
            const ny = Math.cos(a) * 1.4;
            blades.addPoly([{ x: sp.x + nx, y: sp.y + ny }, { x: ex, y: ey }, { x: sp.x - nx, y: sp.y - ny }], true);
          }
          canvas.drawPath(blades.detach(), bladePaint);
        } else {
          const rims = Skia.PathBuilder.Make();
          const cabins = Skia.PathBuilder.Make();
          const r = 17;
          rims.addCircle(sp.x, sp.y, r);
          const a0 = t * 0.35 + sp.seed;
          for (let k = 0; k < 8; k++) {
            const a = a0 + (k * Math.PI) / 4;
            rims.moveTo(sp.x, sp.y);
            rims.lineTo(sp.x + Math.cos(a) * r, sp.y + Math.sin(a) * r);
            cabins.addRect({ x: sp.x + Math.cos(a) * r - 2.2, y: sp.y + Math.sin(a) * r, width: 4.4, height: 3.6 });
          }
          canvas.drawPath(rims.detach(), rim);
          canvas.drawPath(cabins.detach(), cabinPaint);
        }
        canvas.drawPicture(sp.occ);
        canvas.restore();
      }
      // Feux d'artifice : gerbes colorées qui s'ouvrent puis retombent.
      const colors = ['#ff5e57', '#ffd32a', '#0fbcf9', '#05c46b', '#f368e0'];
      for (let b = 0; b < bursts.length; b++) {
        const ev = bursts[b];
        if (!ev.big && n < 0.4) continue;
        const count = ev.big ? 4 : 2;
        for (let k = 0; k < count; k++) {
          const period = 2.6;
          const ph = (t + k * 0.9 + b * 0.37) % period;
          if (ph > 1.8) continue;
          const seed = Math.floor((t + k * 0.9 + b * 0.37) / period) * 13 + k * 7 + b;
          const cx = ev.x + (Math.sin(seed * 12.9898) * 0.5) * 70;
          const cy = ev.y - 90 - (Math.sin(seed * 78.233) * 0.5 + 0.5) * 50;
          const grow = Math.min(1, ph / 0.6);
          const fade = ph < 0.9 ? 1 : 1 - (ph - 0.9) / 0.9;
          const p = hazePaint(0.9 * fade, colors[Math.abs(seed) % colors.length]);
          const rays = 18;
          for (let r = 0; r < rays; r++) {
            const a = (r / rays) * Math.PI * 2;
            const dist = (ev.big ? 40 : 28) * grow;
            canvas.drawCircle(cx + Math.cos(a) * dist, cy + Math.sin(a) * dist + ph * ph * 8, ev.big ? 2.8 : 2, p);
          }
        }
      }
    }, { x: 0, y: 0, ...world });
  }, [spinners, bursts]);
  const picture = useDerivedValue(() => {
    const t = clock.get() / 1000;
    return createPicture((canvas) => {
      if (tornado) {
        const elapsed = t - tornado.start.get();
        if (elapsed >= 0 && elapsed < 9) {
          const u = (elapsed / 9) * (tornado.path.length - 1);
          const i = Math.min(tornado.path.length - 2, Math.floor(u));
          const f = u - i;
          const p = { x: tornado.path[i].x + (tornado.path[i + 1].x - tornado.path[i].x) * f, y: tornado.path[i].y + (tornado.path[i + 1].y - tornado.path[i].y) * f };
          // Entonnoir : empilement d'ellipses qui s'élargissent vers le haut et tournoient.
          for (let k = 0; k < 14; k++) {
            const r = 4 + k * 2.6;
            const wob = Math.sin(t * 9 + k * 0.6) * (3 + k * 0.6);
            canvas.drawOval({ x: p.x + wob - r, y: p.y - 10 - k * 9 - r * 0.3, width: r * 2, height: r * 0.6 }, hazePaint(0.35, '#7f8c8d'));
          }
        }
      }
    }, { x: 0, y: 0, ...world });
  }, [tornado]);
  // Smog : nappes brunâtres qui dérivent lentement.
  const hazePic = useDerivedValue(() => {
    const t = clock.get() / 1000;
    return createPicture((canvas) => {
      for (let k = 0; k < haze.length; k++) {
        const h = haze[k];
        const dx = Math.sin(t * 0.25 + k) * 10;
        const dy = Math.cos(t * 0.2 + k * 1.7) * 4;
        canvas.drawCircle(h.x + dx, h.y + dy - 26, 16 + h.v * 22, hazePaint(Math.min(0.3, 0.08 + h.v * 0.2), '#8d6e4f'));
      }
    }, { x: 0, y: 0, ...world });
  }, [haze]);
  return (
    <Group>
      <Picture picture={hazePic} />
      <Picture picture={motion} />
      <Picture picture={picture} />
    </Group>
  );
}

function hazePaint(alpha: number, color: string) {
  'worklet';
  const p = Skia.Paint();
  p.setAntiAlias(true);
  p.setColor(Skia.Color(color));
  p.setAlphaf(alpha);
  return p;
}

/**
 * Carte isométrique interactive.
 *  - Mode Explorer : 1 doigt = déplacer, pincer = zoomer, toucher = inspecter (tuile ou citoyen).
 *  - Mode construction : 1 doigt = construire (toucher ou glisser pour peindre),
 *    2 doigts = déplacer / zoomer.
 * Toute la caméra vit sur le thread UI ; seul le résultat du raycasting
 * inverse (x, y de la tuile) repasse sur le thread JS.
 */
export function IsoMapCanvas() {
  const { width: screenW, height: screenH } = useWindowDimensions();

  // Sélecteurs fins : ce composant ne re-rend que si la carte, l'outil ou la sélection change.
  const tiles = useGameStore((s) => s.tiles);
  const gridSize = useGameStore((s) => s.gridSize);
  const selected = useGameStore((s) => s.selected);
  const tool = useGameStore((s) => s.tool);
  const rotation = useGameStore((s) => s.rotation);
  const dataView = useGameStore((s) => s.dataView);
  const maps = useGameStore((s) => s.maps);
  const funding = useGameStore((s) => s.funding);
  const lastDisaster = useGameStore((s) => s.lastDisaster);
  const tapTile = useGameStore((s) => s.tapTile);
  const showCitizen = useGameStore((s) => s.showCitizen);
  const paintStart = useGameStore((s) => s.paintStart);
  const paintMove = useGameStore((s) => s.paintMove);
  const paintEnd = useGameStore((s) => s.paintEnd);
  const population = useGameStore((s) => s.stats.population);
  const riders = useGameStore((s) => s.stats.metroRiders + s.stats.busRiders);
  const happiness = useGameStore((s) => s.stats.happiness);
  const settings = useGameStore((s) => s.settings);
  const agentScale = useGameStore((s) => s.agentScale);
  const month = useGameStore((s) => s.month);
  const weather = useGameStore((s) => s.weather);
  const cityEvents = useGameStore((s) => s.cityEvents);
  const drag = useGameStore((s) => s.drag);
  const winter = seasonOf(month) === 'winter';
  const eventKey = cityEvents.map((e) => `${e.x},${e.y}`).join(';');

  // Carte vue dans le repère tourné (seules les tuiles modifiées sont recréées).
  const [rotated] = useState(() => new RotatedTiles());
  const viewTiles = useMemo(() => rotated.get(tiles, gridSize, rotation), [rotated, tiles, gridSize, rotation]);
  const layers = useMapLayers(viewTiles, gridSize);

  // Le trafic se recalcule une fois la construction terminée (pas à chaque tuile peinte),
  // en tâche de fond par tranches de quelques ms pour ne jamais bloquer les gestes.
  const agentTiles = useDebounced(tiles, 600);
  const issueKey = useGameStore((s) => cityIssues(s.stats, Math.max(s.taxes.R, s.taxes.C, s.taxes.I)).join(','));
  const [built, setBuilt] = useState<{ key: string; scene: AgentsScene }>({ key: '', scene: EMPTY_SCENE });
  const wantedKey = agentsKey(agentTiles, gridSize, population, riders, agentScale, issueKey ? issueKey.split(',').map(Number) : [], `${winter}`);
  useEffect(() => {
    if (wantedKey === built.key) return;
    let cancelled = false;
    const issues = issueKey ? issueKey.split(',').map(Number) : [];
    buildAgentsAsync(agentTiles, gridSize, population, riders, agentScale, issues, () => cancelled, { winter }).then((res) => {
      if (res && !cancelled) setBuilt({ key: wantedKey, scene: res });
    });
    return () => {
      cancelled = true;
    };
  }, [wantedKey, built.key, agentTiles, gridSize, population, riders, agentScale, issueKey, winter]);
  // Foules des événements : petite scène séparée, recalculée seulement quand les événements changent.
  const crowds = useMemo(() => {
    if (!eventKey || !settings.showAgents) return null;
    const events = eventKey.split(';').map((p) => ({ x: Number(p.split(',')[0]), y: Number(p.split(',')[1]) }));
    return buildAgents(agentTiles, gridSize, 0, 0, agentScale, [], { events, crowdOnly: true }).agents;
  }, [eventKey, agentTiles, gridSize, agentScale, settings.showAgents]);
  const scene = useMemo(() => {
    const base = built.scene;
    const full = crowds?.length ? { ...base, agents: [...base.agents, ...crowds] } : base;
    // Les incendies restent visibles même quand le trafic est désactivé.
    return settings.showAgents ? full : { ...EMPTY_SCENE, fires: full.fires, metro: full.metro };
  }, [settings.showAgents, built.scene, crowds]);
  usePerformanceGovernor(settings.quality);

  const origin = getOrigin(gridSize);
  const world = getWorldSize(gridSize);

  // Carte de couverture du service dont l'outil est sélectionné (police, pompiers, métro…).
  const coverageService = COVERAGE_TOOL[tool];
  const coverage = useMemo(() => {
    if (!coverageService) return null;
    const cov = remapToView(computeCoverage(tiles, gridSize, funding)[coverageService], gridSize, rotation);
    return buildCoveragePicture(viewTiles, gridSize, coverageService, cov);
  }, [coverageService, tiles, viewTiles, gridSize, funding, rotation]);

  // Vues de données (trafic, pollution, criminalité, valeur, déchets).
  const dataPicture = useMemo(() => {
    if (dataView === 'none' || !maps) return null;
    const orig = (t: Tile) => {
      const [x, y] = fromView(t.x, t.y, gridSize, rotation);
      return y * gridSize + x;
    };
    const built = (t: Tile) => isZone(t.type) && t.density > 0;
    if (dataView === 'districts') {
      const dm = districtMap(gridSize);
      const colors = dm.list.map((d) => hueColor(d.hue));
      return buildDataPicture(viewTiles, gridSize, () => null, { colorOf: (t) => (t.type === 'LAKE' ? null : colors[dm.ids[orig(t)]]), alpha: 0.42 });
    }
    const cov = dataView === 'happiness' ? computeCoverage(tiles, gridSize, funding) : null;
    return buildDataPicture(viewTiles, gridSize, (t) => {
      const i = orig(t);
      switch (dataView) {
        case 'traffic':
          return maps.traffic[i] > 0 ? Math.min(1, maps.traffic[i] / 1.3) : null;
        case 'pollution':
          return t.type !== 'LAKE' && maps.pollution[i] > 2 ? Math.min(1, maps.pollution[i] / 40) : null;
        case 'crime':
          return built(t) && t.type !== 'I' ? maps.crime[i] * 1.6 : null;
        case 'value':
          return built(t) ? 1 - tiles[i].value / 100 : null;
        case 'garbage':
          return built(t) ? tiles[i].garbage / 9 : null;
        case 'happiness': {
          const h = cov ? localHappiness(tiles[i], i, maps, cov) : -1;
          return h < 0 ? null : 1 - h / 100;
        }
        case 'power':
          if (isPlant(t.type)) return 0;
          return built(t) || (isFacility(t.type) && t.type !== 'PARK' && t.type !== 'BUSSTOP') ? (tiles[i].powered ? 0.1 : 1) : null;
        default:
          return null;
      }
    }, { colorblind: settings.colorblind });
  }, [dataView, maps, viewTiles, gridSize, rotation, tiles, funding, settings.colorblind]);

  // Éoliennes et grandes roues (animées) ; feux d'artifice au-dessus des événements.
  const spinners = useMemo(() => {
    const out: Spinner[] = [];
    for (const t of tiles) {
      if (t.type !== 'WIND' && t.type !== 'FAIR') continue;
      const [vx, vy] = toView(t.x, t.y, gridSize, rotation);
      const p = gridToWorld(vx, vy, origin);
      const occ = buildOccluderPicture(viewTiles, gridSize, vx, vy);
      if (t.type === 'WIND') out.push({ kind: 'wind', x: p.x, y: p.y + HALF_H - 51, seed: t.x * 1.3 + t.y, occ });
      else {
        // Moyeu entre les deux pieds de la roue (décalés de -0.32 en y d'origine).
        const [ox, oy] = vectorToView(0.06, -0.32, rotation);
        out.push({ kind: 'wheel', x: p.x + (ox - oy) * HALF_W, y: p.y + HALF_H + (ox + oy) * HALF_H - 30, seed: t.x + t.y, occ });
      }
    }
    return out;
  }, [tiles, viewTiles, gridSize, rotation, origin]);
  const bursts = useMemo(
    () =>
      cityEvents
        .filter((e) => e.kind !== 'market')
        .map((e) => {
          const [vx, vy] = toView(e.x, e.y, gridSize, rotation);
          const p = gridToWorld(vx, vy, origin);
          return { x: p.x, y: p.y + HALF_H, big: e.kind === 'fireworks' };
        }),
    [cityEvents, gridSize, rotation, origin],
  );

  // Aperçu du glisser : rectangle de zonage ou route droite.
  const preview = useMemo(() => {
    if (!drag) return null;
    const cells = dragTiles(drag)
      .filter(([x, y]) => x >= 0 && y >= 0 && x < gridSize && y < gridSize)
      .map(([x, y]) => {
        const t = tiles[y * gridSize + x];
        const ok =
          tool === 'bulldoze'
            ? t.type !== 'GRASS' && t.type !== 'SAND' && t.type !== 'LAKE'
            : drag.mode === 'line'
              ? !isZone(t.type) && !isFacility(t.type) && t.rad === 0
              : (isBuildableGround(t.type) || t.type === 'FOREST') && t.rad === 0;
        const [vx, vy] = toView(x, y, gridSize, rotation);
        return { x: vx, y: vy, ok: ok || (drag.mode === 'line' && isRoadType(t.type)) };
      });
    return buildPreviewPicture(gridSize, cells, TOOL_BY_ID[tool].color);
  }, [drag, tiles, gridSize, rotation, tool]);

  // Smog : nappes au-dessus des tuiles les plus polluées (échantillonnées une tuile sur deux).
  const haze = useMemo(() => {
    if (!maps) return [];
    const out: { x: number; y: number; v: number }[] = [];
    for (let y = 0; y < gridSize; y += 2) {
      for (let x = 0; x < gridSize; x += 2) {
        const v = maps.pollution[y * gridSize + x];
        if (v < 22) continue;
        const [vx, vy] = toView(x, y, gridSize, rotation);
        const p = gridToWorld(vx, vy, origin);
        out.push({ x: p.x, y: p.y + HALF_H, v: Math.min(1, (v - 22) / 40) });
        if (out.length >= 140) return out;
      }
    }
    return out;
  }, [maps, gridSize, rotation, origin]);

  const highlight = useMemo(() => {
    if (!selected) return null;
    const [vx, vy] = toView(selected.x, selected.y, gridSize, rotation);
    return diamondPath(vx, vy, origin);
  }, [selected, gridSize, rotation, origin]);

  // Caméra : écran = monde * scale + (tx, ty).
  // Horloges : `realClock` (météo) tourne toujours ; `clock` (PNJ, effets) s'arrête en pause
  // et suit la vitesse (plafonnée à 2× pour rester lisible) ; `dayClock` (jour / nuit) suit
  // exactement le temps du jeu.
  const realClock = useClock();
  const clock = useSharedValue(0);
  const dayClock = useSharedValue(0);
  const paused = useGameStore((s) => s.paused);
  const speed = useGameStore((s) => s.speed);
  const pace = useSharedValue(1);
  useEffect(() => {
    pace.set(paused ? 0 : speed);
  }, [paused, speed, pace]);
  useFrameCallback((f) => {
    'worklet';
    const dt = Math.min(100, f.timeSincePreviousFrame ?? 16);
    const p = pace.get();
    clock.set(clock.get() + dt * Math.min(2, p));
    dayClock.set(dayClock.get() + dt * p);
  });
  // Caméra partagée (mini-carte, conseillers) : centrée sur la carte au premier affichage.
  useState(() => {
    sharedCamera.scale.set(INITIAL_SCALE);
    sharedCamera.tx.set((screenW - world.width * INITIAL_SCALE) / 2);
    sharedCamera.ty.set((screenH - world.height * INITIAL_SCALE) / 2);
    return true;
  });
  const scale = sharedCamera.scale;
  const tx = sharedCamera.tx;
  const ty = sharedCamera.ty;
  useEffect(() => {
    sharedCamera.width.set(screenW);
    sharedCamera.height.set(screenH);
  }, [screenW, screenH]);
  const shake = useSharedValue(0);
  const camera: Camera = { tx, ty, scale, width: screenW, height: screenH };

  const transform = useDerivedValue(() => [
    { translateX: tx.get() + shake.get() },
    { translateY: ty.get() + shake.get() * 0.4 },
    { scale: scale.get() },
  ]);

  // Nouvelle carte (taille différente) : on recentre la caméra sur la ville.
  const prevSize = useRef(gridSize);
  useEffect(() => {
    if (prevSize.current === gridSize) return;
    prevSize.current = gridSize;
    scale.set(INITIAL_SCALE);
    tx.set((screenW - world.width * INITIAL_SCALE) / 2);
    ty.set((screenH - world.height * INITIAL_SCALE) / 2);
  }, [gridSize, world.width, world.height, screenW, screenH, scale, tx, ty]);

  // Centrage demandé (conseiller, quartier, mini-carte, catastrophe) : glissement animé.
  useAnimatedReaction(
    () => focusRequest.get(),
    (req, prev) => {
      if (!prev || req.seq === prev.seq || req.x < 0) return;
      const [vx, vy] = pointToView(req.x + 0.5, req.y + 0.5, gridSize, rotation);
      const px = origin.originX + (vx - vy) * HALF_W;
      const py = origin.originY + (vx + vy) * HALF_H;
      const s = req.zoom > 0 ? Math.max(scale.get(), req.zoom) : scale.get();
      const cfg = { duration: 650 };
      scale.set(withTiming(s, cfg));
      tx.set(withTiming(screenW / 2 - px * s, cfg));
      ty.set(withTiming(screenH / 2 - py * s, cfg));
    },
    [gridSize, rotation, origin, screenW, screenH],
  );

  // Rotation : on garde le même endroit de la ville au centre de l'écran.
  const prevRotation = useRef(rotation);
  useEffect(() => {
    const before = prevRotation.current;
    if (before === rotation) return;
    prevRotation.current = rotation;
    const s = scale.get();
    const wx = (screenW / 2 - tx.get()) / s;
    const wy = (screenH / 2 - ty.get()) / s;
    const g = worldToGridFloat(wx, wy, origin);
    const [ox, oy] = pointFromView(g.x, g.y, gridSize, before);
    const [nx, ny] = pointToView(ox, oy, gridSize, rotation);
    const p = { x: origin.originX + (nx - ny) * HALF_W, y: origin.originY + (nx + ny) * HALF_H };
    tx.set(screenW / 2 - p.x * s);
    ty.set(screenH / 2 - p.y * s);
  }, [rotation, gridSize, origin, screenW, screenH, scale, tx, ty]);

  // Catastrophes : secousse de la caméra (séisme), tornade animée sur son trajet.
  const tornadoStart = useSharedValue(-100);
  const tornado = useMemo(() => {
    const ev = lastDisaster?.event;
    if (!ev || ev.kind !== 'tornado' || !ev.path) return null;
    const path = ev.path.map(([x, y]) => {
      const [vx, vy] = toView(Math.max(0, Math.min(gridSize - 1, x)), Math.max(0, Math.min(gridSize - 1, y)), gridSize, rotation);
      const p = gridToWorld(vx, vy, origin);
      return { x: p.x, y: p.y + HALF_H };
    });
    return { path, start: tornadoStart };
  }, [lastDisaster, gridSize, rotation, origin, tornadoStart]);
  useEffect(() => {
    if (!lastDisaster || Date.now() - lastDisaster.at > 3000) return;
    const ev = lastDisaster.event;
    if (ev.kind === 'earthquake') {
      shake.set(withSequence(...Array.from({ length: 12 }, (_, k) => withTiming(k % 2 ? -9 : 9, { duration: 70 })), withTiming(0, { duration: 80 })));
    }
    if (ev.kind === 'tornado') tornadoStart.set(clock.get() / 1000);
  }, [lastDisaster, shake, clock, tornadoStart]);

  // Calques de la carte : seuls les blocs visibles sont rejoués.
  const groundLists = useMemo(() => [layers.ground, layers.shadows], [layers]);
  const buildingLists = useMemo(() => [layers.buildings], [layers]);
  const lightLists = useMemo(() => [layers.lights], [layers]);
  const groundPic = useVisiblePicture(groundLists, layers.bounds, camera, world);
  const buildingPic = useVisiblePicture(buildingLists, layers.bounds, camera, world);
  const night = useDerivedValue(() => (settings.dayNight ? nightAmount(dayClock.get()) : 0));
  const lightsPic = useVisiblePicture(lightLists, layers.bounds, camera, world, night);
  const nightOverlay = useDerivedValue(() => night.get() * 0.62);
  // Saisons : neige l'hiver, teinte rousse l'automne, herbe dorée l'été (transitions douces).
  const season = seasonOf(month);
  const snow = useSharedValue(season === 'winter' ? 1 : 0);
  const autumn = useSharedValue(season === 'autumn' ? 1 : 0);
  const summer = useSharedValue(season === 'summer' ? 1 : 0);
  useEffect(() => {
    // Transition plus courte en accéléré, sinon l'hiver (3 mois) n'a pas le temps d'apparaître.
    const cfg = { duration: 1800 / speed };
    snow.set(withTiming(season === 'winter' ? (weather === 'snow' ? 1 : 0.75) : 0, cfg));
    autumn.set(withTiming(season === 'autumn' ? 1 : 0, cfg));
    summer.set(withTiming(season === 'summer' ? 1 : 0, cfg));
  }, [season, weather, snow, autumn, summer, speed]);
  // Neige sur le sol mais pas sur les routes déneigées (budget transports ≥ 80 %).
  const plowed = funding.transport >= 80;
  // (gardé au début du printemps, le temps que la neige fonde)
  const snowMask = useMemo(() => (season === 'winter' || month % 12 === 2 ? buildSnowMask(viewTiles, gridSize, !plowed) : null), [season, month, viewTiles, gridSize, plowed]);
  const snowPic = useDerivedValue(() => {
    const a = snow.get() * 0.82;
    return createPicture((canvas) => {
      if (!snowMask || a < 0.01) return;
      canvas.drawPath(snowMask, hazePaint(a, '#f4f8fb'));
    }, { x: 0, y: 0, ...world });
  }, [snowMask]);
  const snowRoofs = useDerivedValue(() => snow.get() * 0.3);
  const autumnTint = useDerivedValue(() => autumn.get() * 0.13);
  const summerTint = useDerivedValue(() => summer.get() * 0.07);

  // Bornes : le centre de l'écran reste toujours au-dessus de la carte.
  const boundsX = (s: number): [number, number] => {
    'worklet';
    return [screenW / 2 - world.width * s, screenW / 2];
  };
  const boundsY = (s: number): [number, number] => {
    'worklet';
    return [screenH / 2 - world.height * s, screenH / 2];
  };
  const clampTo = (v: number, [lo, hi]: [number, number]) => {
    'worklet';
    return Math.min(hi, Math.max(lo, v));
  };

  const building = tool !== 'inspect';

  const pan = Gesture.Pan()
    .minPointers(building ? 2 : 1)
    .averageTouches(true)
    .onChange((e) => {
      tx.set(clampTo(tx.get() + e.changeX, boundsX(scale.get())));
      ty.set(clampTo(ty.get() + e.changeY, boundsY(scale.get())));
    })
    .onEnd((e) => {
      tx.set(withDecay({ velocity: e.velocityX, deceleration: 0.994, clamp: boundsX(scale.get()) }));
      ty.set(withDecay({ velocity: e.velocityY, deceleration: 0.994, clamp: boundsY(scale.get()) }));
    });

  // Zoom centré sur le point focal : le point du monde sous les doigts reste fixe.
  const pinch = Gesture.Pinch().onChange((e) => {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale.get() * e.scaleChange));
    const factor = next / scale.get();
    tx.set(e.focalX - (e.focalX - tx.get()) * factor);
    ty.set(e.focalY - (e.focalY - ty.get()) * factor);
    scale.set(next);
  });

  /** Raycasting inverse : écran -> tuile vue -> tuile d'origine (rotation). */
  const pick = (x: number, y: number) => {
    'worklet';
    const t = screenToTile(x, y, tx.get(), ty.get(), scale.get(), gridSize);
    if (!t) return null;
    const [ox, oy] = fromView(t.x, t.y, gridSize, rotation);
    return { x: ox, y: oy };
  };

  // Peinture au doigt (routes, zones, bulldozer) : 1 doigt, seulement en mode construction.
  const paint = Gesture.Pan()
    .enabled(building)
    .maxPointers(1)
    .minDistance(6)
    .onStart((e) => {
      // Le geste s'active après quelques pixels : on part du point de contact initial
      // pour ne pas sauter la première tuile, puis on rejoint la position courante.
      const s = pick(e.x - e.translationX, e.y - e.translationY);
      if (s) scheduleOnRN(paintStart, s.x, s.y);
      const t = pick(e.x, e.y);
      if (t) scheduleOnRN(paintMove, t.x, t.y);
    })
    .onUpdate((e) => {
      const t = pick(e.x, e.y);
      if (t) scheduleOnRN(paintMove, t.x, t.y);
    })
    .onFinalize(() => {
      scheduleOnRN(paintEnd);
    });

  // Toucher simple : d'abord un citoyen (en mode Explorer), sinon la tuile.
  const onTap = (tileX: number, tileY: number, gx: number, gy: number, timeMs: number) => {
    if (tool === 'inspect' && settings.showAgents) {
      const hit = agentAt(scene, timeMs, gx, gy);
      if (hit >= 0) {
        showCitizen(describeAgent(scene, hit, agentTiles, gridSize, happiness));
        return;
      }
    }
    if (tileX >= 0) tapTile(tileX, tileY);
  };
  const tap = Gesture.Tap()
    .maxDuration(300)
    .onEnd((e, success) => {
      if (!success) return;
      const t = pick(e.x, e.y);
      const s = scale.get();
      const g = worldToGridFloat((e.x - tx.get()) / s, (e.y - ty.get()) / s, origin);
      const [gx, gy] = pointFromView(g.x, g.y, gridSize, rotation);
      scheduleOnRN(onTap, t ? t.x : -1, t ? t.y : -1, gx, gy, clock.get());
    });

  const gesture = Gesture.Race(Gesture.Simultaneous(pan, pinch), paint, tap);
  const highlightColor = TOOL_BY_ID[tool].color;

  // Calques superposés : sol + ombres, PNJ, bâtiments + lumières + surcouches, puis effets.
  // La nuit assombrit chaque calque séparément, ce qui laisse les bâtiments masquer
  // phares et fenêtres placés derrière eux. Le sol et les bâtiments ne se redessinent
  // que pendant un déplacement / zoom ou quand la carte change.
  return (
    <GestureDetector gesture={gesture}>
      <View style={styles.root} collapsable={false}>
        <Canvas style={styles.layer} pointerEvents="none">
          <Group transform={transform}>
            <Picture picture={groundPic} />
            <Rect x={-200} y={-400} width={world.width + 400} height={world.height + 800} color="#d35400" opacity={autumnTint} blendMode="srcATop" />
            <Rect x={-200} y={-400} width={world.width + 400} height={world.height + 800} color="#f4d03f" opacity={summerTint} blendMode="srcATop" />
            <Picture picture={snowPic} />
            <Rect x={-200} y={-400} width={world.width + 400} height={world.height + 800} color={NIGHT_TINT} opacity={nightOverlay} />
          </Group>
        </Canvas>
        {scene.agents.length > 0 && (
          <Canvas style={styles.layer} pointerEvents="none">
            <Group transform={transform}>
              <AgentsLayer scene={scene} gridSize={gridSize} camera={camera} clock={clock} night={night} rotation={rotation} />
            </Group>
          </Canvas>
        )}
        <Canvas style={styles.layer} pointerEvents="none">
          <Group transform={transform}>
            {/* Nuit : bâtiments assombris (srcATop ne touche que les pixels déjà dessinés), puis fenêtres et lampadaires. */}
            <Picture picture={buildingPic} />
            <Rect x={-200} y={-400} width={world.width + 400} height={world.height + 800} color="#ffffff" opacity={snowRoofs} blendMode="srcATop" />
            <Rect x={-200} y={-400} width={world.width + 400} height={world.height + 800} color={NIGHT_TINT} opacity={nightOverlay} blendMode="srcATop" />
            <Picture picture={lightsPic} />
            {dataPicture && <Picture picture={dataPicture} />}
            {coverage && <Picture picture={coverage} />}
            {preview && <Picture picture={preview} />}
            {highlight && (
              <Group>
                <Path path={highlight} color={highlightColor} opacity={0.35} />
                <Path path={highlight} color={COLORS.highlight} style="stroke" strokeWidth={2} />
              </Group>
            )}
          </Group>
        </Canvas>
        <Canvas style={styles.layer} pointerEvents="none">
          <Group transform={transform}>
            <EffectsLayer haze={haze} tornado={tornado} clock={clock} gridSize={gridSize} spinners={spinners} bursts={bursts} night={night} />
            <AgentsLayer
              scene={scene}
              gridSize={gridSize}
              camera={camera}
              clock={clock}
              night={night}
              rotation={rotation}
              top
              showMetro={tool === 'metro'}
            />
          </Group>
        </Canvas>
        {settings.weather && <WeatherLayer weather={weather} clock={realClock} />}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.background },
  layer: StyleSheet.absoluteFill,
});
