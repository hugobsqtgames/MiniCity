import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { IsoMapCanvas } from './src/components/IsoMapCanvas';
import { useGameStore } from './src/store/useGameStore';

function DebugBadge() {
  const selected = useGameStore((s) => s.selected);
  return (
    <View pointerEvents="none" style={styles.badge}>
      <Text style={styles.badgeText}>
        {selected ? `Tuile (${selected.x}, ${selected.y})` : 'Touchez une tuile'}
      </Text>
    </View>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <IsoMapCanvas />
      <DebugBadge />
      <StatusBar style="light" />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  badge: {
    position: 'absolute',
    top: 56,
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  badgeText: { color: '#fff', fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
