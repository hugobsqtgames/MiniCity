import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ZoomIn } from 'react-native-reanimated';

import { useGameStore } from '../store/useGameStore';
import { Glass } from './Glass';
import { Text } from './Text';
import { theme } from './theme';

/** Confirmation avant une action destructrice (nouvelle ville, suppression d'une sauvegarde…). */
export function ConfirmDialog() {
  const confirm = useGameStore((s) => s.confirm);
  const close = useGameStore((s) => s.closeConfirm);
  if (!confirm) return null;
  return (
    <Animated.View entering={FadeIn.duration(120)} exiting={FadeOut.duration(120)} style={[StyleSheet.absoluteFill, styles.backdrop]}>
      <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Annuler" />
      <Animated.View entering={ZoomIn.springify().damping(18)} style={styles.center} pointerEvents="box-none">
        <Glass intensity={60} tint="rgba(12,22,34,0.92)" style={styles.card}>
          <Text style={styles.title}>{confirm.title}</Text>
          <Text style={styles.message}>{confirm.message}</Text>
          <View style={styles.actions}>
            <Pressable onPress={close} style={({ pressed }) => [styles.btn, pressed && { opacity: 0.7 }]}>
              <Text style={styles.btnText}>Annuler</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                close();
                confirm.onConfirm();
              }}
              style={({ pressed }) => [styles.btn, styles.danger, pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.btnText}>{confirm.label}</Text>
            </Pressable>
          </View>
        </Glass>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center' },
  center: { width: '100%', maxWidth: 420, paddingHorizontal: 24 },
  card: { borderRadius: 22, overflow: 'hidden', padding: 20, gap: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.glassBorder },
  title: { color: theme.text, fontSize: 19, fontWeight: '800' },
  message: { color: theme.text, fontSize: 14, lineHeight: 20, opacity: 0.9 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 6 },
  btn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.14)' },
  danger: { backgroundColor: 'rgba(231,76,60,0.9)' },
  btnText: { color: theme.text, fontSize: 14, fontWeight: '800' },
});
