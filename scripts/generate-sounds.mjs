/**
 * Génère les effets sonores et la musique de MiniCity par synthèse (aucun
 * fichier externe, aucune requête réseau) : `node scripts/generate-sounds.mjs`.
 * Sortie : assets/sounds/*.wav (PCM 16 bits mono).
 */
import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sounds');
mkdirSync(OUT, { recursive: true });

function wav(name, samples, rate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  writeFileSync(join(OUT, `${name}.wav`), Buffer.concat([h, data]));
  console.log(name, `${((44 + data.length) / 1024).toFixed(0)} Ko`);
}

let seed = 1;
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const sq = (p) => (p % 1 < 0.5 ? 1 : -1);
const tri = (p) => 1 - 4 * Math.abs((p % 1) - 0.5);
const env = (t, a, d) => (t < a ? t / a : Math.exp(-(t - a) / d));
const note = (n) => 440 * Math.pow(2, (n - 69) / 12);

function render(duration, rate, fn) {
  const out = new Float32Array(Math.round(duration * rate));
  for (let i = 0; i < out.length; i++) out[i] = fn(i / rate);
  return out;
}

const SFX = 22050;
// Pose d'un bâtiment : petit "pop" montant.
wav('build', render(0.12, SFX, (t) => tri(t * (500 + t * 3000)) * env(t, 0.005, 0.04) * 0.6), SFX);
// Bulldozer : grondement bruité.
wav('bulldoze', render(0.25, SFX, (t) => (noise() * 0.6 + sq(t * 70) * 0.4) * env(t, 0.01, 0.08) * 0.5), SFX);
// Clic d'interface.
wav('click', render(0.05, SFX, (t) => sq(t * 1400) * env(t, 0.001, 0.012) * 0.3), SFX);
// Erreur : buzz grave.
wav('error', render(0.22, SFX, (t) => sq(t * 140) * env(t, 0.005, 0.09) * 0.35), SFX);
// Sirène de pompiers (deux tons).
wav('siren', render(1.4, SFX, (t) => tri(t * (Math.floor(t * 3) % 2 ? 960 : 720)) * env(t, 0.05, 0.9) * 0.35), SFX);
// Alarme de catastrophe.
wav('alarm', render(1.6, SFX, (t) => sq(t * (600 + 300 * Math.sin(t * 12))) * env(t, 0.02, 1.0) * 0.28), SFX);
// Fanfare (palier atteint).
wav('fanfare', render(0.9, SFX, (t) => {
  const seq = [72, 76, 79, 84];
  const k = Math.min(3, Math.floor(t / 0.16));
  const lt = t - k * 0.16;
  return (sq(t * note(seq[k])) * 0.25 + tri(t * note(seq[k] - 12)) * 0.3) * env(lt, 0.005, k === 3 ? 0.4 : 0.1);
}), SFX);

// Musique : boucle chiptune de 8 mesures (Do - La m - Fa - Sol), 112 BPM.
const MR = 16000;
const bpm = 112;
const beat = 60 / bpm;
const bars = 8;
const chords = [
  [48, 52, 55],
  [45, 48, 52],
  [41, 45, 48],
  [43, 47, 50],
];
const melody = [76, 79, 81, 79, 76, 74, 72, 74, 76, 72, 69, 72, 74, 76, 74, 71, 72, 76, 77, 76, 72, 69, 72, 74, 71, 74, 76, 79, 77, 74, 71, 74];
const total = bars * 4 * beat;
wav('music', render(total, MR, (t) => {
  const b = t / beat;
  const bar = Math.floor(b / 4) % 4;
  const ch = chords[bar];
  const step = Math.floor(b);
  const sb = b - step;
  // Basse en croches.
  const bass = tri(t * note(ch[0] - 12)) * env((b * 2) % 1 * beat / 2, 0.005, 0.12) * 0.35;
  // Arpège doux.
  const arpN = ch[Math.floor(b * 4) % 3] + 12;
  const arp = sq(t * note(arpN)) * env(((b * 4) % 1) * beat / 4, 0.002, 0.05) * 0.08;
  // Mélodie (une note par temps).
  const m = melody[step % melody.length];
  const lead = (tri(t * note(m)) * 0.6 + sq(t * note(m)) * 0.15) * env(sb * beat, 0.01, 0.25) * 0.28;
  // Batterie : charleston + grosse caisse.
  const hat = noise() * env(((b * 2) % 1) * beat / 2, 0.001, 0.015) * 0.06;
  const kick = Math.sin(2 * Math.PI * 55 * (sb * beat) * (1 + Math.exp(-sb * beat * 30))) * env(sb * beat, 0.002, 0.08) * (step % 2 === 0 ? 0.35 : 0);
  // Fondu aux extrémités pour une boucle sans clic.
  const edge = Math.min(1, t / 0.02, (total - t) / 0.02);
  return (bass + arp + lead + hat + kick) * 0.8 * edge;
}), MR);

