import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { Platform } from 'react-native';

/**
 * Sons et musique 100 % hors ligne : fichiers WAV générés par
 * `scripts/generate-sounds.mjs` et embarqués dans l'app.
 */

export type SfxName = 'build' | 'bulldoze' | 'click' | 'error' | 'siren' | 'alarm' | 'fanfare';
export type Ambience = 'city' | 'birds' | 'rain' | 'wind' | 'crowd' | 'night';

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

const AMBIENCE_SOURCES: Record<Ambience, number> = {
  city: require('../../assets/sounds/ambience-city.wav'),
  birds: require('../../assets/sounds/ambience-birds.wav'),
  rain: require('../../assets/sounds/ambience-rain.wav'),
  wind: require('../../assets/sounds/ambience-wind.wav'),
  crowd: require('../../assets/sounds/ambience-crowd.wav'),
  night: require('../../assets/sounds/ambience-night.wav'),
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
  // Une ambiance demandée avant l'initialisation démarre maintenant.
  applyAmbience();
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
    applyAmbience();
  };
  document.addEventListener('pointerdown', unlock);
}

export function isMusicEnabled(): boolean {
  return musicOn;
}

// ---------------------------------------------------------------------------
// Ambiances sonores en boucle (ville, oiseaux, pluie…), en fondu enchaîné.
// ---------------------------------------------------------------------------

const AMBIENCE_VOLUME = 0.3;
const AMBIENCE_FADE_MS = 1200;
const AMBIENCE_STEP_MS = 60;

const ambiencePlayers = new Map<Ambience, AudioPlayer>();
/** Volume courant de chaque boucle (suivi côté JS pour ne pas relire le natif). */
const ambienceVolumes = new Map<Ambience, number>();
let ambienceOn = true;
let ambiencePaused = false;
let currentAmbience: Ambience | null = null;
let fadeTimer: ReturnType<typeof setInterval> | null = null;

function ambiencePlayer(name: Ambience): AudioPlayer {
  let p = ambiencePlayers.get(name);
  if (!p) {
    p = createAudioPlayer(AMBIENCE_SOURCES[name]);
    p.loop = true;
    p.volume = 0;
    ambiencePlayers.set(name, p);
    ambienceVolumes.set(name, 0);
  }
  return p;
}

function stopFade() {
  if (fadeTimer) clearInterval(fadeTimer);
  fadeTimer = null;
}

/** Fait converger chaque boucle vers son volume cible : l'ambiance voulue monte, les autres s'éteignent. */
function applyAmbience() {
  if (!ready) return;
  const target = ambienceOn && !ambiencePaused ? currentAmbience : null;
  if (target && Platform.OS === 'web' && !webUnlocked) {
    // Comme la musique : rien avant le premier geste de l'utilisateur.
    waitForWebGesture();
    return;
  }
  try {
    if (target) {
      const p = ambiencePlayer(target);
      if (!p.playing) p.play();
    }
  } catch {
    // Ambiance indisponible : silencieux.
    return;
  }
  stopFade();
  const step = (AMBIENCE_VOLUME * AMBIENCE_STEP_MS) / AMBIENCE_FADE_MS;
  const tick = () => {
    let done = true;
    for (const [name, p] of ambiencePlayers) {
      const goal = name === target ? AMBIENCE_VOLUME : 0;
      const v = ambienceVolumes.get(name) ?? 0;
      const next = goal > v ? Math.min(goal, v + step) : Math.max(goal, v - step);
      try {
        if (next !== v) {
          p.volume = next;
          ambienceVolumes.set(name, next);
        }
        if (next === 0 && p.playing) p.pause();
      } catch {
        // Player libéré ou indisponible : on l'ignore.
      }
      if (next !== goal) done = false;
    }
    if (done) stopFade();
  };
  tick();
  fadeTimer = setInterval(tick, AMBIENCE_STEP_MS);
}

/** Active ou coupe toutes les ambiances (réglage joueur). */
export function setAmbienceEnabled(on: boolean): void {
  if (ambienceOn === on) return;
  ambienceOn = on;
  applyAmbience();
}

/** Change d'ambiance (null = silence) avec un fondu enchaîné d'environ 1,2 s. */
export function setAmbience(name: Ambience | null): void {
  if (name === currentAmbience) return;
  currentAmbience = name;
  applyAmbience();
}

/** Met les ambiances en pause quand l'app passe en arrière-plan, et les relance au retour. */
export function pauseAmbience(paused: boolean): void {
  if (ambiencePaused === paused) return;
  ambiencePaused = paused;
  if (paused) {
    // Coupure immédiate : les minuteries ne tournent pas en arrière-plan.
    stopFade();
    for (const [name, p] of ambiencePlayers) {
      try {
        p.pause();
        p.volume = 0;
        ambienceVolumes.set(name, 0);
      } catch {
        // Ignoré.
      }
    }
    return;
  }
  applyAmbience();
}
