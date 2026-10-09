import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { IsoMapCanvas } from './src/components/IsoMapCanvas';
import { useGameLoop } from './src/hooks/useGameLoop';
import { usePersistence } from './src/hooks/usePersistence';
import { Hud } from './src/ui/Hud';
import { MenuSheet } from './src/ui/MenuSheet';
import { SplashScreen } from './src/ui/SplashScreen';
import { TileInfo } from './src/ui/TileInfo';
import { Toast } from './src/ui/Toast';
import { Toolbar } from './src/ui/Toolbar';

function Game() {
  const { hydrated, lastSavedAt, saveNow } = usePersistence();
  const [menuOpen, setMenuOpen] = useState(false);
  useGameLoop();

  return (
    <View style={styles.root}>
      {/* Le rendu du jeu (Skia) en fond, l'UI native flotte par-dessus. */}
      {hydrated && <IsoMapCanvas />}
      {hydrated && (
        <>
          <Hud onOpenMenu={() => setMenuOpen(true)} />
          <TileInfo />
          <Toast />
          <Toolbar />
        </>
      )}
      {menuOpen && <MenuSheet onClose={() => setMenuOpen(false)} onSaveNow={saveNow} lastSavedAt={lastSavedAt} />}
      {!hydrated && <SplashScreen />}
    </View>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <Game />
        <StatusBar style="light" />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b1622' },
});
