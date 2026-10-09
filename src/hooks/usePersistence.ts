import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { loadGame, saveGame } from '../store/persistence';
import { useGameStore } from '../store/useGameStore';

const AUTOSAVE_MS = 15000;
/** Durée minimale du splash, pour éviter un flash à l'ouverture. */
const MIN_SPLASH_MS = 900;

/**
 * Au démarrage : charge la dernière sauvegarde (ou garde une carte neuve si
 * aucune). Ensuite : autoSave toutes les 15 s + à chaque passage en arrière-plan.
 */
export function usePersistence() {
  const hydrated = useGameStore((s) => s.hydrated);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const started = Date.now();
    loadGame()
      .catch(() => null)
      .then(async (save) => {
        const wait = MIN_SPLASH_MS - (Date.now() - started);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (!cancelled) useGameStore.getState().hydrate(save);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const autoSave = useCallback(async () => {
    const state = useGameStore.getState();
    if (!state.hydrated) return;
    try {
      await saveGame(state.snapshot());
      setLastSavedAt(Date.now());
    } catch {
      // Stockage plein ou indisponible : on réessaiera au prochain cycle.
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const id = setInterval(autoSave, AUTOSAVE_MS);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background' || s === 'inactive') autoSave();
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [hydrated, autoSave]);

  return { hydrated, lastSavedAt, saveNow: autoSave };
}
