import { Canvas, Group, Picture, Rect } from '@shopify/react-native-skia';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useDerivedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { camera } from '../engine/cameraBridge';
import { TILE_W, WORLD_PADDING } from '../engine/iso';
import { RotatedTiles } from '../engine/rotation';
import { useThrottled } from '../hooks/useThrottled';
import { useGameStore } from '../store/useGameStore';
import { Glass } from './Glass';
import { buildThumbPicture } from './MapThumb';
import { Text } from './Text';
import { TOOLBAR_HEIGHT } from './Toolbar';
import { theme } from './theme';

/**
 * Mini-carte : toute la ville en petit, avec le cadre de ce qui est visible.
 * Toucher ou glisser dessus déplace la caméra.
 */
export function MiniMap() {
  const insets = useSafeAreaInsets();
  const { width: screenW } = useWindowDimensions();
  const wide = screenW >= 700;
  const W = wide ? 210 : 136;
  const H = W / 2;
  const tiles = useThrottled(
    useGameStore((s) => s.tiles),
    2500,
  );
  const size = useGameStore((s) => s.gridSize);
  const rotation = useGameStore((s) => s.rotation);
  const [rotated] = useState(() => new RotatedTiles());
  const [collapsed, setCollapsed] = useState(false);

  const picture = useMemo(() => {
    const view = rotated.get(tiles, size, rotation);
    return buildThumbPicture(
      size,
      W,
      (x, y) => view[y * size + x].type,
      (x, y) => view[y * size + x].density,
    );
  }, [rotated, tiles, size, rotation, W]);

  // Échelle monde -> mini-carte.
  const k = W / (size * TILE_W);
  const frame = useDerivedValue(() => {
    const s = camera.scale.get();
    return {
      x: (-camera.tx.get() / s - WORLD_PADDING) * k,
      y: (-camera.ty.get() / s - WORLD_PADDING) * k,
      width: (camera.width.get() / s) * k,
      height: (camera.height.get() / s) * k,
    };
  });
  const fx = useDerivedValue(() => frame.get().x);
  const fy = useDerivedValue(() => frame.get().y);
  const fw = useDerivedValue(() => frame.get().width);
  const fh = useDerivedValue(() => frame.get().height);

  /** Centre la caméra sur le point touché de la mini-carte. */
  const jump = (mx: number, my: number, animate: boolean) => {
    'worklet';
    const s = camera.scale.get();
    const wx = mx / k + WORLD_PADDING;
    const wy = my / k + WORLD_PADDING;
    const tx = camera.width.get() / 2 - wx * s;
    const ty = camera.height.get() / 2 - wy * s;
    camera.tx.set(animate ? withTiming(tx, { duration: 300 }) : tx);
    camera.ty.set(animate ? withTiming(ty, { duration: 300 }) : ty);
  };
  const tap = Gesture.Tap().onEnd((e) => jump(e.x, e.y, true));
  const pan = Gesture.Pan()
    .minDistance(2)
    .onChange((e) => jump(e.x, e.y, false));
  const gesture = Gesture.Exclusive(pan, tap);

  const bottom = insets.bottom + TOOLBAR_HEIGHT + 14;
  if (collapsed) {
    return (
      <Pressable onPress={() => setCollapsed(false)} style={[styles.reopen, { bottom, right: insets.right + theme.gutter }]} accessibilityLabel="Afficher la mini-carte">
        <Text style={styles.reopenText}>🗺️</Text>
      </Pressable>
    );
  }
  return (
    <View style={[styles.wrap, { bottom, right: insets.right + theme.gutter }]}>
      <Glass intensity={45} style={styles.card}>
        <GestureDetector gesture={gesture}>
          <View collapsable={false} style={{ width: W, height: H }}>
            <Canvas style={{ width: W, height: H }}>
              <Picture picture={picture} />
              <Group>
                <Rect x={fx} y={fy} width={fw} height={fh} color="#ffffff" style="stroke" strokeWidth={1.5} />
              </Group>
            </Canvas>
          </View>
        </GestureDetector>
      </Glass>
      <Pressable onPress={() => setCollapsed(true)} hitSlop={8} style={styles.hide} accessibilityLabel="Réduire la mini-carte">
        <Text style={styles.hideText}>–</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute' },
  card: { borderRadius: 14, overflow: 'hidden', padding: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.glassBorder },
  hide: { position: 'absolute', top: -8, left: -8, width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(12,22,34,0.85)', alignItems: 'center', justifyContent: 'center' },
  hideText: { color: theme.text, fontSize: 14, fontWeight: '800', lineHeight: 16 },
  reopen: { position: 'absolute', width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(12,22,34,0.75)', alignItems: 'center', justifyContent: 'center' },
  reopenText: { fontSize: 20 },
});
