import type { SkPicture } from '@shopify/react-native-skia';
import { Platform } from 'react-native';

/**
 * Sur le web (CanvasKit), les images Skia ne sont jamais libérées par le
 * ramasse-miettes : celles créées à chaque frame (caméra, PNJ, effets) font
 * grimper la mémoire. On garde les dernières et on libère les plus anciennes.
 * Sur iOS / Android, le ramasse-miettes s'en charge : rien à faire.
 */
export const RECYCLE_PICTURES = Platform.OS === 'web';

export type PictureBin = { pics: SkPicture[] };
export const makeBin = (): PictureBin => ({ pics: [] });

/** Mémorise l'image et libère celles d'il y a plus de 3 frames (web seulement). Worklet. */
export function keep(bin: PictureBin, pic: SkPicture, recycle: boolean): SkPicture {
  'worklet';
  if (!recycle) return pic;
  bin.pics.push(pic);
  while (bin.pics.length > 3) bin.pics.shift()!.dispose();
  return pic;
}
