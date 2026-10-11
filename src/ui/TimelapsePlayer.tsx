import { Canvas, Picture } from '@shopify/react-native-skia';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { previewType } from '../store/persistence';
import { useGameStore } from '../store/useGameStore';
import { buildThumbPicture } from './MapThumb';
import { Text } from './Text';
import { formatDate, formatNumber, theme } from './theme';

/** Lecteur du timelapse : la ville image par image, de sa fondation à aujourd'hui. */
export function TimelapsePlayer() {
  const open = useGameStore((s) => s.timelapseOpen);
  // Monté seulement quand il est ouvert : la lecture repart du début à chaque ouverture.
  return open ? <Player /> : null;
}

function Player() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const open = true;
  const close = useGameStore((s) => s.openTimelapse);
  const frames = useGameStore((s) => s.timelapse);
  const cityName = useGameStore((s) => s.cityName);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const W = Math.min(width - 32, 640);

  // Lecture : 4 images par seconde, puis on s'arrête sur la dernière.
  useEffect(() => {
    if (!open || !playing) return;
    const id = setInterval(() => {
      setIndex((i) => {
        if (i >= frames.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, 250);
    return () => clearInterval(id);
  }, [open, playing, frames.length]);

  const current = Math.min(index, Math.max(0, frames.length - 1));
  const frame = frames[current];
  const picture = useMemo(
    () => (frame ? buildThumbPicture(frame.size, W, (x, y) => previewType(frame.map[y * frame.size + x]), (x, y) => Number(frame.dens[y * frame.size + x]) || 0) : null),
    [frame, W],
  );

  const restart = () => {
    setIndex(0);
    setPlaying(true);
  };
  return (
    <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(150)} style={[StyleSheet.absoluteFill, styles.root, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16 }]}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          🎞️ {cityName}
        </Text>
        <Pressable onPress={() => close(false)} hitSlop={10} accessibilityLabel="Fermer le timelapse">
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>
      <View style={styles.stage}>
        {picture ? (
          <Canvas style={{ width: W, height: W / 2 }}>
            <Picture picture={picture} />
          </Canvas>
        ) : (
          <Text style={styles.empty}>Pas encore d’image : revenez dans quelques mois.</Text>
        )}
      </View>
      {frame && (
        <Text style={styles.caption}>
          {formatDate(frame.month)} · {formatNumber(frame.population)} habitants
        </Text>
      )}
      <View style={styles.bar}>
        <View style={[styles.barFill, { width: `${frames.length > 1 ? (current / (frames.length - 1)) * 100 : 100}%` }]} />
      </View>
      <View style={styles.controls}>
        <Pressable onPress={() => setIndex((i) => Math.max(0, i - 1))} style={styles.btn} accessibilityLabel="Image précédente">
          <Text style={styles.btnText}>⏮</Text>
        </Pressable>
        <Pressable onPress={() => (playing ? setPlaying(false) : current >= frames.length - 1 ? restart() : setPlaying(true))} style={[styles.btn, styles.btnMain]} accessibilityLabel={playing ? 'Pause' : 'Lecture'}>
          <Text style={styles.btnText}>{playing ? '❚❚' : current >= frames.length - 1 ? '↺' : '▶︎'}</Text>
        </Pressable>
        <Pressable onPress={() => setIndex((i) => Math.min(frames.length - 1, i + 1))} style={styles.btn} accessibilityLabel="Image suivante">
          <Text style={styles.btnText}>⏭</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: '#0b1622', paddingHorizontal: 16, gap: 14 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { flex: 1, color: theme.text, fontSize: 22, fontWeight: '800' },
  close: { color: theme.textDim, fontSize: 20, fontWeight: '700' },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { color: theme.textDim, fontSize: 15 },
  caption: { color: theme.text, fontSize: 16, fontWeight: '800', textAlign: 'center', fontVariant: ['tabular-nums'] },
  bar: { height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: '#f4d03f' },
  controls: { flexDirection: 'row', justifyContent: 'center', gap: 18 },
  btn: { width: 54, height: 54, borderRadius: 27, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center' },
  btnMain: { backgroundColor: '#2e86c1' },
  btnText: { color: theme.text, fontSize: 20, fontWeight: '800' },
});
