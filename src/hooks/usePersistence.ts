import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { initAudio, pauseAmbience, setAmbienceEnabled, setMusicEnabled, setSfxEnabled } from '../audio/sound';
import { deleteSlot, listSlots, loadGame, loadSettings, saveGame, type SlotMeta } from '../store/persistence';
import { useGameStore } from '../store/useGameStore';

const AUTOSAVE_MS = 15000;
/** Durée minimale du splash, pour éviter un flash à l'ouverture. */
const MIN_SPLASH_MS = 900;

export type SlotActions = {
  slots: (SlotMeta | null)[];
  current: number;
  refresh: () => void;
  /** Sauvegarde la partie en cours, puis charge (ou crée) la ville de l'emplacement. */
  play: (slot: number) => Promise<void>;
  /** Copie la partie en cours dans un autre emplacement (qui devient l'emplacement courant). */
  saveAs: (slot: number) => Promise<void>;
  remove: (slot: number) => Promise<void>;
};

/**
 * Au démarrage : charge les réglages puis la partie de l'emplacement courant
 * (ou crée une carte neuve). Ensuite : sauvegarde automatique toutes les 15 s
 * et à chaque passage en arrière-plan. Trois emplacements de sauvegarde.
 */
export function usePersistence() {
  const hydrated = useGameStore((s) => s.hydrated);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [slots, setSlots] = useState<(SlotMeta | null)[]>([null, null, null]);

  const refresh = useCallback(() => {
    listSlots()
      .then(setSlots)
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    const started = Date.now();
    Promise.all([loadSettings(), initAudio()])
      .then(async ([settings]) => {
        const save = await loadGame(settings.slot).catch(() => null);
        const wait = MIN_SPLASH_MS - (Date.now() - started);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (cancelled) return;
        useGameStore.getState().hydrateSettings(settings);
        useGameStore.getState().hydrate(save);
        refresh();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const autoSave = useCallback(async () => {
    const state = useGameStore.getState();
    if (!state.hydrated) return;
    try {
      await saveGame(state.snapshot(), state.settings.slot);
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

  const play = useCallback(
    async (slot: number) => {
      await autoSave();
      const save = await loadGame(slot).catch(() => null);
      const store = useGameStore.getState();
      store.setSetting('slot', slot);
      store.hydrate(save);
      await autoSave();
      refresh();
    },
    [autoSave, refresh],
  );

  const saveAs = useCallback(
    async (slot: number) => {
      useGameStore.getState().setSetting('slot', slot);
      await autoSave();
      refresh();
    },
    [autoSave, refresh],
  );

  const remove = useCallback(
    async (slot: number) => {
      if (slot === useGameStore.getState().settings.slot) return;
      await deleteSlot(slot).catch(() => {});
      refresh();
    },
    [refresh],
  );

  // Sons et musique suivent les réglages ; la musique se coupe en arrière-plan.
  const music = useGameStore((s) => s.settings.music);
  const sounds = useGameStore((s) => s.settings.sounds);
  const current = useGameStore((s) => s.settings.slot);
  useEffect(() => {
    setSfxEnabled(sounds);
  }, [sounds]);
  useEffect(() => {
    if (!hydrated) return;
    setMusicEnabled(music);
    const sub = AppState.addEventListener('change', (s) => setMusicEnabled(music && s === 'active'));
    return () => sub.remove();
  }, [hydrated, music]);
  const ambience = useGameStore((s) => s.settings.ambience);
  useEffect(() => {
    if (!hydrated) return;
    setAmbienceEnabled(ambience);
    const sub = AppState.addEventListener('change', (s) => pauseAmbience(s !== 'active'));
    return () => sub.remove();
  }, [hydrated, ambience]);

  const slotActions: SlotActions = { slots, current, refresh, play, saveAs, remove };
  return { hydrated, lastSavedAt, saveNow: autoSave, slotActions };
}
