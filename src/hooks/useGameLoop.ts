import { useEffect } from 'react';

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

  useEffect(() => {
    if (paused || !hydrated) return;
    const id = setInterval(() => useGameStore.getState().tick(), TICK_MS / speed);
    return () => clearInterval(id);
  }, [speed, paused, hydrated]);
}
