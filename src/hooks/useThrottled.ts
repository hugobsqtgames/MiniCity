import { useEffect, useRef, useState } from 'react';

/**
 * Renvoie `value` au plus une fois toutes les `interval` ms (avec une dernière
 * mise à jour en fin de rafale). Contrairement à un debounce, la valeur suit
 * même quand elle change en continu (simulation en vitesse 3×).
 */
export function useThrottled<T>(value: T, interval: number): T {
  const [throttled, setThrottled] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = Math.max(0, last.current + interval - Date.now());
    const id = setTimeout(() => {
      last.current = Date.now();
      setThrottled(value);
    }, wait);
    return () => clearTimeout(id);
  }, [value, interval]);
  return throttled;
}
