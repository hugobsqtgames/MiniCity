import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CHALLENGE_BY_ID, CHALLENGES, challengeContext, layoutTree, type Challenge, type Frame } from '../sim/challenges';
import { useGameStore } from '../store/useGameStore';
import { Text } from './Text';
import { formatDate, formatMoney, formatNumber, theme } from './theme';

const NODE = 58;
const COL_W = 104;
const ROW_H = 78;
const PAD = 40;

type State = 'done' | 'open' | 'locked';

const FRAME_STYLE: Record<Frame, object> = {
  task: { borderRadius: 10 },
  goal: { borderRadius: NODE / 2 },
  challenge: { borderRadius: 16, borderWidth: 3 },
};

/**
 * Arbre de défis façon « progrès » de Minecraft : on le parcourt en glissant
 * dans les deux sens, chaque défi réussi débloque les suivants.
 */
export function ChallengeTree() {
  const insets = useSafeAreaInsets();
  const open = useGameStore((s) => s.challengesOpen);
  const close = useGameStore((s) => s.openChallenges);
  const done = useGameStore((s) => s.challenges);
  const tiles = useGameStore((s) => s.tiles);
  const stats = useGameStore((s) => s.stats);
  const treasury = useGameStore((s) => s.treasury);
  const month = useGameStore((s) => s.month);
  const counters = useGameStore((s) => s.counters);
  const taxes = useGameStore((s) => s.taxes);
  const funding = useGameStore((s) => s.funding);
  const ordinances = useGameStore((s) => s.ordinances);
  const isDemo = useGameStore((s) => s.isDemo);
  const [selected, setSelected] = useState<string>('start');

  const layout = useMemo(() => layoutTree(), []);
  const pos = useMemo(() => Object.fromEntries(layout.nodes.map((n) => [n.id, { x: PAD + n.col * COL_W, y: PAD + n.row * ROW_H }])), [layout]);
  const width = PAD * 2 + (layout.cols - 1) * COL_W + NODE;
  const height = PAD * 2 + (layout.rows - 1) * ROW_H + NODE;

  const ctx = useMemo(
    () => (open ? challengeContext(tiles, stats, treasury, month, counters, { taxes, funding, ordinances }) : null),
    [open, tiles, stats, treasury, month, counters, taxes, funding, ordinances],
  );
  const stateOf = (c: Challenge): State => (done[c.id] !== undefined ? 'done' : !c.parent || done[c.parent] !== undefined ? 'open' : 'locked');

  // Liens coudés parent → enfant, dorés quand l'enfant est réussi.
  const links = useMemo(() => {
    const dim = Skia.PathBuilder.Make();
    const gold = Skia.PathBuilder.Make();
    for (const c of CHALLENGES) {
      if (!c.parent) continue;
      const a = pos[c.parent];
      const b = pos[c.id];
      const ax = a.x + NODE;
      const ay = a.y + NODE / 2;
      const bx = b.x;
      const by = b.y + NODE / 2;
      const mx = ax + (bx - ax) / 2;
      const p = done[c.id] !== undefined ? gold : dim;
      p.moveTo(ax, ay);
      p.lineTo(mx, ay);
      p.lineTo(mx, by);
      p.lineTo(bx, by);
    }
    return { dim: dim.detach(), gold: gold.detach() };
  }, [pos, done]);

  if (!open || !ctx) return null;
  const count = Object.keys(done).length;
  const sel = CHALLENGE_BY_ID[selected];
  const [cur, goal] = sel.progress(ctx);
  const selState = stateOf(sel);
  const fmt = (v: number) => (goal >= 1000 ? formatNumber(v) : String(Math.round(v)));

  return (
    <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(150)} style={[StyleSheet.absoluteFill, styles.root, { paddingTop: insets.top + 8 }]}>
      <View style={styles.header}>
        <Text style={styles.title}>🏆 Défis</Text>
        <View style={styles.progress}>
          <View style={[styles.progressFill, { width: `${(count / CHALLENGES.length) * 100}%` }]} />
        </View>
        <Text style={styles.count}>
          {count}/{CHALLENGES.length}
        </Text>
        <Pressable onPress={() => close(false)} hitSlop={10} accessibilityLabel="Fermer les défis">
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>

      {isDemo && <Text style={styles.demo}>🏙️ Ville de démo : les défis ne comptent pas ici. Lancez une nouvelle ville pour les réussir.</Text>}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 8 }} nestedScrollEnabled>
        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false}>
          <View style={{ width, height }}>
            <Canvas style={StyleSheet.absoluteFill}>
              <Path path={links.dim} color="rgba(255,255,255,0.22)" style="stroke" strokeWidth={3} />
              <Path path={links.gold} color="#f4d03f" style="stroke" strokeWidth={3} />
            </Canvas>
            {CHALLENGES.map((c) => {
              const st = stateOf(c);
              const p = pos[c.id];
              return (
                <Pressable
                  key={c.id}
                  onPress={() => setSelected(c.id)}
                  accessibilityLabel={`${c.title}${st === 'done' ? ', réussi' : st === 'locked' ? ', verrouillé' : ''}`}
                  style={[
                    styles.node,
                    FRAME_STYLE[c.frame],
                    { left: p.x, top: p.y },
                    st === 'done' && styles.nodeDone,
                    st === 'open' && styles.nodeOpen,
                    st === 'locked' && styles.nodeLocked,
                    c.frame === 'challenge' && { borderColor: st === 'locked' ? '#7d6608' : '#f1c40f' },
                    selected === c.id && styles.nodeSelected,
                  ]}
                >
                  <Text style={[styles.icon, st === 'locked' && { opacity: 0.35 }]}>{st === 'locked' ? '❔' : c.icon}</Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </ScrollView>

      <View style={[styles.detail, { paddingBottom: insets.bottom + 14 }]}>
        <View style={styles.detailHead}>
          <Text style={styles.detailIcon}>{selState === 'locked' ? '❔' : sel.icon}</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.detailTitle}>{selState === 'locked' ? 'Défi verrouillé' : sel.title}</Text>
            <Text style={styles.detailKind}>
              {sel.frame === 'task' ? 'Tâche' : sel.frame === 'goal' ? 'Objectif' : 'Défi ⭐'} · récompense {formatMoney(sel.reward)}
            </Text>
          </View>
        </View>
        <Text style={styles.detailDesc}>
          {selState === 'locked' ? `Réussissez d’abord « ${CHALLENGE_BY_ID[sel.parent!].title} ».` : sel.desc}
        </Text>
        {selState === 'done' ? (
          <Text style={styles.doneText}>✅ Réussi en {formatDate(done[sel.id])}</Text>
        ) : selState === 'open' ? (
          <View style={styles.barRow}>
            <View style={styles.bar}>
              <View style={[styles.barFill, { width: `${Math.max(0, Math.min(100, (cur / goal) * 100))}%` }]} />
            </View>
            <Text style={styles.barText}>
              {goal === 1 ? (cur >= 1 ? 'OK' : 'pas encore') : `${fmt(Math.min(cur, goal))} / ${fmt(goal)}`}
            </Text>
          </View>
        ) : null}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: '#1d1712' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 8 },
  title: { color: theme.text, fontSize: 22, fontWeight: '800' },
  progress: { flex: 1, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: '#f4d03f' },
  count: { color: theme.textDim, fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  demo: { color: '#f4d03f', fontSize: 13, fontWeight: '700', paddingHorizontal: 16, paddingBottom: 6 },
  close: { color: theme.textDim, fontSize: 20, fontWeight: '700', marginLeft: 4 },
  node: {
    position: 'absolute',
    width: NODE,
    height: NODE,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.35)',
    backgroundColor: '#3b2f25',
  },
  nodeDone: { backgroundColor: '#b7950b', borderColor: '#f9e79f' },
  nodeOpen: { backgroundColor: '#4e3d30', borderColor: '#d5d8dc' },
  nodeLocked: { backgroundColor: '#2a221b', borderColor: 'rgba(255,255,255,0.12)' },
  nodeSelected: { transform: [{ scale: 1.12 }], shadowColor: '#fff', shadowOpacity: 0.6, shadowRadius: 8, elevation: 6 },
  icon: { fontSize: 26 },
  detail: { backgroundColor: 'rgba(0,0,0,0.45)', paddingHorizontal: 18, paddingTop: 14, gap: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.2)' },
  detailHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  detailIcon: { fontSize: 32 },
  detailTitle: { color: theme.text, fontSize: 18, fontWeight: '800' },
  detailKind: { color: '#f4d03f', fontSize: 12, fontWeight: '700' },
  detailDesc: { color: theme.text, fontSize: 14, lineHeight: 19 },
  doneText: { color: theme.positive, fontSize: 14, fontWeight: '800' },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  bar: { flex: 1, height: 10, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: theme.positive },
  barText: { color: theme.textDim, fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'], minWidth: 90, textAlign: 'right' },
});
