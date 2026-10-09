import { useEffect } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TOOLS, type ToolDef } from '../sim/constants';
import { useGameStore } from '../store/useGameStore';
import { formatMoney, theme } from './theme';
import { Glass } from './Glass';

export const TOOLBAR_HEIGHT = 112;

function ToolButton({ tool, active, onPress }: { tool: ToolDef; active: boolean; onPress: () => void }) {
  const lift = useSharedValue(active ? 1 : 0);
  useEffect(() => {
    lift.value = withSpring(active ? 1 : 0, { damping: 14, stiffness: 220 });
  }, [active, lift]);

  // L'outil sélectionné se surélève et grossit légèrement.
  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: -14 * lift.value }, { scale: 1 + 0.08 * lift.value }],
  }));

  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={tool.label} accessibilityState={{ selected: active }}>
      <Animated.View style={[styles.tool, active && { borderColor: tool.color, backgroundColor: 'rgba(255,255,255,0.16)' }, style]}>
        <View style={[styles.swatch, { backgroundColor: tool.color }]} />
        <Text style={styles.icon}>{tool.icon}</Text>
        <Text style={styles.label} numberOfLines={1}>
          {tool.label}
        </Text>
        <Text style={styles.cost}>{tool.cost > 0 ? formatMoney(tool.cost) : ' '}</Text>
      </Animated.View>
    </Pressable>
  );
}

export function Toolbar() {
  const insets = useSafeAreaInsets();
  const tool = useGameStore((s) => s.tool);
  const setTool = useGameStore((s) => s.setTool);

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: insets.bottom + 8 }]}>
      <Glass intensity={45} style={styles.glass}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scroll}>
          {TOOLS.map((t) => (
            <ToolButton key={t.id} tool={t} active={t.id === tool} onPress={() => setTool(t.id)} />
          ))}
        </ScrollView>
      </Glass>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: theme.gutter, right: theme.gutter },
  glass: {
    borderRadius: theme.radius,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.glassBorder,
  },
  scroll: { paddingHorizontal: 10, paddingTop: 22, paddingBottom: 10, gap: 8 },
  tool: {
    width: 76,
    height: 84,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 2,
    borderColor: 'transparent',
    overflow: 'hidden',
  },
  swatch: { position: 'absolute', top: 0, left: 0, right: 0, height: 4 },
  icon: { fontSize: 30 },
  label: { color: theme.text, fontSize: 11, fontWeight: '700', marginTop: 2 },
  cost: { color: theme.textDim, fontSize: 10, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
