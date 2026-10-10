import { useEffect, useState } from 'react';

/** Renvoie `value` seulement après `delay` ms sans changement (évite les recalculs pendant qu'on peint). */
export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
