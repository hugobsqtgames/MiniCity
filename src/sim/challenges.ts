import { isRoadType, isZone, type Tile } from '../engine/map';
import type { Policy, CityStats } from './simulation';

/**
 * Arbre de défis, à la manière des « progrès » de Minecraft : chaque défi se
 * débloque quand son parent est réussi. Trois cadres : tâche (carré), objectif
 * (arrondi) et défi (doré, le plus dur). Chaque réussite rapporte de l'argent.
 */

/** Compteurs cumulés au fil de la partie (sauvegardés). */
export type Counters = {
  extinguished: number;
  disasters: number;
  events: number;
  match: number;
  concert: number;
  festival: number;
  christmas: number;
  fireworks: number;
  market: number;
  rebuilt: number;
  /** Mois d'hiver passés avec une ville déneigée (budget transports ≥ 80 %). */
  winterOk: number;
  /** Mois consécutifs avec un budget positif. */
  surplusStreak: number;
};
export const EMPTY_COUNTERS: Counters = {
  extinguished: 0,
  disasters: 0,
  events: 0,
  match: 0,
  concert: 0,
  festival: 0,
  christmas: 0,
  fireworks: 0,
  market: 0,
  rebuilt: 0,
  winterOk: 0,
  surplusStreak: 0,
};

export type ChallengeContext = {
  stats: CityStats;
  /** Nombre de tuiles de chaque type. */
  count: Record<string, number>;
  /** Zones construites au niveau 3, et zones bâties par type. */
  dense: { R: number; C: number; I: number };
  built: { R: number; C: number; I: number };
  bridges: number;
  treasury: number;
  month: number;
  counters: Counters;
  policy: Policy;
};

export type Frame = 'task' | 'goal' | 'challenge';

export type Challenge = {
  id: string;
  parent: string | null;
  icon: string;
  title: string;
  desc: string;
  frame: Frame;
  reward: number;
  /** Progression [actuel, objectif]. */
  progress: (c: ChallengeContext) => [number, number];
};

const n = (c: ChallengeContext, type: string) => c.count[type] ?? 0;
const pop = (target: number) => (c: ChallengeContext): [number, number] => [c.stats.population, target];
const has = (type: string, k = 1) => (c: ChallengeContext): [number, number] => [n(c, type), k];
/** Condition à remplir avec une population minimale (sinon progression 0). */
const withPop = (min: number, ok: (c: ChallengeContext) => boolean) => (c: ChallengeContext): [number, number] => [c.stats.population >= min && ok(c) ? 1 : 0, 1];

