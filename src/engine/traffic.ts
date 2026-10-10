/**
 * Feux tricolores : partagé entre le thread JS (calcul des arrêts des
 * véhicules) et le thread UI (affichage des feux), pour qu'une voiture
 * s'arrête exactement quand son feu est rouge à l'écran.
 *
 * Cycle de LIGHT_PERIOD secondes, décalé pour chaque carrefour :
 *   axe X (déplacement le long de x) : vert [0, 3.4[, orange [3.4, 4[, rouge [4, 8[
 *   axe Y : décalé d'un demi-cycle.
 */

export const LIGHT_PERIOD = 8;
export const GREEN_TIME = 3.4;
const HALF = LIGHT_PERIOD / 2;

export const LIGHT_GREEN = 0;
export const LIGHT_YELLOW = 1;
export const LIGHT_RED = 2;

export function mod(a: number, n: number): number {
  'worklet';
  return ((a % n) + n) % n;
}

/** Décalage du cycle d'un carrefour (déterministe, différent d'un carrefour à l'autre). */
export function lightOffset(tileIndex: number): number {
  return (((tileIndex * 2654435761) >>> 0) % 800) / 100;
}

/** État du feu pour un axe (0 = déplacement le long de x, 1 = le long de y). */
export function lightState(time: number, offset: number, axis: number): number {
  'worklet';
  const q = mod(time + offset + (axis === 0 ? 0 : HALF), LIGHT_PERIOD);
  return q < GREEN_TIME ? LIGHT_GREEN : q < HALF ? LIGHT_YELLOW : LIGHT_RED;
}

/** Un carrefour = une route reliée à au moins 3 autres routes. */
export function isIntersection(isRoad: (i: number) => boolean, i: number, size: number, n: number): boolean {
  const x = i % size;
  let c = 0;
  if (x + 1 < size && isRoad(i + 1)) c++;
  if (x > 0 && isRoad(i - 1)) c++;
  if (i + size < n && isRoad(i + size)) c++;
  if (i - size >= 0 && isRoad(i - size)) c++;
  return c >= 3;
}
