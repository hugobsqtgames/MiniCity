import type { Tile } from '../engine/map';
import { districtMap, deLieu } from './districts';
import type { Analysis } from './simulation';

/**
 * Demandes des habitants : un quartier réclame quelque chose (un parc, une
 * école, moins de bruit…). Le maire a un délai pour y répondre ; s'il réussit,
 * la ville reçoit une récompense et un regain de satisfaction.
 */

export type MissionKind = 'park' | 'school' | 'hospital' | 'police' | 'transit' | 'pollution' | 'water' | 'jobs';

export type Mission = {
  id: number;
  kind: MissionKind;
  district: number;
  /** Mois de la demande et date limite. */
  start: number;
  deadline: number;
  reward: number;
};

type Def = {
  icon: string;
  /** Phrase des habitants (le quartier est inséré). */
  ask: (de: string) => string;
  /** Mesure actuelle (0-100) et objectif ; `lower` = il faut descendre sous l'objectif. */
  measure: (ctx: Ctx) => number;
  goal: number;
  lower?: boolean;
  reward: number;
};

type Ctx = { tiles: Tile[]; size: number; a: Analysis; ids: Uint8Array; district: number; homes: number[] };

/** Part (0-100) des logements du quartier pour lesquels `f` est vrai. */
const share = (c: Ctx, f: (i: number) => boolean) => (c.homes.length ? Math.round((c.homes.filter(f).length / c.homes.length) * 100) : 0);

export const MISSIONS: Record<MissionKind, Def> = {
  park: {
    icon: '🌳',
    ask: (de) => `Les habitants ${de} réclament un parc près de chez eux.`,
    measure: (c) => share(c, (i) => c.a.cov.PARK[i] > 0),
    goal: 70,
    reward: 600,
  },
  school: {
    icon: '🏫',
    ask: (de) => `Les familles ${de} veulent une école pour leurs enfants.`,
    measure: (c) => share(c, (i) => c.a.cov.SCHOOL[i] > 0),
    goal: 80,
    reward: 900,
  },
  hospital: {
    icon: '🏥',
    ask: (de) => `Les anciens ${de} demandent un hôpital plus proche.`,
    measure: (c) => share(c, (i) => c.a.cov.HOSPITAL[i] > 0),
    goal: 80,
    reward: 1000,
  },
  police: {
    icon: '🚓',
    ask: (de) => `Les commerçants ${de} se plaignent de l’insécurité.`,
    measure: (c) => share(c, (i) => c.a.maps.crime[i] > 0.3),
    goal: 15,
    lower: true,
    reward: 900,
  },
  transit: {
    icon: '🚏',
    ask: (de) => `Les habitants ${de} veulent un bus, un tram ou une gare.`,
    measure: (c) => share(c, (i) => c.a.cov.BUSSTOP[i] > 0 || c.a.cov.METRO[i] > 0 || c.a.cov.TRAM[i] > 0 || c.a.cov.STATION[i] > 0),
    goal: 60,
    reward: 700,
  },
  pollution: {
    icon: '🏭',
    ask: (de) => `Les riverains ${de} étouffent : moins de pollution, vite !`,
    measure: (c) => share(c, (i) => c.a.pollution[i] > 25),
    goal: 15,
    lower: true,
    reward: 1200,
  },
  water: {
    icon: '🫧',
    ask: (de) => `Le lac ${de} est sale : construisez une station d’épuration.`,
    measure: (c) => share(c, (i) => c.a.maps.water[i] > 0.25),
    goal: 10,
    lower: true,
    reward: 1200,
  },
  jobs: {
    icon: '💼',
    ask: (de) => `Les jeunes ${de} cherchent du travail tout près.`,
    measure: (c) => share(c, (i) => c.a.traffic.commute[i] >= 0 && c.a.traffic.commute[i] <= 14),
    goal: 70,
    reward: 800,
  },
};

const MISSION_MONTHS = 12;
const MAX_ACTIVE = 2;

function ctxFor(tiles: Tile[], size: number, a: Analysis, district: number): Ctx {
  const ids = districtMap(size).ids;
  const homes: number[] = [];
  for (let i = 0; i < tiles.length; i++) if (ids[i] === district && tiles[i].type === 'R' && tiles[i].density > 0) homes.push(i);
  return { tiles, size, a, ids, district, homes };
}

/** Progression d'une demande : mesure actuelle, objectif, réussie ou non. */
export function missionProgress(m: Mission, tiles: Tile[], size: number, a: Analysis): { value: number; goal: number; done: boolean } {
  const def = MISSIONS[m.kind];
  const c = ctxFor(tiles, size, a, m.district);
  if (!c.homes.length) return { value: 0, goal: def.goal, done: false };
  const value = def.measure(c);
  return { value, goal: def.goal, done: def.lower ? value <= def.goal : value >= def.goal };
}

export function missionText(m: Mission, size: number): { icon: string; text: string; district: string } {
  const d = districtMap(size).list[m.district];
  return { icon: MISSIONS[m.kind].icon, text: MISSIONS[m.kind].ask(deLieu(d.name)), district: d.name };
}

/**
 * Nouvelle demande : le quartier habité où le problème est le plus marqué.
 * Renvoie null si rien ne cloche (ou s'il y a déjà assez de demandes en cours).
 */
export function proposeMission(tiles: Tile[], size: number, a: Analysis, month: number, active: Mission[], random: () => number, id: number): Mission | null {
  if (active.length >= MAX_ACTIVE || a.stats.population < 150) return null;
  const dm = districtMap(size);
  const candidates: { kind: MissionKind; district: number; gap: number }[] = [];
  const hasLake = tiles.some((t) => t.type === 'LAKE');
  for (const d of dm.list) {
    if (active.some((m) => m.district === d.id)) continue;
    const c = ctxFor(tiles, size, a, d.id);
    if (c.homes.length < 4) continue;
    for (const kind of Object.keys(MISSIONS) as MissionKind[]) {
      if (kind === 'water' && !hasLake) continue;
      const def = MISSIONS[kind];
      const v = def.measure(c);
      const gap = def.lower ? v - def.goal : def.goal - v;
      // On ne demande que ce qui est clairement insuffisant (marge de 20 points).
      if (gap > 20) candidates.push({ kind, district: d.id, gap: gap + random() * 15 });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((p, q) => q.gap - p.gap);
  const pick = candidates[Math.floor(random() * Math.min(3, candidates.length))];
  return { id, kind: pick.kind, district: pick.district, start: month, deadline: month + MISSION_MONTHS, reward: MISSIONS[pick.kind].reward };
}
