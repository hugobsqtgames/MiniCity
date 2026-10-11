import { useEffect } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isMonument, isVenue } from '../engine/map';
import { MONUMENT_UNLOCK, NUCLEAR_UNLOCK, TOOLS, VENUE_UNLOCK, type ToolDef, type ToolGroup } from '../sim/constants';
import { useGameStore } from '../store/useGameStore';
import { Text } from './Text';
import { formatMoney, formatNumber, theme } from './theme';
import { Glass } from './Glass';

export const TOOLBAR_HEIGHT = 120;

/** Familles d'outils, dans l'ordre de la barre. */
const GROUPS = TOOLS.map((t) => t.group).filter((g, i, all) => all.indexOf(g) === i);

const GROUP_LABELS: Record<ToolGroup, string> = {
  base: 'Outils',
  zones: 'Routes & zones',
  energy: 'Énergie',
  networks: 'Eau & transports',
  services: 'Services',
  waste: 'Déchets',
  leisure: 'Loisirs',
  monuments: 'Monuments',
};

function ToolButton({ tool, active, locked, onPress }: { tool: ToolDef; active: boolean; locked: string | null; onPress: () => void }) {
  const lift = useSharedValue(active ? 1 : 0);
  useEffect(() => {
    lift.set(withSpring(active ? 1 : 0, { damping: 14, stiffness: 220 }));
  }, [active, lift]);

  // L'outil sélectionné se surélève et grossit légèrement.
  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: -8 * lift.get() }, { scale: 1 + 0.06 * lift.get() }],
  }));

  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={tool.label} accessibilityState={{ selected: active }}>
      <Animated.View style={[styles.tool, active && { borderColor: tool.color, backgroundColor: 'rgba(255,255,255,0.16)' }, style]}>
        <View style={[styles.swatch, { backgroundColor: tool.color }]} />
        <Text style={[styles.icon, locked !== null && styles.lockedIcon]}>{tool.icon}</Text>
        <Text style={styles.label} numberOfLines={1}>
          {tool.label}
        </Text>
        <Text style={styles.cost} numberOfLines={1}>
          {locked === 'construit' ? '✓ construit' : locked !== null ? `🔒 ${locked}` : tool.cost > 0 ? formatMoney(tool.cost) : ' '}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

export function Toolbar() {
  const insets = useSafeAreaInsets();
  const tool = useGameStore((s) => s.tool);
  const setTool = useGameStore((s) => s.setTool);
  const showToast = useGameStore((s) => s.showToast);
  const population = useGameStore((s) => s.stats.population);
  const tiles = useGameStore((s) => s.tiles);
  const { width } = useWindowDimensions();
  // Monuments : verrouillés sous un seuil de population, un seul exemplaire chacun.
  const built = new Set(tiles.filter((t) => isMonument(t.type)).map((t) => t.type));
  const needOf = (t: ToolDef): number => {
    if (!t.places) return 0;
    if (isMonument(t.places)) return MONUMENT_UNLOCK[t.places];
    if (isVenue(t.places)) return VENUE_UNLOCK[t.places];
    return t.places === 'NUCLEAR' ? NUCLEAR_UNLOCK : 0;
  };
  const lockOf = (t: ToolDef): string | null => {
    if (!t.places) return null;
    if (isMonument(t.places) && built.has(t.places)) return 'construit';
    const need = needOf(t);
    return population < need ? (need >= 1000 ? `${need / 1000}k hab.` : `${need} hab.`) : null;
  };

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: insets.bottom + 8 }, width >= 700 && styles.wrapWide]}>
      <Glass intensity={45} style={styles.glass}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scroll}>
          {GROUPS.map((g, gi) => (
            <View key={g} style={styles.group}>
              {gi > 0 && <View style={styles.divider} />}
              <View>
                {/* Étiquette de la famille d'outils, au-dessus de ses boutons. */}
                <Text style={styles.groupLabel} numberOfLines={1}>
                  {GROUP_LABELS[g]}
                </Text>
                <View style={styles.row}>
                  {TOOLS.filter((t) => t.group === g).map((t) => (
                    <ToolButton
                      key={t.id}
                      tool={t}
                      active={t.id === tool}
                      locked={lockOf(t)}
                      onPress={() => {
                        const lock = lockOf(t);
                        if (lock === 'construit') showToast(`${t.icon} ${t.label} : un seul exemplaire par ville`);
                        else if (lock) showToast(`🔒 ${t.label} : débloqué à ${formatNumber(needOf(t))} habitants`);
                        else setTool(t.id);
                      }}
                    />
                  ))}
                </View>
              </View>
            </View>
          ))}
        </ScrollView>
      </Glass>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: theme.gutter, right: theme.gutter },
  wrapWide: { left: 120, right: 120 },
  glass: {
    borderRadius: theme.radius,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.glassBorder,
  },
  scroll: { paddingHorizontal: 10, paddingTop: 8, paddingBottom: 10, gap: 8 },
  group: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  row: { flexDirection: 'row', gap: 8, paddingTop: 10 },
  groupLabel: {
    marginLeft: 4,
    color: theme.textDim,
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  lockedIcon: { opacity: 0.35 },
  divider: { width: 1, height: 56, backgroundColor: 'rgba(255,255,255,0.18)', marginHorizontal: 2 },
  tool: {
    width: 76,
    height: 84,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 2,
    borderColor: 'transparent',
    overflow: 'hidden',
  },
  swatch: { position: 'absolute', top: 0, left: 0, right: 0, height: 4 },
  icon: { fontSize: 30 },
  label: { color: theme.text, fontSize: 11, fontWeight: '700', marginTop: 2 },
  cost: { color: theme.textDim, fontSize: 10, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
