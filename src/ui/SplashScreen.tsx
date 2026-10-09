import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeOut, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { PALETTE, shade } from '../engine/palette';

/** Petit logo isométrique : trois blocs R / C / I extrudés. */
function Logo() {
  const block = (cx: number, cy: number, h: number, color: string) => {
    const w = 22;
    const d = 11;
    const top = Skia.Path.Polygon(
      [
        { x: cx, y: cy - d - h },
        { x: cx + w, y: cy - h },
        { x: cx, y: cy + d - h },
        { x: cx - w, y: cy - h },
      ],
      true,
    );
    const left = Skia.Path.Polygon(
      [
        { x: cx - w, y: cy },
        { x: cx, y: cy + d },
        { x: cx, y: cy + d - h },
        { x: cx - w, y: cy - h },
      ],
      true,
    );
    const right = Skia.Path.Polygon(
      [
        { x: cx, y: cy + d },
        { x: cx + w, y: cy },
        { x: cx + w, y: cy - h },
        { x: cx, y: cy + d - h },
      ],
      true,
    );
    return [
      <Path key={`${cx}l`} path={left} color={shade(color, -0.12)} />,
      <Path key={`${cx}r`} path={right} color={shade(color, -0.38)} />,
      <Path key={`${cx}t`} path={top} color={shade(color, 0.22)} />,
    ];
  };
  return (
    <Canvas style={{ width: 160, height: 120 }}>
      {block(56, 70, 40, PALETTE.residential)}
      {block(104, 70, 26, PALETTE.industrial)}
      {block(80, 84, 64, PALETTE.commercial)}
    </Canvas>
  );
}

export function SplashScreen() {
  const pulse = useSharedValue(0.4);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, { duration: 700 }), -1, true);
  }, [pulse]);
  const dotStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <Animated.View exiting={FadeOut.duration(450)} style={[StyleSheet.absoluteFill, styles.root]}>
      <Logo />
      <Text style={styles.title}>MiniCity</Text>
      <View style={styles.loading}>
        <Animated.Text style={[styles.sub, dotStyle]}>Chargement de votre ville…</Animated.Text>
      </View>
      <Text style={styles.offline}>100 % hors ligne</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: PALETTE.background, alignItems: 'center', justifyContent: 'center', gap: 6 },
  title: { color: '#fff', fontSize: 40, fontWeight: '900', letterSpacing: -1 },
  loading: { height: 24, justifyContent: 'center' },
  sub: { color: 'rgba(255,255,255,0.7)', fontSize: 15, fontWeight: '600' },
  offline: { position: 'absolute', bottom: 48, color: 'rgba(255,255,255,0.4)', fontSize: 12, fontWeight: '700' },
});
