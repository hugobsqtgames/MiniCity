import { useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeInRight, FadeOut, FadeOutRight } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HEAT_STOPS } from '../engine/renderer';
import { CHALLENGES } from '../sim/challenges';
import { DATA_VIEWS, type DataView } from '../sim/constants';
import { useGameStore } from '../store/useGameStore';
import { Text } from './Text';
import { HUD_HEIGHT } from './Hud';
import { WIDE_LAYOUT } from './MenuSheet';
import { theme } from './theme';
import { Glass } from './Glass';

const LEGENDS: Record<Exclude<DataView, 'none'>, [string, string]> = {
  traffic: ['fluide', 'bouchons'],
  pollution: ['air pur', 'très pollué'],
  crime: ['sûr', 'dangereux'],
  value: ['quartier chic', 'peu prisé'],
  garbage: ['propre', 'ordures'],
  happiness: ['heureux', 'mécontents'],
  power: ['alimenté', 'sans courant'],
  water: ['eau claire', 'eau polluée'],
  health: ['en bonne santé', 'épidémie'],
  districts: ['', ''],
};

function RoundBtn({ label, onPress, disabled, active, a11y }: { label: string; onPress: () => void; disabled?: boolean; active?: boolean; a11y: string }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      style={({ pressed }) => [styles.btn, active && styles.btnActive, disabled && { opacity: 0.35 }, pressed && { opacity: 0.6 }]}
    >
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

/**
 * Commandes de la carte, en colonne sur le bord droit : annuler / rétablir,
 * rotation par quarts de tour et vues de données (trafic, pollution…).
 */
export function MapControls() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_LAYOUT;
  const canUndo = useGameStore((s) => s.past.length > 0);
  const canRedo = useGameStore((s) => s.future.length > 0);
  const undo = useGameStore((s) => s.undo);
  const redo = useGameStore((s) => s.redo);
  const rotate = useGameStore((s) => s.rotate);
  const dataView = useGameStore((s) => s.dataView);
  const setDataView = useGameStore((s) => s.setDataView);
  const [viewsOpen, setViewsOpen] = useState(false);
  const urgent = useGameStore((s) => s.advice.filter((a) => a.severity >= 2).length);
  const openMenu = useGameStore((s) => s.openMenu);
  const openChallenges = useGameStore((s) => s.openChallenges);
  const doneCount = useGameStore((s) => Object.keys(s.challenges).length);
  const colorblind = useGameStore((s) => s.settings.colorblind);
  const current = DATA_VIEWS.find((v) => v.id === dataView) ?? DATA_VIEWS[0];

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + (wide ? 6 : HUD_HEIGHT + 64), right: insets.right + theme.gutter }]}>
      <Glass intensity={45} style={styles.column}>
        <RoundBtn label="↶" a11y="Annuler" onPress={undo} disabled={!canUndo} />
        <RoundBtn label="↷" a11y="Rétablir" onPress={redo} disabled={!canRedo} />
        <View style={styles.sep} />
        <RoundBtn label="⟲" a11y="Tourner la vue à gauche" onPress={() => rotate(-1)} />
        <RoundBtn label="⟳" a11y="Tourner la vue à droite" onPress={() => rotate(1)} />
        <View style={styles.sep} />
        <RoundBtn label={current.icon} a11y="Vues de données" onPress={() => setViewsOpen((o) => !o)} active={viewsOpen || dataView !== 'none'} />
        <View style={styles.sep} />
        <View>
          <RoundBtn label="💡" a11y="Conseillers" onPress={() => openMenu('advisors')} />
          {urgent > 0 && (
            <View style={styles.badge} pointerEvents="none">
              <Text style={styles.badgeText}>{urgent}</Text>
            </View>
          )}
        </View>
        <View>
          <RoundBtn label="🏆" a11y="Arbre de défis" onPress={() => openChallenges(true)} />
          <View style={[styles.badge, styles.badgeGold]} pointerEvents="none">
            <Text style={styles.badgeText}>
              {doneCount}/{CHALLENGES.length}
            </Text>
          </View>
        </View>
      </Glass>

      {viewsOpen && (
        <Animated.View entering={FadeInRight.duration(160)} exiting={FadeOutRight.duration(120)} style={styles.views}>
          <Glass intensity={45} style={styles.viewsGlass}>
            {DATA_VIEWS.map((v) => (
              <Pressable
                key={v.id}
                onPress={() => {
                  setDataView(v.id);
                  setViewsOpen(false);
                }}
                style={[styles.viewItem, v.id === dataView && styles.viewItemOn]}
              >
                <Text style={styles.viewText}>
                  {v.icon} {v.label}
                </Text>
              </Pressable>
            ))}
          </Glass>
        </Animated.View>
      )}

      {dataView !== 'none' && dataView !== 'districts' && !viewsOpen && (
        <Animated.View entering={FadeIn} exiting={FadeOut} style={styles.legendWrap} pointerEvents="none">
          <Glass intensity={45} style={styles.legend}>
            <Text style={styles.legendTitle}>
              {current.icon} {current.label}
            </Text>
            <View style={styles.legendBar}>
              {(colorblind ? HEAT_STOPS.colorblind : HEAT_STOPS.normal).map((c) => (
                <View key={c} style={[styles.legendCell, { backgroundColor: c }]} />
              ))}
            </View>
            <View style={styles.legendLabels}>
              <Text style={styles.legendLabel}>{LEGENDS[dataView][0]}</Text>
              <Text style={styles.legendLabel}>{LEGENDS[dataView][1]}</Text>
            </View>
          </Glass>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', alignItems: 'flex-end' },
  column: {
    borderRadius: 22,
    overflow: 'hidden',
    padding: 5,
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.glassBorder,
  },
  btn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.1)' },
  btnActive: { backgroundColor: 'rgba(52,152,219,0.85)' },
  btnText: { color: theme.text, fontSize: 19, fontWeight: '800' },
  badge: { position: 'absolute', top: -4, right: -6, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, backgroundColor: '#e74c3c', alignItems: 'center', justifyContent: 'center' },
  badgeGold: { backgroundColor: '#b7950b', top: undefined, bottom: -4, right: -10 },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  sep: { height: 1, marginHorizontal: 6, backgroundColor: 'rgba(255,255,255,0.15)' },
  views: { position: 'absolute', right: 56, bottom: 0 },
  viewsGlass: { borderRadius: 16, overflow: 'hidden', padding: 6, gap: 2, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.glassBorder },
  viewItem: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 },
  viewItemOn: { backgroundColor: 'rgba(255,255,255,0.18)' },
  viewText: { color: theme.text, fontSize: 14, fontWeight: '700' },
  legendWrap: { marginTop: 8 },
  legend: { borderRadius: 14, overflow: 'hidden', padding: 8, gap: 4, width: 150, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.glassBorder },
  legendTitle: { color: theme.text, fontSize: 12, fontWeight: '800' },
  legendBar: { flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden' },
  legendCell: { flex: 1 },
  legendLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  legendLabel: { color: theme.textDim, fontSize: 10, fontWeight: '700' },
});
