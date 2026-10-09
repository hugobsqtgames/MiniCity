import { registerRootComponent } from 'expo';
import { LoadSkiaWeb } from '@shopify/react-native-skia/lib/module/web';

/**
 * Web (uniquement pour les maquettes / aperçus) : CanvasKit est chargé depuis
 * le fichier local `canvaskit.wasm` servi à côté de la page — aucune requête
 * vers un CDN. L'app n'est importée qu'une fois Skia prêt.
 */
export function bootstrap() {
  LoadSkiaWeb({ locateFile: (file: string) => file }).then(async () => {
    const { default: App } = await import('../../App');
    registerRootComponent(App);
  });
}