export const CHALLENGES: Challenge[] = [
  { id: 'start', parent: null, icon: '🏁', title: 'Premier coup de pelle', desc: 'Tracez votre première rue.', frame: 'task', reward: 500, progress: (c) => [c.stats.roads, 1] },

  // Croissance.
  { id: 'pop100', parent: 'start', icon: '🏡', title: 'Hameau', desc: 'Atteindre 100 habitants.', frame: 'task', reward: 1000, progress: pop(100) },
  { id: 'pop500', parent: 'pop100', icon: '🏘️', title: 'Village', desc: 'Atteindre 500 habitants.', frame: 'task', reward: 2000, progress: pop(500) },
  { id: 'pop1k', parent: 'pop500', icon: '🏙️', title: 'Bourg', desc: 'Atteindre 1 000 habitants.', frame: 'task', reward: 3000, progress: pop(1000) },
  { id: 'pop5k', parent: 'pop1k', icon: '🌆', title: 'Ville', desc: 'Atteindre 5 000 habitants.', frame: 'goal', reward: 8000, progress: pop(5000) },
  { id: 'pop10k', parent: 'pop5k', icon: '🌇', title: 'Grande ville', desc: 'Atteindre 10 000 habitants.', frame: 'goal', reward: 15000, progress: pop(10000) },
  { id: 'pop25k', parent: 'pop10k', icon: '🌃', title: 'Métropole', desc: 'Atteindre 25 000 habitants.', frame: 'goal', reward: 30000, progress: pop(25000) },
  { id: 'pop50k', parent: 'pop25k', icon: '🗽', title: 'Mégalopole', desc: 'Atteindre 50 000 habitants.', frame: 'challenge', reward: 100000, progress: pop(50000) },
  { id: 'towers', parent: 'pop1k', icon: '🏢', title: 'Gratte-ciel', desc: '10 immeubles résidentiels de niveau 3.', frame: 'task', reward: 4000, progress: (c) => [c.dense.R, 10] },
  { id: 'cbd', parent: 'towers', icon: '🏦', title: 'Quartier d’affaires', desc: '20 tours de bureaux (commerce niveau 3).', frame: 'goal', reward: 10000, progress: (c) => [c.dense.C, 20] },
  { id: 'happy80', parent: 'pop5k', icon: '😍', title: 'Ville du bonheur', desc: '80 % de satisfaction avec 5 000 habitants.', frame: 'challenge', reward: 25000, progress: withPop(5000, (c) => c.stats.happiness >= 80) },

  // Énergie.
  { id: 'power', parent: 'start', icon: '💡', title: 'Que la lumière soit', desc: 'Construire une centrale.', frame: 'task', reward: 1000, progress: (c) => [c.stats.plants, 1] },
  { id: 'wind3', parent: 'power', icon: '🌬️', title: 'Dans le vent', desc: '3 éoliennes.', frame: 'task', reward: 1500, progress: has('WIND', 3) },
  { id: 'solar5', parent: 'wind3', icon: '☀️', title: 'Plein soleil', desc: '5 centrales solaires.', frame: 'task', reward: 3000, progress: has('SOLAR', 5) },
  { id: 'green', parent: 'solar5', icon: '♻️', title: '100 % renouvelable', desc: '600 MW produits sans charbon ni nucléaire.', frame: 'challenge', reward: 20000, progress: (c) => [n(c, 'POWER') + n(c, 'NUCLEAR') === 0 ? c.stats.power.supply : 0, 600] },
  { id: 'nuclear', parent: 'power', icon: '⚛️', title: 'L’atome', desc: 'Construire une centrale nucléaire.', frame: 'goal', reward: 5000, progress: has('NUCLEAR') },
  { id: 'gigawatt', parent: 'nuclear', icon: '🔋', title: 'Gigawatts', desc: 'Produire 3 000 MW.', frame: 'goal', reward: 12000, progress: (c) => [c.stats.power.supply, 3000] },
  { id: 'nobrownout', parent: 'power', icon: '🔌', title: 'Réseau solide', desc: 'Servir 1 000 MW sans aucun délestage.', frame: 'task', reward: 4000, progress: (c) => [c.stats.power.served >= c.stats.power.demand - 1 ? c.stats.power.served : 0, 1000] },

  // Services et sécurité.
  { id: 'water', parent: 'power', icon: '💧', title: 'Eau courante', desc: 'Construire un château d’eau.', frame: 'task', reward: 800, progress: has('WATER') },
  { id: 'police', parent: 'water', icon: '🚓', title: 'Ordre public', desc: 'Ouvrir un commissariat.', frame: 'task', reward: 800, progress: has('POLICE') },
  { id: 'safe', parent: 'police', icon: '🛡️', title: 'Ville sûre', desc: 'Criminalité sous 8 % avec 3 000 habitants.', frame: 'goal', reward: 10000, progress: withPop(3000, (c) => c.stats.crime <= 8) },
  { id: 'firestation', parent: 'water', icon: '🚒', title: 'Soldats du feu', desc: 'Ouvrir une caserne de pompiers.', frame: 'task', reward: 800, progress: has('FIRE') },
  { id: 'fires10', parent: 'firestation', icon: '🧯', title: 'Héros du feu', desc: 'Éteindre 10 incendies.', frame: 'task', reward: 3000, progress: (c) => [c.counters.extinguished, 10] },
  { id: 'fires50', parent: 'fires10', icon: '🎖️', title: 'Caserne d’élite', desc: 'Éteindre 50 incendies.', frame: 'challenge', reward: 15000, progress: (c) => [c.counters.extinguished, 50] },
  { id: 'hospital', parent: 'firestation', icon: '🏥', title: 'Santé pour tous', desc: 'Ouvrir un hôpital.', frame: 'task', reward: 1500, progress: has('HOSPITAL') },
  { id: 'school', parent: 'hospital', icon: '🏫', title: 'Bancs d’école', desc: 'Ouvrir 3 écoles.', frame: 'task', reward: 2000, progress: has('SCHOOL', 3) },
  { id: 'university', parent: 'school', icon: '🎓', title: 'Campus', desc: 'Construire l’université.', frame: 'goal', reward: 10000, progress: has('UNIVERSITY') },

  // Transports.
  { id: 'roads50', parent: 'start', icon: '🛣️', title: 'Réseau routier', desc: '50 tuiles de route.', frame: 'task', reward: 1000, progress: (c) => [c.stats.roads, 50] },
  { id: 'avenue', parent: 'roads50', icon: '🛤️', title: 'Boulevard', desc: '20 tuiles d’avenue.', frame: 'task', reward: 2000, progress: has('AVENUE', 20) },
  { id: 'highway', parent: 'avenue', icon: '🚙', title: 'Voie rapide', desc: '30 tuiles d’autoroute.', frame: 'task', reward: 3000, progress: has('HIGHWAY', 30) },
  { id: 'airport', parent: 'highway', icon: '✈️', title: 'Envol', desc: 'Construire l’aéroport.', frame: 'goal', reward: 15000, progress: has('AIRPORT') },
  { id: 'bridge', parent: 'roads50', icon: '🌉', title: 'Jeter des ponts', desc: 'Construire 3 ponts.', frame: 'task', reward: 2000, progress: (c) => [c.bridges, 3] },
  { id: 'bus5', parent: 'roads50', icon: '🚏', title: 'Ligne de bus', desc: '5 arrêts de bus.', frame: 'task', reward: 1500, progress: has('BUSSTOP', 5) },
  { id: 'metro3', parent: 'bus5', icon: '🚇', title: 'Métro', desc: '3 stations de métro.', frame: 'task', reward: 3000, progress: has('METRO', 3) },
  { id: 'fluid', parent: 'metro3', icon: '🟢', title: 'Circulation fluide', desc: 'Bouchons sous 50 % avec 5 000 habitants.', frame: 'challenge', reward: 20000, progress: withPop(5000, (c) => c.stats.congestion <= 50) },

  // Économie et industrie.
  { id: 'money50k', parent: 'start', icon: '💵', title: 'Bas de laine', desc: 'Avoir 50 000 $ en caisse.', frame: 'task', reward: 1000, progress: (c) => [c.treasury, 50000] },
  { id: 'money250k', parent: 'money50k', icon: '💰', title: 'Coffre-fort', desc: 'Avoir 250 000 $ en caisse.', frame: 'task', reward: 5000, progress: (c) => [c.treasury, 250000] },
  { id: 'money1m', parent: 'money250k', icon: '🤑', title: 'Millionnaire', desc: 'Avoir 1 000 000 $ en caisse.', frame: 'goal', reward: 20000, progress: (c) => [c.treasury, 1000000] },
  { id: 'money10m', parent: 'money1m', icon: '👑', title: 'Trésor national', desc: 'Avoir 10 000 000 $ en caisse.', frame: 'challenge', reward: 100000, progress: (c) => [c.treasury, 10000000] },
  { id: 'surplus', parent: 'money50k', icon: '📈', title: 'Gestion saine', desc: '24 mois d’affilée en excédent.', frame: 'goal', reward: 8000, progress: (c) => [c.counters.surplusStreak, 24] },
  { id: 'lowtax', parent: 'surplus', icon: '🏝️', title: 'Paradis fiscal', desc: 'Impôts à 5 % ou moins avec 3 000 habitants.', frame: 'challenge', reward: 15000, progress: withPop(3000, (c) => c.policy.taxes.R <= 5 && c.policy.taxes.C <= 5 && c.policy.taxes.I <= 5) },
  { id: 'industry', parent: 'start', icon: '🏭', title: 'Zone industrielle', desc: '20 usines en activité.', frame: 'task', reward: 1500, progress: (c) => [c.built.I, 20] },
  { id: 'freight', parent: 'industry', icon: '🚂', title: 'En voiture', desc: 'Construire une gare de fret.', frame: 'task', reward: 2000, progress: has('FREIGHT') },
  { id: 'port', parent: 'freight', icon: '⚓', title: 'Port de commerce', desc: 'Construire un port.', frame: 'task', reward: 4000, progress: has('PORT') },
  { id: 'exporter', parent: 'port', icon: '🚢', title: 'Exportateur', desc: '2 000 emplois industriels qui exportent.', frame: 'goal', reward: 15000, progress: (c) => [Math.min(c.stats.exports.capacity, c.stats.exports.connected), 2000] },

  // Environnement.
  { id: 'parks10', parent: 'start', icon: '🌳', title: 'Poumon vert', desc: '10 parcs.', frame: 'task', reward: 1000, progress: has('PARK', 10) },
  { id: 'landfill', parent: 'parks10', icon: '🗑️', title: 'Propreté', desc: 'Construire une décharge.', frame: 'task', reward: 800, progress: has('LANDFILL') },
  { id: 'recycle', parent: 'landfill', icon: '♻️', title: 'Tri sélectif', desc: 'Construire un centre de recyclage.', frame: 'task', reward: 2000, progress: has('RECYCLING') },
  { id: 'cleanair', parent: 'recycle', icon: '🍃', title: 'Air pur', desc: 'Pollution sous 8 % avec 3 000 habitants.', frame: 'goal', reward: 10000, progress: withPop(3000, (c) => c.stats.pollution <= 8) },
  { id: 'greencity', parent: 'cleanair', icon: '🌲', title: 'Ville verte', desc: '30 parcs et l’ordonnance « Plantation d’arbres ».', frame: 'challenge', reward: 20000, progress: (c) => [c.policy.ordinances.trees ? n(c, 'PARK') : 0, 30] },

  // Culture et événements.
  { id: 'market', parent: 'pop100', icon: '🛒', title: 'Jour de marché', desc: 'Construire un marché.', frame: 'task', reward: 800, progress: has('MARKET') },
  { id: 'christmas', parent: 'market', icon: '🎄', title: 'Esprit de Noël', desc: 'Organiser un marché de Noël (décembre).', frame: 'task', reward: 2000, progress: (c) => [c.counters.christmas, 1] },
  { id: 'fair', parent: 'market', icon: '🎡', title: 'Fête foraine', desc: 'Construire une fête foraine.', frame: 'task', reward: 1500, progress: has('FAIR') },
  { id: 'fireworks', parent: 'fair', icon: '🎆', title: 'Feu d’artifice', desc: 'Admirer le feu d’artifice du 14 juillet.', frame: 'task', reward: 2000, progress: (c) => [c.counters.fireworks, 1] },
  { id: 'events25', parent: 'fair', icon: '🎉', title: 'Ville festive', desc: 'Accueillir 25 événements.', frame: 'goal', reward: 10000, progress: (c) => [c.counters.events, 25] },
  { id: 'events100', parent: 'events25', icon: '🥳', title: 'Capitale de la fête', desc: 'Accueillir 100 événements.', frame: 'challenge', reward: 30000, progress: (c) => [c.counters.events, 100] },
  { id: 'arena', parent: 'fair', icon: '🎵', title: 'Scène ouverte', desc: 'Construire une salle de concert.', frame: 'task', reward: 2500, progress: has('ARENA') },
  { id: 'concerts5', parent: 'arena', icon: '🎸', title: 'Tournée', desc: '5 concerts.', frame: 'task', reward: 4000, progress: (c) => [c.counters.concert, 5] },
  { id: 'stadium', parent: 'arena', icon: '🏟️', title: 'Stade', desc: 'Construire un stade.', frame: 'task', reward: 4000, progress: has('STADIUM') },
  { id: 'matches10', parent: 'stadium', icon: '⚽', title: 'Saison sportive', desc: '10 matchs au stade.', frame: 'goal', reward: 8000, progress: (c) => [c.counters.match, 10] },
  { id: 'landmark', parent: 'stadium', icon: '🗼', title: 'Tour emblématique', desc: 'Construire la tour.', frame: 'goal', reward: 15000, progress: has('LANDMARK') },
  { id: 'wonders', parent: 'landmark', icon: '🏛️', title: 'Toutes les merveilles', desc: 'Université, aéroport et tour dans la même ville.', frame: 'challenge', reward: 50000, progress: (c) => [Math.min(1, n(c, 'UNIVERSITY')) + Math.min(1, n(c, 'AIRPORT')) + Math.min(1, n(c, 'LANDMARK')), 3] },

  // Mandat et survie.
  { id: 'year1', parent: 'start', icon: '📅', title: 'Premier mandat', desc: 'Gouverner pendant 1 an.', frame: 'task', reward: 1000, progress: (c) => [c.month, 12] },
  { id: 'year10', parent: 'year1', icon: '🗓️', title: 'Décennie', desc: 'Gouverner pendant 10 ans.', frame: 'goal', reward: 15000, progress: (c) => [c.month, 120] },
  { id: 'year50', parent: 'year10', icon: '⏳', title: 'Dynastie', desc: 'Gouverner pendant 50 ans.', frame: 'challenge', reward: 100000, progress: (c) => [c.month, 600] },
  { id: 'winter', parent: 'year1', icon: '❄️', title: 'Hiver maîtrisé', desc: 'Passer 3 mois d’hiver déneigés (budget transports ≥ 80 %, 1 000 habitants).', frame: 'task', reward: 3000, progress: (c) => [c.counters.winterOk, 3] },
  { id: 'disaster1', parent: 'year1', icon: '🌪️', title: 'Survivant', desc: 'Traverser une catastrophe.', frame: 'task', reward: 3000, progress: (c) => [c.counters.disasters, 1] },
  { id: 'phoenix', parent: 'disaster1', icon: '🐦‍🔥', title: 'Phénix', desc: 'Reconstruire 20 bâtiments sinistrés.', frame: 'goal', reward: 8000, progress: (c) => [c.counters.rebuilt, 20] },
  { id: 'disaster5', parent: 'disaster1', icon: '🏚️', title: 'Indestructible', desc: 'Traverser 5 catastrophes.', frame: 'challenge', reward: 25000, progress: (c) => [c.counters.disasters, 5] },
];

