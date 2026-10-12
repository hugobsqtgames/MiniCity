import { useEffect } from 'react';
import { useFrameCallback, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import type { Quality } from '../store/persistence';
import { useGameStore } from '../store/useGameStore';

/** Densité de PNJ par niveau de qualité. */
const LEVELS = [1, 0.6, 0.35];
const FIXED: Record<Exclude<Quality, 'auto'>, number> = { high: 0, medium: 1, low: 2 };

/** Fenêtre de mesure des images par seconde (ms). */
const WINDOW_MS = 2000;
const SLOW_FPS = 40;
const SMOOTH_FPS = 56;

/**
 * Qualité automatique : mesure la fluidité sur le thread UI et réduit le
 * nombre de véhicules et de piétons si l'animation saccade (puis le remonte
 * quand tout redevient fluide). En qualité manuelle, la densité est fixe.
 */
export function usePerformanceGovernor(quality: Quality) {
  const setAgentScale = useGameStore((s) => s.setAgentScale);
  const level = useSharedValue(0);
  const frames = useSharedValue(0);
  const windowStart = useSharedValue(0);
  const smoothStreak = useSharedValue(0);
  const auto = quality === 'auto';

  useEffect(() => {
    const l = auto ? 0 : FIXED[quality];
    level.set(l);
    smoothStreak.set(0);
    windowStart.set(0);
    setAgentScale(LEVELS[l]);
  }, [auto, quality, level, smoothStreak, windowStart, setAgentScale]);

  const meter = useFrameCallback((info) => {
    'worklet';
    const now = info.timestamp;
    // Retour de l'arrière-plan (longue pause entre deux images) : on repart d'une fenêtre neuve.
    if (info.timeSincePreviousFrame !== null && info.timeSincePreviousFrame > 250) {
      windowStart.set(0);
      return;
    }
    if (windowStart.get() === 0) {
      windowStart.set(now);
      frames.set(0);
      return;
    }
    frames.set(frames.get() + 1);
    const elapsed = now - windowStart.get();
    if (elapsed < WINDOW_MS) return;
    const fps = (frames.get() * 1000) / elapsed;
    windowStart.set(now);
    frames.set(0);
    let l = level.get();
    if (fps < SLOW_FPS && l < LEVELS.length - 1) {
      l++;
      smoothStreak.set(0);
    } else if (fps > SMOOTH_FPS) {
      // Trois fenêtres fluides d'affilée avant de remonter, pour éviter de faire le yo-yo.
      smoothStreak.set(smoothStreak.get() + 1);
      if (smoothStreak.get() >= 3 && l > 0) {
        l--;
        smoothStreak.set(0);
      }
    } else smoothStreak.set(0);
    if (l !== level.get()) {
      level.set(l);
      scheduleOnRN(setAgentScale, LEVELS[l]);
    }
  }, false);

  const { setActive } = meter;
  useEffect(() => {
    setActive(auto);
  }, [auto, setActive]);
}
