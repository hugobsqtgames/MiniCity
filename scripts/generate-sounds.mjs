/**
 * Génère les effets sonores et la musique de MiniCity par synthèse (aucun
 * fichier externe, aucune requête réseau) : `node scripts/generate-sounds.mjs`.
 * Sortie : assets/sounds/*.wav (PCM 16 bits mono).
 */
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
