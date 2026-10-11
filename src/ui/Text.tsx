import { StyleSheet, Text as RNText, type TextProps } from 'react-native';

import { useGameStore } from '../store/useGameStore';

/**
 * Texte de l'interface : applique la taille de texte choisie dans les réglages
 * d'accessibilité (en plus de la taille système du téléphone).
 */
export function Text({ style, maxScale = 2, ...props }: TextProps & { maxScale?: number }) {
  // `maxScale` borne l'agrandissement là où la place manque (HUD).
  const scale = Math.min(maxScale, useGameStore((s) => s.settings.textScale));
  if (scale === 1) return <RNText style={style} {...props} />;
  const flat = StyleSheet.flatten(style) ?? {};
  const scaled = {
    fontSize: (flat.fontSize ?? 14) * scale,
    ...(flat.lineHeight ? { lineHeight: flat.lineHeight * scale } : null),
  };
  return <RNText style={[style, scaled]} {...props} />;
}
