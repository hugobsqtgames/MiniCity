import { Canvas, Group, Path, Picture } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useDerivedValue, useSharedValue, withDecay } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { getOrigin, getWorldSize, screenToTile } from '../engine/iso';
import { useMapLayers } from '../engine/mapLayers';
import { COLORS, diamondPath } from '../engine/renderer';
import { TOOL_BY_ID } from '../sim/constants';
import { useGameStore } from '../store/useGameStore';

const MIN_SCALE = 0.15;
const MAX_SCALE = 3;
const INITIAL_SCALE = 0.6;

/**
 * Carte isométrique interactive.
 *  - Mode Explorer : 1 doigt = déplacer, pincer = zoomer, toucher = inspecter.
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
  const tapTile = useGameStore((s) => s.tapTile);
  const paintStart = useGameStore((s) => s.paintStart);
  const paintMove = useGameStore((s) => s.paintMove);
  const paintEnd = useGameStore((s) => s.paintEnd);

  const layers = useMapLayers(tiles, gridSize);
  const highlight = useMemo(
    () => (selected ? diamondPath(selected.x, selected.y, getOrigin(gridSize)) : null),
    [selected, gridSize],
  );

  // Caméra : écran = monde * scale + (tx, ty).
  const world = getWorldSize(gridSize);
  const scale = useSharedValue(INITIAL_SCALE);
  const tx = useSharedValue((screenW - world.width * INITIAL_SCALE) / 2);
  const ty = useSharedValue((screenH - world.height * INITIAL_SCALE) / 2);

  const transform = useDerivedValue(() => [
    { translateX: tx.get() },
    { translateY: ty.get() },
    { scale: scale.get() },
  ]);

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

  // Peinture au doigt (routes, zones, bulldozer) : 1 doigt, seulement en mode construction.
  const paint = Gesture.Pan()
    .enabled(building)
    .maxPointers(1)
    .minDistance(6)
    .onStart((e) => {
      // Le geste s'active après quelques pixels : on part du point de contact initial
      // pour ne pas sauter la première tuile, puis on rejoint la position courante.
      const s = screenToTile(e.x - e.translationX, e.y - e.translationY, tx.get(), ty.get(), scale.get(), gridSize);
      if (s) scheduleOnRN(paintStart, s.x, s.y);
      const t = screenToTile(e.x, e.y, tx.get(), ty.get(), scale.get(), gridSize);
      if (t) scheduleOnRN(paintMove, t.x, t.y);
    })
    .onUpdate((e) => {
      const t = screenToTile(e.x, e.y, tx.get(), ty.get(), scale.get(), gridSize);
      if (t) scheduleOnRN(paintMove, t.x, t.y);
    })
    .onFinalize(() => {
      scheduleOnRN(paintEnd);
    });

  // Toucher simple : raycasting inverse écran -> tuile, calculé sur le thread UI.
  const tap = Gesture.Tap()
    .maxDuration(300)
    .onEnd((e, success) => {
      if (!success) return;
      const t = screenToTile(e.x, e.y, tx.get(), ty.get(), scale.get(), gridSize);
      if (t) scheduleOnRN(tapTile, t.x, t.y);
    });

  const gesture = Gesture.Race(Gesture.Simultaneous(pan, pinch), paint, tap);
  const highlightColor = TOOL_BY_ID[tool].color;

  return (
    <GestureDetector gesture={gesture}>
      <View style={styles.fill} collapsable={false}>
        <Canvas style={styles.fill}>
          <Group transform={transform}>
            {layers.ground.map((p, i) => (
              <Picture key={`g${i}`} picture={p} />
            ))}
            <Picture picture={layers.shadows} />
            {layers.buildings.map((p, i) => (
              <Picture key={`b${i}`} picture={p} />
            ))}
            {highlight && (
              <Group>
                <Path path={highlight} color={highlightColor} opacity={0.35} />
                <Path path={highlight} color={COLORS.highlight} style="stroke" strokeWidth={2} />
              </Group>
            )}
          </Group>
        </Canvas>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: COLORS.background },
});
