import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useGameStore } from '../store/useGameStore';
import { Text } from './Text';
import { Glass } from './Glass';
import { TOOLBAR_HEIGHT } from './Toolbar';
import { theme } from './theme';

/** Fiche du citoyen touché sur la carte (voiture, bus, piéton…). */
export function CitizenCard() {
  const insets = useSafeAreaInsets();
  const citizen = useGameStore((s) => s.citizen);
  const close = useGameStore((s) => s.showCitizen);
  if (!citizen) return null;

  const moodColor = citizen.mood >= 60 ? theme.positive : citizen.mood >= 40 ? theme.i : theme.negative;
  const face = citizen.mood >= 60 ? '😊' : citizen.mood >= 40 ? '😐' : '😠';
  const initials = citizen.name
    .split(' ')
    .map((p) => p[0])
    .join('');

  return (
    <Animated.View
      key={citizen.name}
      entering={FadeInDown.springify().damping(18)}
      exiting={FadeOutDown.duration(150)}
      style={[styles.wrap, { bottom: insets.bottom + TOOLBAR_HEIGHT + 16 }]}
    >
      <Glass intensity={45} style={styles.card}>
        <View style={styles.header}>
          <View style={[styles.avatar, { borderColor: moodColor }]}>
            <Text style={styles.initials}>{initials}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{citizen.name}</Text>
            <Text style={styles.sub}>
              {citizen.age} ans · {citizen.role}
            </Text>
          </View>
          <Pressable onPress={() => close(null)} hitSlop={10} accessibilityLabel="Fermer">
            <Text style={styles.close}>✕</Text>
          </Pressable>
        </View>
        <View style={styles.moodRow}>
          <Text style={styles.face}>{face}</Text>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${citizen.mood}%`, backgroundColor: moodColor }]} />
          </View>
          <Text style={[styles.moodValue, { color: moodColor }]}>{citizen.mood} %</Text>
        </View>
        <Text style={styles.quote}>« {citizen.quote} »</Text>
        {citizen.home && (
          <Text style={styles.sub}>
            🏠 Habite en ({citizen.home.x}, {citizen.home.y})
          </Text>
        )}
      </Glass>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: theme.gutter, right: theme.gutter, maxWidth: 460 },
  card: { borderRadius: 18, overflow: 'hidden', padding: 14, gap: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.glassBorder },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  initials: { color: theme.text, fontSize: 16, fontWeight: '800' },
  name: { color: theme.text, fontSize: 17, fontWeight: '800' },
  sub: { color: theme.textDim, fontSize: 13 },
  close: { color: theme.textDim, fontSize: 16, fontWeight: '700' },
  moodRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  face: { fontSize: 18 },
  track: { flex: 1, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4 },
  moodValue: { fontSize: 13, fontWeight: '800', width: 44, textAlign: 'right', fontVariant: ['tabular-nums'] },
  quote: { color: theme.text, fontSize: 15, fontStyle: 'italic', lineHeight: 20 },
});