// ---------------------------------------------------------------------------
// Ambiances en boucle (≈ 8 s, 16 kHz). Chaque boucle est rendue un peu plus
// longue que nécessaire, puis la fin est fondue (puissance constante) sur le
// début : la jonction est inaudible et sans clic. Générateur pseudo-aléatoire
// à graine propre à chaque ambiance : le résultat est identique à chaque run.
// ---------------------------------------------------------------------------
const AR = 16000;
const LOOP = 8;
const XFADE = 1;

function prng(s) {
  let x = s >>> 0;
  return () => {
    // mulberry32
    x = (x + 0x6d2b79f5) >>> 0;
    let r = Math.imul(x ^ (x >>> 15), 1 | x);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Filtre passe-bas à un pôle (fréquence de coupure en Hz). */
function lowpass(fc) {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / AR);
  let y = 0;
  return (x, f) => {
    const k = f === undefined ? a : 1 - Math.exp((-2 * Math.PI * f) / AR);
    y += k * (x - y);
    return y;
  };
}

/** Bruit brun (marche aléatoire amortie). */
function brown(rnd) {
  let y = 0;
  return () => {
    y = (y + (rnd() * 2 - 1) * 0.02) * 0.998;
    return y * 3.5;
  };
}

/** Rendu d'une boucle : `make(rnd, total)` renvoie un générateur échantillon par échantillon. */
function ambience(name, seedValue, peak, make) {
  const rnd = prng(seedValue);
  const total = LOOP + XFADE;
  const gen = make(rnd, total);
  const raw = new Float32Array(Math.round(total * AR));
  for (let i = 0; i < raw.length; i++) raw[i] = gen(i / AR);
  const n = Math.round(LOOP * AR);
  const x = Math.round(XFADE * AR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = raw[i];
  // Fondu enchaîné : la queue (n..n+x) se superpose au début (0..x).
  for (let i = 0; i < x; i++) {
    const p = (i / x) * (Math.PI / 2);
    out[i] = raw[i] * Math.sin(p) + raw[n + i] * Math.cos(p);
  }
  // Normalisation de la crête : jamais de saturation.
  let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(out[i]));
  const g = m > 0 ? peak / m : 1;
  for (let i = 0; i < n; i++) out[i] *= g;
  wav(`ambience-${name}`, out, AR);
}

/** Liste d'évènements aléatoires (début, paramètres) répartis sur `total` secondes. */
function events(rnd, total, count, make) {
  const list = [];
  for (let k = 0; k < count; k++) list.push({ t0: rnd() * total, ...make(rnd) });
  return list;
}

/** Gazouillis : sinus à fréquence glissante, enveloppe en cloche. */
function chirp(e, t) {
  const lt = t - e.t0;
  if (lt < 0 || lt > e.d) return 0;
  const u = lt / e.d;
  const f = e.f0 + (e.f1 - e.f0) * u;
  return Math.sin(2 * Math.PI * (e.f0 * lt + ((e.f1 - e.f0) * lt * u) / 2)) * Math.sin(Math.PI * u) * e.a * (f > 0 ? 1 : 0);
}

// Ville : rumeur de circulation + voitures lointaines + klaxon très rare.
ambience('city', 101, 0.55, (rnd, total) => {
  const br = brown(rnd);
  const lp = lowpass(180);
  const carLp = lowpass(400);
  const cars = events(rnd, total, 5, (r) => ({ d: 2.5 + r() * 2, a: 0.25 + r() * 0.2, f: 300 + r() * 300 }));
  const horn = { t0: 2 + rnd() * 4, d: 0.22 };
  return (t) => {
    let pass = 0;
    for (const c of cars) {
      const u = (t - c.t0) / c.d;
      if (u > 0 && u < 1) pass += Math.pow(Math.sin(Math.PI * u), 2) * c.a;
    }
    const w = rnd() * 2 - 1;
    const rumble = lp(br()) * 0.8;
    const whoosh = carLp(w, 250 + pass * 600) * pass * 2.2;
    const lh = t - horn.t0;
    const h = lh > 0 && lh < horn.d ? (sq(t * 392) * 0.5 + sq(t * 494) * 0.5) * Math.sin((Math.PI * lh) / horn.d) * 0.03 : 0;
    return rumble + whoosh + h;
  };
});

// Oiseaux : gazouillis sur un léger vent.
ambience('birds', 202, 0.5, (rnd, total) => {
  const wind = lowpass(500);
  const chirps = [];
  // Petites phrases de 2 à 5 notes.
  for (let k = 0; k < 14; k++) {
    const t0 = rnd() * total;
    const base = 2200 + rnd() * 2200;
    const notes = 2 + Math.floor(rnd() * 4);
    const a = 0.15 + rnd() * 0.2;
    for (let j = 0; j < notes; j++) {
      const up = rnd() < 0.6;
      chirps.push({ t0: t0 + j * (0.09 + rnd() * 0.05), d: 0.05 + rnd() * 0.06, f0: base * (up ? 0.85 : 1.2), f1: base * (up ? 1.25 : 0.8), a });
    }
  }
  return (t) => {
    let s = 0;
    for (const c of chirps) s += chirp(c, t);
    const gust = 0.6 + 0.4 * Math.sin(2 * Math.PI * t * 0.13);
    return s + wind(rnd() * 2 - 1) * 0.35 * gust;
  };
});

// Pluie : bruit blanc filtré + gouttes.
ambience('rain', 303, 0.5, (rnd) => {
  const lp = lowpass(3500);
  const hpLp = lowpass(300);
  const dropLp = lowpass(2500);
  let drop = 0;
  return () => {
    const w = rnd() * 2 - 1;
    const f = lp(w);
    const hiss = f - hpLp(f); // passe-bande grossier
    if (rnd() < 0.0025) drop = 0.4 + rnd() * 0.6;
    drop *= 0.996;
    const d = dropLp((rnd() * 2 - 1) * drop);
    return hiss * 0.45 + d * 0.5;
  };
});

// Vent d'hiver : bruit filtré dont la coupure et le volume ondulent lentement.
ambience('wind', 404, 0.55, (rnd) => {
  const a = lowpass(400);
  const b = lowpass(400);
  const ph = rnd() * 6;
  return (t) => {
    const m = 0.5 + 0.3 * Math.sin(2 * Math.PI * t * 0.11 + ph) + 0.2 * Math.sin(2 * Math.PI * t * 0.37);
    const fc = 200 + m * 700;
    const y = b(a(rnd() * 2 - 1, fc), fc);
    return y * (0.4 + m);
  };
});

// Foule : brouhaha (bruit modulé par des « voix ») + acclamations.
ambience('crowd', 505, 0.55, (rnd, total) => {
  const voices = [];
  for (let k = 0; k < 6; k++) voices.push({ f: 1.5 + rnd() * 4, p: rnd() * 6, lp: lowpass(500 + rnd() * 800) });
  const cheers = events(rnd, total, 3, (r) => ({ d: 1.6 + r() * 1.2, a: 0.6 + r() * 0.4 }));
  const cheerLp = lowpass(2200);
  return (t) => {
    let s = 0;
    for (const v of voices) s += v.lp(rnd() * 2 - 1) * (0.5 + 0.5 * Math.sin(2 * Math.PI * v.f * t + v.p));
    let c = 0;
    for (const e of cheers) {
      const u = (t - e.t0) / e.d;
      if (u > 0 && u < 1) c += Math.sin(Math.PI * Math.sqrt(u)) * e.a;
    }
    return s * 0.5 + cheerLp(rnd() * 2 - 1) * c * 0.9;
  };
});

// Nuit : grillons (impulsions aiguës rythmées) + rumeur très faible.
ambience('night', 606, 0.4, (rnd) => {
  const crickets = [];
  for (let k = 0; k < 3; k++) crickets.push({ f: 4200 + rnd() * 900, rate: 1.1 + rnd() * 0.8, p: rnd(), a: 0.25 + rnd() * 0.2 });
  const br = brown(rnd);
  const lp = lowpass(150);
  return (t) => {
    let s = 0;
    for (const c of crickets) {
      // Trille : 3 impulsions rapides par cycle, puis silence.
      const cyc = (t * c.rate + c.p) % 1;
      if (cyc < 0.18) {
        const pulse = (cyc / 0.06) % 1;
        s += Math.sin(2 * Math.PI * c.f * t) * Math.sin(Math.PI * pulse) * c.a;
      }
    }
    return s + lp(br()) * 0.25;
  };
});
