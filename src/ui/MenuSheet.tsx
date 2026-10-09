import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { INCOME_PER_CITIZEN, MAX_TAX, MIN_TAX, SPEEDS } from '../sim/constants';
import { useGameStore } from '../store/useGameStore';
import { formatMoney, formatNumber, theme } from './theme';
import { Glass } from './Glass';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowRight}>{children}</View>
    </View>
  );
}

function Btn({ label, onPress, tone = 'default', selected }: { label: string; onPress: () => void; tone?: 'default' | 'primary' | 'danger'; selected?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.btn,
        tone === 'primary' && styles.btnPrimary,
        tone === 'danger' && styles.btnDanger,
        selected && styles.btnSelected,
        pressed && { opacity: 0.7 },
      ]}
    >
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

/** Menu de la ville : vitesse, impôts, bilan, nouvelle partie / ville de démo, sauvegarde. */
export function MenuSheet({ onClose, onSaveNow, lastSavedAt }: { onClose: () => void; onSaveNow: () => void; lastSavedAt: number | null }) {
  const insets = useSafeAreaInsets();
  const s = useGameStore();

  const coverage = s.stats.zones ? Math.round((s.stats.poweredZones / s.stats.zones) * 100) : 0;
  const perCitizen = (s.taxRate / 100) * INCOME_PER_CITIZEN;

  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View entering={FadeIn} exiting={FadeOut} style={[StyleSheet.absoluteFill, styles.backdrop]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Fermer le menu" />
      </Animated.View>
      <Animated.View
        entering={SlideInDown.springify().damping(20)}
        exiting={SlideOutDown.duration(200)}
        style={[styles.sheetWrap, { paddingBottom: insets.bottom + 12 }]}
      >
        <Glass intensity={60} style={styles.sheet} tint="rgba(12,22,34,0.72)">
          <View style={styles.grabber} />
          <Text style={styles.title}>MiniCity</Text>

          <Text style={styles.section}>Simulation</Text>
          <Row label="Vitesse">
            <Btn label={s.paused ? '▶︎' : '❚❚'} onPress={s.togglePause} selected={s.paused} />
            {SPEEDS.map((sp) => (
              <Btn key={sp} label={`${sp}×`} onPress={() => s.setSpeed(sp)} selected={!s.paused && s.speed === sp} />
            ))}
          </Row>
          <Row label={`Impôts ${s.taxRate} %`}>
            <Btn label="−" onPress={() => s.setTax(s.taxRate - 1)} />
            <View style={styles.taxTrack}>
              <View style={[styles.taxFill, { width: `${((s.taxRate - MIN_TAX) / (MAX_TAX - MIN_TAX)) * 100}%` }]} />
            </View>
            <Btn label="+" onPress={() => s.setTax(s.taxRate + 1)} />
          </Row>

          <Text style={styles.section}>Bilan du mois</Text>
          <View style={styles.statsGrid}>
            <Stat label="Recettes" value={`+${formatMoney(s.lastIncome)}`} color={theme.positive} />
            <Stat label="Entretien" value={`-${formatMoney(s.lastExpenses)}`} color={theme.negative} />
            <Stat label="Par habitant" value={`$${perCitizen.toFixed(2)}`} />
            <Stat label="Emplois" value={formatNumber(s.stats.jobsC + s.stats.jobsI)} />
            <Stat label="Routes" value={formatNumber(s.stats.roads)} />
            <Stat label="Réseau ⚡" value={`${coverage} %`} />
          </View>

          <Text style={styles.section}>Partie</Text>
          <View style={styles.actions}>
            <Btn label="💾 Sauvegarder" onPress={onSaveNow} />
            <Btn label="🏙️ Ville de démo" tone="primary" onPress={() => { s.loadDemoCity(); onClose(); }} />
            <Btn label="🌱 Nouvelle ville" tone="danger" onPress={() => { s.newCity(); onClose(); }} />
          </View>
          <Text style={styles.foot}>
            100 % hors ligne · sauvegarde auto toutes les 15 s
            {lastSavedAt ? ` · dernière à ${new Date(lastSavedAt).toTimeString().slice(0, 8)}` : ''}
          </Text>
        </Glass>
      </Animated.View>
    </View>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: 'rgba(0,0,0,0.45)' },
  sheetWrap: { position: 'absolute', left: 8, right: 8, bottom: 0 },
  sheet: {
    borderRadius: 28,
    overflow: 'hidden',
    padding: 20,
    paddingTop: 10,
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.glassBorder,
  },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.3)', marginBottom: 6 },
  title: { color: theme.text, fontSize: 24, fontWeight: '800' },
  section: { color: theme.textDim, fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1, marginTop: 6 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  rowLabel: { color: theme.text, fontSize: 15, fontWeight: '700' },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  btn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.12)' },
  btnPrimary: { backgroundColor: 'rgba(52,152,219,0.85)' },
  btnDanger: { backgroundColor: 'rgba(231,76,60,0.8)' },
  btnSelected: { backgroundColor: 'rgba(46,204,113,0.85)' },
  btnText: { color: theme.text, fontSize: 14, fontWeight: '800' },
  taxTrack: { width: 90, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden' },
  taxFill: { height: '100%', backgroundColor: theme.i },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stat: { width: '31.5%', padding: 10, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.08)' },
  statLabel: { color: theme.textDim, fontSize: 11, fontWeight: '700' },
  statValue: { color: theme.text, fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  foot: { color: theme.textDim, fontSize: 11, marginTop: 4 },
});
