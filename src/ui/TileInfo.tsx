import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isZone, tileIndex, type TileType } from '../engine/map';
import { JOBS_C, JOBS_I, RESIDENTS, UPKEEP } from '../sim/constants';
import { computeCoverage, computeRoadAccess } from '../sim/simulation';
import { useGameStore } from '../store/useGameStore';
import { TOOLBAR_HEIGHT } from './Toolbar';
import { formatMoney, formatNumber, theme } from './theme';
import { Glass } from './Glass';

const NAMES: Record<TileType, string> = {
  GRASS: 'Herbe',
  DIRT: 'Terrain vague',
  ROAD: 'Route',
  R: 'Zone résidentielle',
  C: 'Zone commerciale',
  I: 'Zone industrielle',
  POWER: 'Centrale électrique',
  POLICE: 'Commissariat',
  FIRE: 'Caserne de pompiers',
  HOSPITAL: 'Hôpital',
  SCHOOL: 'École',
  WATER: "Château d'eau",
  METRO: 'Station de métro',
  PARK: 'Parc',
};
const LEVELS = ['Parcelle vide', 'Niveau 1', 'Niveau 2', 'Niveau 3'];
const SERVICE_TEXT: Partial<Record<TileType, string>> = {
  POLICE: 'Fait baisser la criminalité (rayon 10)',
  FIRE: 'Éteint les incendies (rayon 10)',
  HOSPITAL: 'Santé : + satisfaction, + valeur (rayon 12)',
  SCHOOL: 'Éducation : + satisfaction, + valeur (rayon 9)',
  WATER: "Alimente les canalisations (12 cases) s'il a du courant",
  METRO: 'Relie les stations : moins de voitures, + valeur (rayon 6)',
  PARK: 'Espaces verts : + valeur foncière (rayon 4)',
};

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
    const lines: string[] = [];
    if (t.fire > 0) lines.push(`🔥 EN FEU depuis ${t.fire} mois !`);
    if (isZone(t.type)) {
      const road = computeRoadAccess(tiles, size)[idx] === 1;
      const cov = computeCoverage(tiles, size);
      lines.push(LEVELS[t.density]);
      lines.push(`${t.powered ? '⚡ Alimentée' : '⚠️ Pas de courant'} · ${t.water ? '💧 Eau courante' : '⚠️ Pas d’eau'}`);
      lines.push(road ? '🛣️ Accès routier' : '⚠️ Pas de route à moins de 3 cases');
      if (t.type === 'R') lines.push(`👨‍👩‍👧‍👦 ${formatNumber(RESIDENTS[t.density])} habitants`);
      if (t.type === 'C') lines.push(`💼 ${formatNumber(JOBS_C[t.density])} emplois`);
      if (t.type === 'I') lines.push(`🏭 ${formatNumber(JOBS_I[t.density])} emplois`);
      const services = [
        cov.POLICE[idx] > 0 && '🚓',
        cov.FIRE[idx] > 0 && '🚒',
        cov.HOSPITAL[idx] > 0 && '🏥',
        cov.SCHOOL[idx] > 0 && '🏫',
        cov.METRO[idx] > 0 && '🚇',
      ].filter(Boolean);
      lines.push(services.length ? `Services : ${services.join(' ')}` : 'Aucun service public à proximité');
      lines.push(`💎 Valeur foncière ${t.value}/100`);
      if (!t.water && t.density >= 1) lines.push('💡 Il faut de l’eau pour dépasser le niveau 1');
    } else if (t.type === 'POWER') {
      lines.push('Alimente le réseau jusqu’à 15 cases', 'Entretien $120/mois');
    } else if (t.type === 'ROAD') {
      lines.push('Transporte aussi le courant et l’eau', 'Entretien $1/mois');
    } else if (SERVICE_TEXT[t.type]) {
      lines.push(SERVICE_TEXT[t.type]!);
      if (t.type !== 'PARK') lines.push(t.powered ? '⚡ En service' : '⚠️ Hors service : pas de courant');
      lines.push(`Entretien ${formatMoney(UPKEEP[t.type] ?? 0)}/mois`);
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
