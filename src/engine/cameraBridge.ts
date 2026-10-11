import { makeMutable } from 'react-native-reanimated';

/**
 * Caméra partagée entre la carte, la mini-carte et l'interface : les valeurs
 * vivent sur le thread UI (pas de re-rendu React quand on se déplace).
 *  - écran = monde × scale + (tx, ty)
 *  - `focus` : demande de centrage sur une tuile (coordonnées d'origine),
 *    traitée par la carte avec une animation.
 */
export const camera = {
  tx: makeMutable(0),
  ty: makeMutable(0),
  scale: makeMutable(0.6),
  width: makeMutable(390),
  height: makeMutable(844),
};

export const focusRequest = makeMutable({ x: -1, y: -1, seq: 0, zoom: 0 });

/** Centre la caméra sur une tuile (coordonnées d'origine), avec un zoom optionnel. */
export function focusTile(x: number, y: number, zoom = 0) {
  focusRequest.set({ x, y, seq: focusRequest.get().seq + 1, zoom });
}
