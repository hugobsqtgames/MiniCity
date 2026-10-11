import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useGameStore } from '../store/useGameStore';
import { Text } from './Text';
import { HUD_HEIGHT } from './Hud';

/** Message éphémère sous le HUD (fonds insuffisants, terrain occupé…). */
export function Toast() {
  const insets = useSafeAreaInsets();
  const toast = useGameStore((s) => s.toast);
  const [hiddenId, setHiddenId] = useState(0);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setHiddenId(toast.id), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const visible = toast && toast.id !== hiddenId ? toast : null;
  if (!visible) return null;
  return (
    <Animated.View
      key={visible.id}
      entering={FadeInUp.springify().damping(16)}
      exiting={FadeOutUp.duration(180)}
      pointerEvents="none"
      style={[styles.toast, { top: insets.top + HUD_HEIGHT + 16 }]}
    >
      <Text style={styles.text}>{visible.text}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: 'rgba(192,57,43,0.92)',
  },
  text: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
