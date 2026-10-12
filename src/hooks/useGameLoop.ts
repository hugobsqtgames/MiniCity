import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { TICK_MS } from '../sim/constants';
import { useGameStore } from '../store/useGameStore';

/**
 * Game loop : 1 tick = 1 mois = 2 s réelles à vitesse 1× (1 s à 2×, 0,67 s à 3×).
 * La simulation tourne indépendamment du rendu, qui ne fait que réagir au store.
 */
export function useGameLoop() {
  const speed = useGameStore((s) => s.speed);
  const paused = useGameStore((s) => s.paused);
  const hydrated = useGameStore((s) => s.hydrated);
  // En arrière-plan (Android garde le JS actif), la ville se met en pause.
  const [active, setActive] = useState(AppState.currentState !== 'background');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (paused || !hydrated || !active) return;
    const id = setInterval(() => useGameStore.getState().tick(), TICK_MS / speed);
    return () => clearInterval(id);
  }, [speed, paused, hydrated, active]);
}