export const CHALLENGE_BY_ID = Object.fromEntries(CHALLENGES.map((c) => [c.id, c])) as Record<string, Challenge>;

/** Contexte des défis, calculé à partir de la carte et de l'état de la ville. */
export function challengeContext(
  tiles: Tile[],
  stats: CityStats,
  treasury: number,
  month: number,
  counters: Counters,
  policy: Policy,
): ChallengeContext {
  const count: Record<string, number> = {};
  const dense = { R: 0, C: 0, I: 0 };
  const built = { R: 0, C: 0, I: 0 };
  let bridges = 0;
  for (const t of tiles) {
    count[t.type] = (count[t.type] ?? 0) + 1;
    if (isZone(t.type) && t.density > 0) {
      built[t.type]++;
      if (t.density === 3) dense[t.type]++;
    }
    if (t.lake && isRoadType(t.type)) bridges++;
  }
  return { stats, count, dense, built, bridges, treasury, month, counters, policy };
}

/** Défis nouvellement réussis (parent réussi et objectif atteint). */
export function newlyCompleted(ctx: ChallengeContext, done: Record<string, number>): Challenge[] {
  const out: Challenge[] = [];
  const doneNow = { ...done };
  // Plusieurs passes : un défi réussi peut débloquer son enfant dans la foulée.
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const c of CHALLENGES) {
      if (doneNow[c.id] !== undefined) continue;
      if (c.parent && doneNow[c.parent] === undefined) continue;
      const [cur, goal] = c.progress(ctx);
      if (cur >= goal) {
        doneNow[c.id] = ctx.month;
        out.push(c);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

export type NodeLayout = { id: string; col: number; row: number };

/**
 * Mise en page de l'arbre (de gauche à droite comme dans Minecraft) : la
 * colonne est la profondeur, chaque feuille prend une ligne, un parent se
 * place sur la ligne de son premier enfant.
 */
export function layoutTree(): { nodes: NodeLayout[]; cols: number; rows: number } {
  const children = new Map<string | null, Challenge[]>();
  for (const c of CHALLENGES) {
    const list = children.get(c.parent) ?? [];
    list.push(c);
    children.set(c.parent, list);
  }
  const nodes: NodeLayout[] = [];
  let nextRow = 0;
  let cols = 0;
  const place = (c: Challenge, depth: number): number => {
    cols = Math.max(cols, depth + 1);
    const kids = children.get(c.id) ?? [];
    let row: number;
    if (!kids.length) row = nextRow++;
    else {
      const rows = kids.map((k) => place(k, depth + 1));
      row = rows[0];
    }
    nodes.push({ id: c.id, col: depth, row });
    return row;
  };
  for (const root of children.get(null) ?? []) place(root, 0);
  return { nodes, cols, rows: nextRow };
}
