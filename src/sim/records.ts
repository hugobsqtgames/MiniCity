/**
 * Records de la ville : meilleurs chiffres atteints depuis sa fondation.
 * Chaque record garde sa valeur et le mois où il a été établi.
 */

export type RecordEntry = { value: number; month: number };

export type CityRecords = {
  population: RecordEntry;
  treasury: RecordEntry;
  happiness: RecordEntry;
  /** Meilleur solde mensuel (recettes − dépenses). */
  bestMonth: RecordEntry;
  /** Pire solde mensuel. */
  worstMonth: RecordEntry;
  /** Plus longue série de mois excédentaires. */
  surplusStreak: RecordEntry;
  tourists: RecordEntry;
  /** Plus grosse catastrophe (tuiles touchées). */
  disaster: RecordEntry & { kind: string };
  /** Totaux cumulés. */
  totalEvents: number;
  totalDisasters: number;
  totalFires: number;
  totalIncome: number;
};

const zero = (): RecordEntry => ({ value: 0, month: 0 });

export const EMPTY_RECORDS: CityRecords = {
  population: zero(),
  treasury: zero(),
  happiness: zero(),
  bestMonth: zero(),
  worstMonth: zero(),
  surplusStreak: zero(),
  tourists: zero(),
  disaster: { ...zero(), kind: '' },
  totalEvents: 0,
  totalDisasters: 0,
  totalFires: 0,
  totalIncome: 0,
};

export type MonthFacts = {
  month: number;
  population: number;
  treasury: number;
  happiness: number;
  net: number;
  income: number;
  streak: number;
  tourists: number;
  events: number;
  fires: number;
  disasters: { kind: string; damage: number }[];
};

const finite = (v: number) => (Number.isFinite(v) ? v : 0);

/** Met à jour les records ; renvoie aussi les noms des records battus ce mois-ci. */
export function updateRecords(r: CityRecords, f: MonthFacts): { records: CityRecords; broken: (keyof CityRecords)[] } {
  const out: CityRecords = { ...r };
  const broken: (keyof CityRecords)[] = [];
  const up = (key: 'population' | 'treasury' | 'happiness' | 'surplusStreak' | 'tourists', v: number) => {
    v = finite(v);
    if (v > r[key].value) {
      out[key] = { value: v, month: f.month };
      broken.push(key);
    }
  };
  up('population', f.population);
  up('treasury', Math.round(f.treasury));
  // La satisfaction d'une ville vide ne compte pas.
  if (f.population >= 100) up('happiness', f.happiness);
  // Meilleur et pire mois : le premier mois joué sert de référence (même négatif).
  const unset = (e: RecordEntry) => e.month === 0 && e.value === 0;
  const net = Math.round(finite(f.net));
  if (unset(r.bestMonth) || net > r.bestMonth.value) {
    out.bestMonth = { value: net, month: f.month };
    if (!unset(r.bestMonth)) broken.push('bestMonth');
  }
  up('surplusStreak', f.streak);
  up('tourists', f.tourists);
  if (unset(r.worstMonth) || net < r.worstMonth.value) out.worstMonth = { value: net, month: f.month };
  for (const d of f.disasters) {
    if (d.damage > out.disaster.value) {
      out.disaster = { value: d.damage, month: f.month, kind: d.kind };
      broken.push('disaster');
    }
  }
  out.totalEvents = r.totalEvents + f.events;
  out.totalDisasters = r.totalDisasters + f.disasters.length;
  out.totalFires = r.totalFires + f.fires;
  out.totalIncome = r.totalIncome + Math.max(0, Math.round(finite(f.income)));
  return { records: out, broken };
}

/** Relit des records sauvegardés (champs manquants ou invalides remis à zéro). */
export function sanitizeRecords(raw: unknown): CityRecords {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const entry = (v: unknown): RecordEntry => {
    const e = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    return { value: finite(Number(e.value)), month: finite(Number(e.month)) };
  };
  const d = (src.disaster && typeof src.disaster === 'object' ? src.disaster : {}) as Record<string, unknown>;
  return {
    population: entry(src.population),
    treasury: entry(src.treasury),
    happiness: entry(src.happiness),
    bestMonth: entry(src.bestMonth),
    worstMonth: entry(src.worstMonth),
    surplusStreak: entry(src.surplusStreak),
    tourists: entry(src.tourists),
    disaster: { ...entry(d), kind: typeof d.kind === 'string' ? d.kind : '' },
    totalEvents: finite(Number(src.totalEvents)),
    totalDisasters: finite(Number(src.totalDisasters)),
    totalFires: finite(Number(src.totalFires)),
    totalIncome: finite(Number(src.totalIncome)),
  };
}
