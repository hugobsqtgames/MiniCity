import { useEffect } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Tile } from '../engine/map';
import type { ToolId } from '../sim/constants';
import { useGameStore } from '../store/useGameStore';
import { Text } from './Text';
import { Glass } from './Glass';
import { HUD_HEIGHT } from './Hud';
import { theme } from './theme';

type Counts = Record<string, number>;
type Step = { title: string; text: string; tool?: ToolId; done: (c: Counts, pop: number, speed: number) => boolean };

/** Les premiers pas du maire, validés automatiquement en jouant. */
export const TUTORIAL_STEPS: Step[] = [
  {
    title: 'Tracez une rue',
    text: 'Choisissez « Rue » puis glissez le doigt sur la carte. Deux doigts pour déplacer et zoomer.',
    tool: 'road',
    done: (c) => (c.ROAD ?? 0) + (c.AVENUE ?? 0) >= 6,
  },
  {
    title: 'Logez vos habitants',
    text: 'Peignez une zone résidentielle (verte) le long de la rue : les maisons y pousseront.',
    tool: 'zoneR',
    done: (c) => (c.R ?? 0) >= 6,
  },
  {
    title: 'Allumez la ville',
    text: 'Posez une centrale près des maisons : le courant suit les routes et les zones.',
    tool: 'power',
    done: (c) => (c.POWER ?? 0) >= 1,
  },
  {
    title: 'Ouvrez les robinets',
    text: 'Un château d’eau permet aux quartiers de grandir. Il coûte moitié prix au bord d’un lac !',
    tool: 'water',
    done: (c) => (c.WATER ?? 0) >= 1,
  },
  {
    title: 'Créez des emplois',
    text: 'Ajoutez du commerce (bleu) et de l’industrie (jaune), plutôt à l’écart des maisons.',
    tool: 'zoneI',
    done: (c) => (c.C ?? 0) >= 3 && (c.I ?? 0) >= 3,
  },
  {
    title: 'Laissez la ville vivre',
    text: 'Passez en vitesse 2× ou 3× et regardez la population grandir jusqu’à 100 habitants.',
    done: (_c, pop) => pop >= 100,
  },
];

function countTypes(tiles: Tile[]): Counts {
  const c: Counts = {};
  for (const t of tiles) c[t.type] = (c[t.type] ?? 0) + 1;
  return c;
}

/** Carte d'étape sous le HUD. Elle disparaît une fois le tutoriel fini ou passé. */
export function Tutorial() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const progress = useGameStore((s) => s.settings.tutorial);
  const tiles = useGameStore((s) => s.tiles);
  const pop = useGameStore((s) => s.stats.population);
  const speed = useGameStore((s) => s.speed);
  const tool = useGameStore((s) => s.tool);
  const setTool = useGameStore((s) => s.setTool);
  const setSetting = useGameStore((s) => s.setSetting);

  // Étape courante : la première non validée (on peut prendre de l'avance).
  const counts = countTypes(tiles);
  let index = progress < 0 ? -1 : TUTORIAL_STEPS.findIndex((s, i) => i >= progress && !s.done(counts, pop, speed));
  if (index < 0 && progress >= 0) index = TUTORIAL_STEPS.length;
  // La progression est enregistrée : raser une route ne fait pas revenir en arrière.
  useEffect(() => {
    if (progress >= 0 && index > progress && index < TUTORIAL_STEPS.length) setSetting('tutorial', index);
  }, [index, progress, setSetting]);
  if (progress < 0) return null;
  const step = TUTORIAL_STEPS[index];
  const wide = width >= 700;

  return (
    <Animated.View
      entering={FadeInUp.springify().damping(18)}
      exiting={FadeOutUp.duration(150)}
      style={[
        styles.wrap,
        wide
          ? { top: insets.top + HUD_HEIGHT + 12, left: insets.left + theme.gutter, right: undefined, width: Math.min(540, width - insets.left - insets.right - 2 * theme.gutter - 58) }
          : { top: insets.top + HUD_HEIGHT + 12 },
      ]}
    >
      <Glass intensity={45} style={styles.card}>
        <View style={styles.header}>
          <Text style={styles.badge}>
            🎓 {Math.min(index + 1, TUTORIAL_STEPS.length)}/{TUTORIAL_STEPS.length}
          </Text>
          <View style={styles.dots}>
            {TUTORIAL_STEPS.map((_, i) => (
              <View key={i} style={[styles.dot, i < index && styles.dotDone, i === index && styles.dotNow]} />
            ))}
          </View>
          <Pressable onPress={() => setSetting('tutorial', -1)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Passer le tutoriel">
            <Text style={styles.skip}>{step ? 'Passer' : 'Fermer'}</Text>
          </Pressable>
        </View>
        {step ? (
          <>
            <Text style={styles.title}>{step.title}</Text>
            <Text style={styles.text}>{step.text}</Text>
            {step.tool && step.tool !== tool && (
              <Pressable onPress={() => setTool(step.tool!)} style={styles.cta}>
                <Text style={styles.ctaText}>Prendre l’outil</Text>
              </Pressable>
            )}
          </>
        ) : (
          <>
            <Text style={styles.title}>Bravo, Monsieur ou Madame le Maire ! 🎉</Text>
            <Text style={styles.text}>
              Le menu ⚙︎ contient le budget, les impôts R/C/I, les lois, le journal et les graphiques. Débloquez les monuments en faisant grandir la ville.
            </Text>
            <Pressable onPress={() => setSetting('tutorial', -1)} style={styles.cta}>
              <Text style={styles.ctaText}>C’est parti !</Text>
            </Pressable>
          </>
        )}
      </Glass>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: theme.gutter, right: theme.gutter + 58 },
  card: { borderRadius: 18, overflow: 'hidden', padding: 12, gap: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(241,196,15,0.5)' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badge: { color: theme.i, fontSize: 12, fontWeight: '800' },
  dots: { flexDirection: 'row', gap: 4, flex: 1 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.2)' },
  dotDone: { backgroundColor: theme.positive },
  dotNow: { backgroundColor: theme.i },
  skip: { color: theme.textDim, fontSize: 13, fontWeight: '700' },
  title: { color: theme.text, fontSize: 16, fontWeight: '800' },
  text: { color: theme.text, fontSize: 13, lineHeight: 18, opacity: 0.9 },
  cta: { alignSelf: 'flex-start', marginTop: 4, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, backgroundColor: 'rgba(241,196,15,0.9)' },
  ctaText: { color: '#1b1b1b', fontSize: 13, fontWeight: '800' },
});
