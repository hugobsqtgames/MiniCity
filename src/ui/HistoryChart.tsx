import { Canvas, Line, Path, Skia, vec } from '@shopify/react-native-skia';
import { useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import { Text } from './Text';
import { formatMoney, formatNumber, theme } from './theme';

const HEIGHT = 92;

/**
 * Courbe d'historique (une série mensuelle). Échelle automatique, valeur
 * actuelle et extrêmes affichés : lisible d'un coup d'œil sur téléphone.
 */
export function HistoryChart({
  label,
  data,
  color,
  unit = '',
  money = false,
}: {
  label: string;
  data: number[];
  color: string;
  unit?: string;
  money?: boolean;
}) {
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));

  const { line, fill, min, max, zeroY } = useMemo(() => {
    const pts = data.length ? data : [0];
    let lo = Math.min(...pts);
    let hi = Math.max(...pts);
    if (hi - lo < 1) {
      hi += 1;
      lo -= unit === '%' ? 0 : 1;
    }
    const pad = 6;
    const h = HEIGHT - pad * 2;
    const xAt = (i: number) => (pts.length === 1 ? width : (i / (pts.length - 1)) * width);
    const yAt = (v: number) => pad + h - ((v - lo) / (hi - lo)) * h;
    const lb = Skia.PathBuilder.Make();
    pts.forEach((v, i) => (i === 0 ? lb.moveTo(xAt(i), yAt(v)) : lb.lineTo(xAt(i), yAt(v))));
    const fb = Skia.PathBuilder.Make();
    fb.moveTo(0, HEIGHT);
    pts.forEach((v, i) => fb.lineTo(xAt(i), yAt(v)));
    fb.lineTo(xAt(pts.length - 1), HEIGHT).close();
    return { line: lb.detach(), fill: fb.detach(), min: lo, max: hi, zeroY: lo < 0 && hi > 0 ? yAt(0) : null };
  }, [data, width, unit]);

  const last = data[data.length - 1] ?? 0;
  const fmt = (v: number) => (money ? formatMoney(v) : `${formatNumber(v)}${unit}`);

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.label}>{label}</Text>
        <Text style={[styles.value, { color }]}>{fmt(last)}</Text>
      </View>
      <View onLayout={onLayout} style={styles.plot}>
        {width > 0 && (
          <Canvas style={{ width, height: HEIGHT }}>
            <Path path={fill} color={color} opacity={0.18} />
            {zeroY !== null && <Line p1={vec(0, zeroY)} p2={vec(width, zeroY)} color="rgba(255,255,255,0.35)" strokeWidth={1} />}
            <Path path={line} color={color} style="stroke" strokeWidth={2.2} strokeJoin="round" strokeCap="round" />
          </Canvas>
        )}
        {data.length < 2 && <Text style={styles.empty}>Pas encore assez de mois écoulés</Text>}
      </View>
      <View style={styles.head}>
        <Text style={styles.axis}>min {fmt(Math.round(min))}</Text>
        <Text style={styles.axis}>{data.length} mois</Text>
        <Text style={styles.axis}>max {fmt(Math.round(max))}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 12, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.07)', gap: 6 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  label: { color: theme.text, fontSize: 14, fontWeight: '800' },
  value: { fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  plot: { height: HEIGHT, justifyContent: 'center' },
  empty: { position: 'absolute', alignSelf: 'center', color: theme.textDim, fontSize: 12 },
  axis: { color: theme.textDim, fontSize: 10, fontVariant: ['tabular-nums'] },
});
