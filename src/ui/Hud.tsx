import { useEffect } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SEASON_LABELS, seasonOf } from '../sim/constants';
import { EVENT_LABELS, WEATHER_LABELS } from '../sim/simulation';
import { useGameStore } from '../store/useGameStore';
import { Text } from './Text';
import { formatDate, formatMoney, formatNumber, theme } from './theme';
import { Glass } from './Glass';

const BAR_HEIGHT = 58;
/** Hauteur approximative du HUD (pour placer les éléments en dessous). */
export const HUD_HEIGHT = 124;

/** Jauge verticale de demande : remplie vers le haut si positive, vers le bas si négative. */
function DemandBar({ label, value, color }: { label: string; value: number; color: string }) {
  const v = useSharedValue(value);
  useEffect(() => {
    v.value = withSpring(value, { damping: 18, stiffness: 120 });
  }, [value, v]);

  const fill = useAnimatedStyle(() => {
    const h = Math.min(1, Math.abs(v.value)) * (BAR_HEIGHT / 2);
    return v.value >= 0 ? { height: h, bottom: BAR_HEIGHT / 2, opacity: 1 } : { height: h, top: BAR_HEIGHT / 2, opacity: 0.55 };
  });

  return (
    <View style={styles.barCol}>
      <View style={styles.barTrack}>
        <Animated.View style={[styles.barFill, { backgroundColor: color }, fill]} />
        <View style={styles.barZero} />
      </View>
      <Text style={[styles.barLabel, { color }]}>{label}</Text>
    </View>
  );
}

export function Hud({ onOpenMenu }: { onOpenMenu: () => void }) {
  const insets = useSafeAreaInsets();
  const treasury = useGameStore((s) => s.treasury);
  const population = useGameStore((s) => s.stats.population);
  const mood = useGameStore((s) => s.stats.happiness);
  const month = useGameStore((s) => s.month);
  const demand = useGameStore((s) => s.demand);
  const net = useGameStore((s) => s.lastIncome - s.lastExpenses);
  const speed = useGameStore((s) => s.speed);
  const paused = useGameStore((s) => s.paused);
  const togglePause = useGameStore((s) => s.togglePause);
  const setSpeed = useGameStore((s) => s.setSpeed);
  const weather = useGameStore((s) => s.weather);
  const cityEvents = useGameStore((s) => s.cityEvents);
  const openMenu = useGameStore((s) => s.openMenu);
  const season = SEASON_LABELS[seasonOf(month)];

  const { width } = useWindowDimensions();
  const cycleSpeed = () => setSpeed(speed === 3 ? 1 : ((speed + 1) as 2 | 3));

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + 6, left: insets.left + theme.gutter }, width >= 700 && styles.wrapWide]}>
      <Glass intensity={45} style={styles.glass}>
        <View style={styles.left}>
          <View style={styles.row}>
            <Text style={[styles.money, treasury < 0 && { color: theme.negative }]} numberOfLines={1} adjustsFontSizeToFit>
              {formatMoney(treasury)}
            </Text>
            <Text style={[styles.delta, { color: net >= 0 ? theme.positive : theme.negative }]}>
              {net >= 0 ? '+' : ''}
              {formatMoney(net)}/m
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.stat}>👨‍👩‍👧‍👦 {formatNumber(population)}</Text>
            <Text style={styles.stat} accessibilityLabel={`${formatDate(month)}, ${season.label}, ${WEATHER_LABELS[weather].label}`}>
              {weather === 'clear' ? season.icon : WEATHER_LABELS[weather].icon} {formatDate(month)}
            </Text>
            <Text style={[styles.stat, { color: mood >= 60 ? theme.positive : mood >= 40 ? theme.text : theme.negative }]}>
              {mood >= 60 ? '😊' : mood >= 40 ? '😐' : '😠'} {mood}%
            </Text>
          </View>
          <View style={styles.row}>
            <Pressable onPress={togglePause} style={styles.chip} hitSlop={6}>
              <Text style={styles.chipText}>{paused ? '▶︎' : '❚❚'}</Text>
            </Pressable>
            <Pressable onPress={cycleSpeed} style={[styles.chip, paused && styles.chipDim]} hitSlop={6}>
              <Text style={styles.chipText}>{'▸'.repeat(speed)} {speed}×</Text>
            </Pressable>
            <Pressable onPress={onOpenMenu} style={styles.chip} hitSlop={6}>
              <Text style={styles.chipText}>⚙︎ Menu</Text>
            </Pressable>
            {cityEvents.length > 0 && (
              <Pressable onPress={() => openMenu('events')} style={[styles.chip, styles.chipEvent]} hitSlop={6} accessibilityLabel="Événements en cours">
                <Text style={styles.chipText}>
                  {EVENT_LABELS[cityEvents[0].kind].icon}
                  {cityEvents.length > 1 ? ` ${cityEvents.length}` : ''}
                </Text>
              </Pressable>
            )}
          </View>
        </View>
        <View style={styles.bars}>
          <DemandBar label="R" value={demand.r} color={theme.r} />
          <DemandBar label="C" value={demand.c} color={theme.c} />
          <DemandBar label="I" value={demand.i} color={theme.i} />
        </View>
      </Glass>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: theme.gutter, right: theme.gutter },
  wrapWide: { right: undefined, width: 540 },
  glass: {
    flexDirection: 'row',
    borderRadius: theme.radius,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.glassBorder,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  left: { flex: 1, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  money: { color: theme.text, fontSize: 30, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: -0.5, flexShrink: 1 },
  delta: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  stat: { color: theme.text, fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  chipDim: { opacity: 0.5 },
  chipEvent: { backgroundColor: 'rgba(142,68,173,0.75)' },
  chipText: { color: theme.text, fontSize: 13, fontWeight: '700' },
  bars: { flexDirection: 'row', gap: 8, alignItems: 'center', paddingLeft: 12 },
  barCol: { alignItems: 'center', gap: 4 },
  barTrack: {
    width: 12,
    height: BAR_HEIGHT,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.1)',
    overflow: 'hidden',
  },
  barFill: { position: 'absolute', left: 0, right: 0 },
  barZero: { position: 'absolute', left: 0, right: 0, top: BAR_HEIGHT / 2 - 0.5, height: 1, backgroundColor: 'rgba(255,255,255,0.45)' },
  barLabel: { fontSize: 12, fontWeight: '800' },
});
