import { Canvas, Group, Path, Picture } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useDerivedValue, useSharedValue, withDecay } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { getOrigin, getWorldSize, screenToTile } from '../engine/iso';
import { buildMapPicture, COLORS, diamondPath } from '../engine/renderer';
import { useGameStore } from '../store/useGameStore';

const MIN_SCALE = 0.1;
const MAX_SCALE = 3;

export function IsoMapCanvas() {
  const { width: screenW, height: screenH } = useWindowDimensions();

  // Sélecteurs fins : ce composant ne re-rend que si la carte ou la sélection change.
  const tiles = useGameStore((s) => s.tiles);
  const gridSize = useGameStore((s) => s.gridSize);
  const selected = useGameStore((s) => s.selected);
  const selectTile = useGameStore((s) => s.selectTile);

  const picture = useMemo(() => buildMapPicture(tiles, gridSize), [tiles, gridSize]);
  const highlight = useMemo(
    () => (selected ? diamondPath(selected.x, selected.y, getOrigin(gridSize)) : null),
    [selected, gridSize],
  );

  // Caméra : écran = monde * scale + (tx, ty). Vit entièrement sur le thread UI.
  const world = getWorldSize(gridSize);
  const initialScale = 0.55;
  const scale = useSharedValue(initialScale);
  const tx = useSharedValue((screenW - world.width * initialScale) / 2);
  const ty = useSharedValue((screenH - world.height * initialScale) / 2);

  const transform = useDerivedValue(() => [
    { translateX: tx.value },
    { translateY: ty.value },
    { scale: scale.value },
  ]);

  const pan = Gesture.Pan()
    .averageTouches(true)
    .onChange((e) => {
      tx.value += e.changeX;
      ty.value += e.changeY;
    })
    .onEnd((e) => {
      tx.value = withDecay({ velocity: e.velocityX, deceleration: 0.994 });
      ty.value = withDecay({ velocity: e.velocityY, deceleration: 0.994 });
    });

  // Zoom centré sur le point focal : le point monde sous les doigts reste fixe.
  const pinch = Gesture.Pinch().onChange((e) => {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale.value * e.scaleChange));
    const factor = next / scale.value;
    tx.value = e.focalX - (e.focalX - tx.value) * factor;
    ty.value = e.focalY - (e.focalY - ty.value) * factor;
    scale.value = next;
  });

  // Raycasting inverse calculé sur le thread UI, résultat envoyé au store (thread JS).
  const tap = Gesture.Tap()
    .maxDuration(250)
    .onEnd((e, success) => {
      if (!success) return;
      const tile = screenToTile(e.x, e.y, tx.value, ty.value, scale.value, gridSize);
      if (tile) scheduleOnRN(selectTile, tile.x, tile.y);
    });

  const gesture = Gesture.Race(Gesture.Simultaneous(pan, pinch), tap);

  return (
    <GestureDetector gesture={gesture}>
      <View style={styles.fill} collapsable={false}>
        <Canvas style={styles.fill}>
          <Group transform={transform}>
            <Picture picture={picture} />
            {highlight && (
              <>
                <Path path={highlight} color={COLORS.highlight} opacity={0.35} />
                <Path path={highlight} color={COLORS.highlight} style="stroke" strokeWidth={2} />
              </>
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
