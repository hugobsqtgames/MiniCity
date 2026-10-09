import { BlurView } from 'expo-blur';
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { theme } from './theme';

/**
 * Panneau "glassmorphism" : flou natif (iOS / web) + voile sombre constant.
 * Le voile garantit la lisibilité partout, y compris sur Android où le flou
 * est désactivé par défaut et où BlurView se comporte comme une vue translucide.
 */
export function Glass({ children, style, tint = theme.glassFill, intensity = 45 }: { children: ReactNode; style?: StyleProp<ViewStyle>; tint?: string; intensity?: number }) {
  return (
    <View style={[styles.frame, style]}>
      <BlurView intensity={intensity} tint="dark" style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.glassBorder,
  },
});
