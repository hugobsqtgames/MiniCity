import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { tileIndex, type TileType } from '../engine/map';
import { JOBS_C, JOBS_I, RESIDENTS } from '../sim/constants';
import { computeRoadAccess } from '../sim/simulation';
import { useGameStore } from '../store/useGameStore';
import { TOOLBAR_HEIGHT } from './Toolbar';
import { formatNumber, theme } from './theme';
import { Glass } from './Glass';

const NAMES: Record<TileType, string> = {
  GRASS: 'Herbe',
  DIRT: 'Terrain vague',
  ROAD: 'Route',
  R: 'Zone résidentielle',
  C: 'Zone commerciale',
  I: 'Zone industrielle',
  POWER: 'Centrale électrique',
};
const LEVELS = ['Parcelle vide', 'Niveau 1', 'Niveau 2', 'Niveau 3'];

/** Fiche de la tuile inspectée (outil Explorer). */
export function TileInfo() {
  const insets = useSafeAreaInsets();
  const selected = useGameStore((s) => s.selected);
  const tiles = useGameStore((s) => s.tiles);
  const size = useGameStore((s) => s.gridSize);
  const clear = useGameStore((s) => s.setTool);

  const info = useMemo(() => {
    if (!selected) return null;
    const idx = tileIndex(selected.x, selected.y, size);
    const t = tiles[idx];
    const isZone = t.type === 'R' || t.type === 'C' || t.type === 'I';
    const road = isZone ? computeRoadAccess(tiles, size)[idx] === 1 : false;
    const lines: string[] = [];
    if (isZone) {
      lines.push(LEVELS[t.density]);
      lines.push(t.powered ? '⚡ Alimentée' : '⚠️ Pas de courant');
      lines.push(road ? '🛣️ Accès routier' : '⚠️ Pas de route à moins de 3 cases');
      if (t.type === 'R') lines.push(`👨‍👩‍👧‍👦 ${formatNumber(RESIDENTS[t.density])} habitants`);
      if (t.type === 'C') lines.push(`💼 ${formatNumber(JOBS_C[t.density])} emplois`);
      if (t.type === 'I') lines.push(`🏭 ${formatNumber(JOBS_I[t.density])} emplois`);
      lines.push(`💎 Valeur foncière ${t.value}/100`);
    } else if (t.type === 'POWER') {
      lines.push('Alimente le réseau jusqu’à 15 cases', 'Entretien $120/mois');
    } else if (t.type === 'ROAD') {
      lines.push('Transporte aussi le courant', 'Entretien $1/mois');
    }
    return { title: NAMES[t.type], lines, x: t.x, y: t.y };
  }, [selected, tiles, size]);

  if (!info) return null;
  return (
    <Animated.View
      entering={FadeInDown.springify().damping(18)}
      exiting={FadeOutDown.duration(150)}
      style={[styles.wrap, { bottom: insets.bottom + TOOLBAR_HEIGHT + 16 }]}
    >
      <Glass intensity={45} style={styles.card}>
        <View style={styles.header}>
          <Text style={styles.title}>{info.title}</Text>
          <Text style={styles.coords}>
            ({info.x}, {info.y})
          </Text>
          <Pressable onPress={() => clear('inspect')} hitSlop={10}>
            <Text style={styles.close}>✕</Text>
          </Pressable>
        </View>
        {info.lines.map((l) => (
          <Text key={l} style={styles.line}>
            {l}
          </Text>
        ))}
      </Glass>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: theme.gutter, right: theme.gutter },
  card: {
    borderRadius: 18,
    overflow: 'hidden',
    padding: 14,
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.glassBorder,
  },
  header: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 4 },
  title: { color: theme.text, fontSize: 17, fontWeight: '800' },
  coords: { color: theme.textDim, fontSize: 13, flex: 1, fontVariant: ['tabular-nums'] },
  close: { color: theme.textDim, fontSize: 16, fontWeight: '700' },
  line: { color: theme.text, fontSize: 14 },
});
