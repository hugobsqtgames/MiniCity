/** Palette "SimCity 2000" : Vert (R), Bleu (C), Jaune (I), Gris (routes), Noir (énergie). */
export const PALETTE = {
  background: '#0b1622',
  highlight: '#ffffff',

  grass: '#2ecc71',
  grassBorder: '#27ae60',
  dirt: '#b9855a',
  dirtBorder: '#a0703f',
  cliffLeft: '#8e5b34',
  cliffRight: '#6b4224',

  asphalt: '#7f8c8d',
  curb: '#95a5a6',
  median: '#f1c40f',

  pavement: '#bdc3c7',
  parkPath: '#e5d3b3',
  pavementBorder: '#95a5a6',
  powerGround: '#566573',

  zoneLot: { R: '#a9dfbf', C: '#aed6f1', I: '#f9e79f' },
  zoneBorder: { R: '#27ae60', C: '#2e86c1', I: '#d4ac0d' },

  residential: '#27ae60',
  residentialRoof: '#1e8449',
  commercial: '#3498db',
  industrial: '#f1c40f',
  power: '#2c3e50',
  chimney: '#7f8c8d',
  coolingTower: '#aab7b8',

  windowR: '#eafaf1',
  windowC: '#d6eaf8',
  windowI: '#7d6608',
  windowPower: '#f4d03f',

  outline: 'rgba(0,0,0,0.35)',
  shadow: 'rgba(0,0,0,0.2)',
} as const;

/** Éclaircit (f > 0) ou assombrit (f < 0) une couleur #rrggbb. */
export function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (c: number) => {
    const v = f >= 0 ? c + (255 - c) * f : c * (1 + f);
    return Math.max(0, Math.min(255, Math.round(v)));
  };
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
