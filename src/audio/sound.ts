import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { Platform } from 'react-native';

/**
 * Sons et musique 100 % hors ligne : fichiers WAV générés par
 * `scripts/generate-sounds.mjs` et embarqués dans l'app.
 */

export type SfxName = 'build' | 'bulldoze' | 'click' | 'error' | 'siren' | 'alarm' | 'fanfare';

const SOURCES: Record<SfxName | 'music', number> = {
  build: require('../../assets/sounds/build.wav'),
  bulldoze: require('../../assets/sounds/bulldoze.wav'),
  click: require('../../assets/sounds/click.wav'),
  error: require('../../assets/sounds/error.wav'),
  siren: require('../../assets/sounds/siren.wav'),
  alarm: require('../../assets/sounds/alarm.wav'),
  fanfare: require('../../assets/sounds/fanfare.wav'),
  music: require('../../assets/sounds/music.wav'),
};

const VOLUME: Record<SfxName, number> = {
  build: 0.5,
  bulldoze: 0.5,
  click: 0.35,
  error: 0.45,
  siren: 0.35,
  alarm: 0.45,
  fanfare: 0.5,
};

const players = new Map<SfxName, AudioPlayer>();
let music: AudioPlayer | null = null;
let sfxOn = true;
let musicOn = true;
let ready = false;
const lastPlayed = new Map<SfxName, number>();

/** À appeler une fois au démarrage. Les erreurs audio ne doivent jamais bloquer le jeu. */
export async function initAudio(): Promise<void> {
  if (ready) return;
  ready = true;
  try {
    // Le jeu reste discret : il ne coupe pas la musique d'une autre app en mode silencieux.
    await setAudioModeAsync({ playsInSilentMode: false, interruptionMode: 'mixWithOthers' });
  } catch {
    // Mode audio non disponible (web, simulateur) : on continue.
  }
}

export function playSfx(name: SfxName): void {
  if (!sfxOn || !ready) return;
  if (Platform.OS === 'web' && !webUnlocked) {
    waitForWebGesture();
    return;
  }
  // Anti-rafale : pendant qu'on peint une route, un son toutes les 70 ms au plus.
  const now = Date.now();
  if (now - (lastPlayed.get(name) ?? 0) < 70) return;
  lastPlayed.set(name, now);
  try {
    let p = players.get(name);
    if (!p) {
      p = createAudioPlayer(SOURCES[name]);
      p.volume = VOLUME[name];
      players.set(name, p);
    }
    p.seekTo(0).catch(() => {});
    p.play();
  } catch {
    // Pas de son disponible : silencieux.
  }
}

export function setSfxEnabled(on: boolean): void {
  sfxOn = on;
}

export function setMusicEnabled(on: boolean): void {
  musicOn = on;
  if (!ready) return;
  try {
    if (on) {
      if (!music) {
        music = createAudioPlayer(SOURCES.music);
        music.loop = true;
        music.volume = 0.35;
      }
      if (Platform.OS === 'web' && !webUnlocked) {
        // Sur le web, le navigateur exige un premier geste avant toute lecture.
        waitForWebGesture();
        return;
      }
      music.play();
    } else {
      music?.pause();
    }
  } catch {
    // Musique indisponible.
  }
}

let webUnlocked = false;
let webWaiting = false;
function waitForWebGesture() {
  if (webWaiting || typeof document === 'undefined') return;
  webWaiting = true;
  const unlock = () => {
    document.removeEventListener('pointerdown', unlock);
    webUnlocked = true;
    webWaiting = false;
    setMusicEnabled(musicOn);
  };
  document.addEventListener('pointerdown', unlock);
}

export function isMusicEnabled(): boolean {
  return musicOn;
}
