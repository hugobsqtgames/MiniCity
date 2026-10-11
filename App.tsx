import { StatusBar } from 'expo-status-bar';
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { IsoMapCanvas } from './src/components/IsoMapCanvas';
import { useGameLoop } from './src/hooks/useGameLoop';
import { usePersistence } from './src/hooks/usePersistence';
import { useGameStore } from './src/store/useGameStore';
import { ChallengeTree } from './src/ui/ChallengeTree';
import { CitizenCard } from './src/ui/CitizenCard';
import { ConfirmDialog } from './src/ui/ConfirmDialog';
import { DragInfo } from './src/ui/DragInfo';
import { Hud } from './src/ui/Hud';
import { MapControls } from './src/ui/MapControls';
import { MenuSheet } from './src/ui/MenuSheet';
import { MiniMap } from './src/ui/MiniMap';
import { SplashScreen } from './src/ui/SplashScreen';
import { TileInfo } from './src/ui/TileInfo';
import { TimelapsePlayer } from './src/ui/TimelapsePlayer';
import { Toast } from './src/ui/Toast';
import { Toolbar } from './src/ui/Toolbar';
import { Tutorial } from './src/ui/Tutorial';

function Game() {
  const { hydrated, lastSavedAt, saveNow, slotActions } = usePersistence();
  const menuOpen = useGameStore((s) => s.menuTab !== null);
  const openMenu = useGameStore((s) => s.openMenu);
  const showMinimap = useGameStore((s) => s.settings.minimap);
  useGameLoop();

  return (
    <View style={styles.root}>
      {/* Le rendu du jeu (Skia) en fond, l'UI native flotte par-dessus. */}
      {hydrated && <IsoMapCanvas />}
      {hydrated && (
        <>
          <Hud
            onOpenMenu={() => {
              slotActions.refresh();
              openMenu('city');
            }}
          />
          <Tutorial />
          <MapControls />
          {showMinimap && <MiniMap />}
          <TileInfo />
          <CitizenCard />
          <DragInfo />
          <Toast />
          <Toolbar />
        </>
      )}
      {menuOpen && <MenuSheet onSaveNow={saveNow} lastSavedAt={lastSavedAt} slots={slotActions} />}
      {hydrated && <ChallengeTree />}
      {hydrated && <TimelapsePlayer />}
      <ConfirmDialog />
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
