import { registerRootComponent } from 'expo';

import App from '../../App';

/** Natif (Expo Go) : Skia est disponible immédiatement. */
export function bootstrap() {
  registerRootComponent(App);
}
