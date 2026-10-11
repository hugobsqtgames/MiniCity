import { isZone, type Tile } from '../engine/map';
import { EXPORT_NEEDED_AT, seasonOf, type DataView, type ToolId } from './constants';
import { aLieu, computeDistrictStats, deLieu, districtAt } from './districts';
import type { Analysis, Policy } from './simulation';

/**
 * Conseillers municipaux : chacun analyse son domaine et explique au maire ce
 * qui ne va pas, où, et quoi faire. Les conseils pointent une tuile (la caméra
 * peut s'y rendre) et proposent la vue de données ou l'outil utile.
 */

export type AdvisorId = 'transport' | 'energy' | 'safety' | 'environment' | 'finance' | 'urbanism' | 'services' | 'industry' | 'culture';

export const ADVISORS: Record<AdvisorId, { name: string; role: string; icon: string }> = {
  transport: { name: 'Jeanne Roux', role: 'Transports', icon: '🚦' },
  energy: { name: 'Karim Volta', role: 'Énergie', icon: '⚡' },
  safety: { name: 'Capitaine Morel', role: 'Sécurité', icon: '🛡️' },
  environment: { name: 'Léa Verdier', role: 'Environnement', icon: '🌿' },
  finance: { name: 'Paul Comptant', role: 'Finances', icon: '💰' },
  urbanism: { name: 'Inès Bâtisse', role: 'Urbanisme', icon: '📐' },
  services: { name: 'Dr Lucie Soin', role: 'Services publics', icon: '🏥' },
  industry: { name: 'Marc Usinier', role: 'Industrie', icon: '🏭' },
  culture: { name: 'Zoé Festin', role: 'Culture & loisirs', icon: '🎭' },
};

export type Advice = {
  id: string;
  advisor: AdvisorId;
  /** 0 = info, 1 = conseil, 2 = problème, 3 = urgent. */
  severity: 0 | 1 | 2 | 3;
  title: string;
  text: string;
  target?: { x: number; y: number };
  view?: DataView;
  tool?: ToolId;
};

const fmt = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Les bouchons : quelle rue sature, qui l'emprunte et pour aller où. */
function trafficAdvice(tiles: Tile[], size: number, a: Analysis): Advice[] {
  const out: Advice[] = [];
  const cong = a.traffic.congestion;
  // Rues saturées, de la pire à la moins pire, en évitant de citer deux fois le même endroit.
  const jams: number[] = [];
  for (let i = 0; i < cong.length; i++) if (cong[i] > 1.05) jams.push(i);
  jams.sort((p, q) => cong[q] - cong[p]);
  const picked: number[] = [];
  for (const j of jams) {
    if (picked.length >= 2) break;
    const x = j % size;
    const y = Math.floor(j / size);
    if (picked.some((p) => Math.abs((p % size) - x) + Math.abs(Math.floor(p / size) - y) < 8)) continue;
    picked.push(j);
  }
  const { parent, homes } = a.traffic;
  for (const jam of picked) {
    const jx = jam % size;
    const jy = Math.floor(jam / size);
    const from = new Map<string, number>();
    const to = new Map<string, number>();
    let volume = 0;
    for (const h of homes) {
      if (h.road < 0 || h.workers <= 0) continue;
      let r = h.road;
      let through = false;
      for (let guard = 0; guard < 400; guard++) {
        if (r === jam) through = true;
        if (parent[r] === r || parent[r] < 0) break;
        r = parent[r];
      }
      if (!through) continue;
      volume += h.workers;
      const o = districtAt(size, h.idx % size, Math.floor(h.idx / size)).name;
      const d = districtAt(size, r % size, Math.floor(r / size)).name;
      from.set(o, (from.get(o) ?? 0) + h.workers);
      to.set(d, (to.get(d) ?? 0) + h.workers);
    }
    const top = (m: Map<string, number>) => [...m.entries()].sort((p, q) => q[1] - p[1])[0]?.[0];
    const origin = top(from);
    const dest = top(to);
    const type = tiles[jam].type;
    const kind = type === 'ROAD' ? 'La rue' : type === 'AVENUE' ? 'L’avenue' : 'L’autoroute';
    const fix =
      type === 'ROAD'
        ? 'Transformez-la en avenue (outil Avenue directement dessus), '
        : type === 'AVENUE'
          ? 'Doublez-la par une autoroute de contournement, '
          : 'Ajoutez un second axe parallèle, ';
    const why =
      origin && dest
        ? origin === dest
          ? ` Ce sont surtout des habitants ${deLieu(origin)} qui travaillent dans leur propre quartier : le réseau local est trop étroit.`
          : ` Ce sont surtout des habitants ${deLieu(origin)} qui vont travailler ${aLieu(dest)}.`
        : '';
    const local = origin && dest && origin !== dest ? ` Zoner du commerce ${aLieu(origin)} rapprocherait les emplois.` : '';
    out.push({
      id: `jam-${jam}`,
      advisor: 'transport',
      severity: cong[jam] > 1.6 ? 3 : 2,
      title: `${kind} (${jx}, ${jy}) est saturée à ${Math.round(cong[jam] * 100)} %`,
      text: `${fmt(volume)} trajets par mois passent ici.${why} ${fix}ou installez des arrêts de bus et du métro pour sortir des voitures de la route.${local}`,
      target: { x: jx, y: jy },
      view: 'traffic',
      tool: type === 'ROAD' ? 'avenue' : type === 'AVENUE' ? 'highway' : 'metro',
    });
  }
  return out;
}

/** Une tuile représentative (la première trouvée) qui vérifie la condition. */
function find(tiles: Tile[], pred: (t: Tile, i: number) => boolean): { x: number; y: number } | undefined {
  for (let i = 0; i < tiles.length; i++) if (pred(tiles[i], i)) return { x: tiles[i].x, y: tiles[i].y };
  return undefined;
}

export function getAdvice(
  tiles: Tile[],
  size: number,
  a: Analysis,
  policy: Policy,
  ctx: { treasury: number; net: number; month: number },
): Advice[] {
  const s = a.stats;
  const out: Advice[] = [];
  const pop = s.population;

  out.push(...trafficAdvice(tiles, size, a));

  // Santé publique : épidémie, eaux usées.
  if (s.epidemic > 0) {
    out.push({
      id: 'epidemic',
      advisor: 'services',
      severity: s.epidemic > 50 ? 3 : 2,
      title: `Épidémie en cours (${s.epidemic} %)`,
      text: 'Des habitants tombent malades et quittent le quartier touché. Un hôpital qui couvre la moitié du quartier fait reculer la maladie ; une station d’épuration évite qu’elle revienne.',
      target: find(tiles, (t, i) => a.maps.health[i] > 0 && t.type === 'R'),
      view: 'health',
      tool: 'hospital',
    });
  }
  if (s.waterPollution > 25) {
    out.push({
      id: 'water-pollution',
      advisor: 'environment',
      severity: s.waterPollution > 50 ? 2 : 1,
      title: `Lacs pollués à ${s.waterPollution} %`,
      text: 'Les eaux usées des quartiers et des usines finissent dans les lacs : les rives perdent de la valeur, les plages se vident et les épidémies menacent. Construisez une station d’épuration près des quartiers concernés.',
      target: find(tiles, (t, i) => t.type === 'LAKE' && a.maps.water[i] > 0.3),
      view: 'water',
      tool: 'treatment',
    });
  }
  // Éducation : sans diplômés, pas de bureaux ni de haute technologie.
  if (pop >= 1500 && s.educationLevel < 35) {
    out.push({
      id: 'education-level',
      advisor: 'services',
      severity: 2,
      title: `Niveau d’études faible (${s.educationLevel} %)`,
      text: pop >= 1000 ? 'Les tours de bureaux réclament des diplômés : complétez les écoles par un lycée (et plus tard l’université).' : 'Construisez des écoles près des quartiers résidentiels.',
      tool: pop >= 1000 ? 'highschool' : 'school',
    });
  }
  if (s.parkingShortage >= 3) {
    out.push({
      id: 'parking',
      advisor: 'transport',
      severity: 1,
      title: `${s.parkingShortage} commerces sans parking`,
      text: 'Au-delà de 2 500 habitants, les commerces denses ont besoin d’un parking à moins de 4 cases pour devenir des tours de bureaux.',
      target: find(tiles, (t, i) => t.type === 'C' && t.density >= 2 && a.cov.PARKING[i] === 0),
      tool: 'parking',
    });
  }
  // Tourisme : des visiteurs sans chambre dépensent moitié moins.
  if (s.tourists >= 200 && s.hotelGuests < s.tourists * 0.5 && pop >= 800) {
    out.push({
      id: 'hotels',
      advisor: 'culture',
      severity: 1,
      title: `${fmt(s.tourists - s.hotelGuests)} touristes sans hôtel`,
      text: 'Ils repartent le soir et dépensent moitié moins. Un hôtel (400 chambres) double leurs dépenses.',
      tool: 'hotel',
    });
  }

  // Énergie.
  if (s.plants === 0 && tiles.some((t) => isZone(t.type))) {
    out.push({ id: 'no-power', advisor: 'energy', severity: 3, title: 'Aucune centrale', text: 'Sans électricité, rien ne pousse. Posez une centrale près des zones : le courant suit routes et zones.', tool: 'power' });
  } else if (s.power.demand > s.power.served + 1) {
    const missing = s.power.demand - s.power.served;
    out.push({
      id: 'brownout',
      advisor: 'energy',
      severity: missing > s.power.demand * 0.15 ? 3 : 2,
      title: `Délestage : ${fmt(missing)} MW manquent`,
      text: `Production ${fmt(s.power.supply)} MW pour ${fmt(s.power.demand)} MW demandés : les quartiers les plus éloignés des centrales sont coupés. Construisez des centrales.`,
      target: find(tiles, (t) => isZone(t.type) && t.density > 0 && !t.powered),
      view: 'power',
      tool: pop >= 4000 ? 'nuclear' : 'power',
    });
  } else if (s.power.outOfRange > 5) {
    out.push({
      id: 'out-of-range',
      advisor: 'energy',
      severity: 2,
      title: `${fmt(s.power.outOfRange)} MW hors de portée`,
      text: 'Des bâtiments sont à plus de 15 tuiles de toute centrale (le courant suit routes, zones et bâtiments contigus). Ajoutez une centrale près d’eux, une éolienne suffit pour un petit quartier.',
      target: find(tiles, (t) => isZone(t.type) && !t.powered),
      view: 'power',
      tool: 'wind',
    });
  } else if (s.power.supply > 0 && s.power.supply < s.power.demand * 1.15) {
    out.push({ id: 'power-margin', advisor: 'energy', severity: 1, title: 'Marge électrique faible', text: `Il reste ${fmt(s.power.supply - s.power.demand)} MW de marge. L’hiver, le solaire produit deux fois moins : prévoyez une centrale de plus.`, view: 'power', tool: 'wind' });
  }
  if (seasonOf(ctx.month + 1) === 'winter' && tiles.some((t) => t.type === 'SOLAR') && s.power.supply < s.power.demand * 1.3) {
    out.push({ id: 'winter-solar', advisor: 'energy', severity: 1, title: 'L’hiver arrive', text: 'Les panneaux solaires vont produire beaucoup moins. Les éoliennes, elles, tournent mieux l’hiver.', tool: 'wind' });
  }

  // Eau.
  if (s.zones > 10 && s.wateredZones / s.zones < 0.8) {
    out.push({ id: 'water', advisor: 'services', severity: 2, title: `${Math.round(100 - (s.wateredZones / s.zones) * 100)} % des parcelles sans eau`, text: 'Sans eau courante, les bâtiments restent au niveau 1. Ajoutez des châteaux d’eau (moitié prix au bord d’un lac).', target: find(tiles, (t) => isZone(t.type) && t.powered && !t.water), tool: 'water' });
  }

  // Sécurité.
  const districts = pop > 0 ? computeDistrictStats(tiles, size, a.maps, a.cov) : [];
  const worstCrime = [...districts].sort((p, q) => q.crime - p.crime)[0];
  if (worstCrime && worstCrime.crime > 28) {
    out.push({ id: 'crime', advisor: 'safety', severity: worstCrime.crime > 45 ? 3 : 2, title: `Criminalité élevée ${aLieu(worstCrime.name)}`, text: `${worstCrime.crime} % de criminalité dans ce quartier. Construisez un commissariat au cœur du quartier ou augmentez le budget de la police.`, target: { x: worstCrime.fx, y: worstCrime.fy }, view: 'crime', tool: 'police' });
  }
  if (pop > 500 && s.coverage.fire < 60) {
    out.push({ id: 'fire', advisor: 'safety', severity: 2, title: 'Casernes de pompiers insuffisantes', text: `Seulement ${s.coverage.fire} % des bâtiments sont protégés. Un incendie non maîtrisé détruit le bâtiment en 4 mois.`, target: find(tiles, (t, i) => isZone(t.type) && t.density > 0 && a.cov.FIRE[i] === 0), tool: 'fire' });
  }

  // Services.
  if (pop > 1500 && s.coverage.health < 45) out.push({ id: 'health', advisor: 'services', severity: 1, title: 'Peu d’hôpitaux', text: `${s.coverage.health} % des habitants ont un hôpital proche. La santé compte beaucoup dans la satisfaction.`, target: find(tiles, (t, i) => t.type === 'R' && t.density > 0 && a.cov.HOSPITAL[i] === 0), tool: 'hospital' });
  if (pop > 1500 && s.coverage.education < 45) out.push({ id: 'school', advisor: 'services', severity: 1, title: 'Il manque des écoles', text: `${s.coverage.education} % des habitants ont une école proche. L’éducation augmente la valeur des quartiers.`, target: find(tiles, (t, i) => t.type === 'R' && t.density > 0 && a.cov.SCHOOL[i] === 0), tool: 'school' });
  if (pop > 300 && s.coverage.waste < 70) out.push({ id: 'waste', advisor: 'environment', severity: s.garbage > 25 ? 3 : 2, title: 'Les ordures ne sont pas ramassées', text: `${100 - s.coverage.waste} % des bâtiments ne sont pas desservis : les déchets s’entassent et les habitants s’en vont.`, target: find(tiles, (t, i) => isZone(t.type) && t.density > 0 && a.cov.LANDFILL[i] === 0 && a.cov.INCINERATOR[i] === 0), view: 'garbage', tool: 'landfill' });
  if (s.landfill > 80) out.push({ id: 'landfill', advisor: 'environment', severity: 2, title: 'Les décharges débordent', text: `Remplies à ${s.landfill} %. Un incinérateur traite les déchets sans limite, le recyclage en réduit la quantité.`, target: find(tiles, (t) => t.type === 'LANDFILL'), tool: 'recycling' });

  // Environnement.
  if (pop > 1000 && s.pollution > 32) {
    const worst = [...districts].sort((p, q) => q.pollution - p.pollution)[0];
    out.push({ id: 'pollution', advisor: 'environment', severity: s.pollution > 50 ? 3 : 2, title: `Air pollué${worst ? ` ${aLieu(worst.name)}` : ''}`, text: 'Éloignez l’industrie des maisons, remplacez le charbon par l’éolien ou le solaire, plantez des parcs et votez l’ordonnance « Plantation d’arbres ».', target: worst ? { x: worst.fx, y: worst.fy } : undefined, view: 'pollution', tool: 'park' });
  }

  // Industrie et export.
  if (pop >= EXPORT_NEEDED_AT * 0.8 && s.exports.jobs > 0) {
    const exported = Math.min(s.exports.capacity, s.exports.connected);
    if (exported < s.exports.jobs * 0.9) {
      const lake = tiles.some((t) => t.type === 'LAKE');
      out.push({
        id: 'export',
        advisor: 'industry',
        severity: pop >= EXPORT_NEEDED_AT ? 2 : 1,
        title: 'Les usines ne peuvent pas exporter',
        text: `${fmt(exported)} emplois industriels sur ${fmt(s.exports.jobs)} exportent leur production. Construisez ${lake ? 'un port au bord de l’eau ou ' : ''}une gare de fret, reliée aux usines par la route. Sinon, au-delà de ${fmt(EXPORT_NEEDED_AT)} habitants, l’industrie stagne.`,
        target: find(tiles, (t) => t.type === 'I' && t.density > 0),
        tool: lake ? 'port' : 'freight',
      });
    }
  }

  // Urbanisme.
  if (s.unemployment > 12 && pop > 200) out.push({ id: 'jobs', advisor: 'urbanism', severity: 2, title: `${s.unemployment} % de chômage`, text: 'Les habitants manquent d’emplois : zonez du commerce et de l’industrie accessibles par la route.', tool: 'zoneC' });
  const emptyR = tiles.filter((t) => t.type === 'R' && t.density === 0).length;
  if (pop > 0 && emptyR < 4 && s.unemployment < 5) out.push({ id: 'zone-r', advisor: 'urbanism', severity: 1, title: 'Plus de place pour loger', text: 'Toutes les parcelles résidentielles sont construites : zonez de nouveaux quartiers.', tool: 'zoneR' });
  if (pop > 3000 && s.commute > 22) out.push({ id: 'commute', advisor: 'transport', severity: 1, title: `Trajets de ${s.commute} minutes en moyenne`, text: 'Les emplois sont trop loin des logements. Mélangez commerce et logements, et développez bus et métro.', view: 'traffic', tool: 'busstop' });

  // Saison : chasse-neige.
  if (seasonOf(ctx.month + 1) === 'winter' && policy.funding.transport < 80 && pop > 500) {
    out.push({ id: 'snow', advisor: 'transport', severity: 1, title: 'Préparez les chasse-neige', text: 'L’hiver approche. Avec un budget transports sous 80 %, la neige paralysera la ville.' });
  }

  // Finances.
  if (ctx.treasury < 0) out.push({ id: 'debt', advisor: 'finance', severity: 3, title: 'La ville est dans le rouge', text: 'Augmentez un peu les impôts, réduisez les budgets non essentiels ou fermez les équipements inutiles.' });
  else if (ctx.net < 0 && pop > 0) out.push({ id: 'deficit', advisor: 'finance', severity: 2, title: 'Budget en déficit', text: `La ville perd ${fmt(-ctx.net)} $ par mois. Les monuments et les événements rapportent du tourisme.` });
  const avgTax = (policy.taxes.R + policy.taxes.C + policy.taxes.I) / 3;
  if (avgTax > 12) out.push({ id: 'tax', advisor: 'finance', severity: 1, title: 'Impôts élevés', text: 'Au-delà de 12 %, la demande s’effondre et les habitants râlent.' });
  if (s.strikes.length) out.push({ id: 'strike', advisor: 'finance', severity: 3, title: 'Grève dans les services', text: 'Un service financé sous 40 % ne fonctionne plus. Remontez son budget dans le menu.' });

  // Radioactivité.
  const rad = find(tiles, (t) => t.rad > 0);
  if (rad) out.push({ id: 'rad', advisor: 'safety', severity: 2, title: 'Zone contaminée', text: 'Après l’accident nucléaire, la zone reste inhabitable plusieurs années. La radioactivité baisse d’un cran chaque année.', target: rad });

  // Culture.
  const venues = tiles.filter((t) => t.type === 'MARKET' || t.type === 'FAIR' || t.type === 'ARENA' || t.type === 'STADIUM').length;
  if (pop > 800 && venues === 0) out.push({ id: 'venues', advisor: 'culture', severity: 1, title: 'La ville s’ennuie', text: 'Un marché, une fête foraine, une salle de concert ou un stade accueillent des événements : satisfaction et tourisme en hausse.', tool: 'market' });

  // Bonne nouvelle quand tout va bien.
  if (!out.some((o) => o.severity >= 2) && pop > 0) {
    out.push({ id: 'ok', advisor: 'urbanism', severity: 0, title: 'Tout va bien, Monsieur ou Madame le Maire', text: `${fmt(pop)} habitants, ${s.happiness} % de satisfaits. Continuez à faire grandir la ville !` });
  }
  return out.sort((p, q) => q.severity - p.severity);
}
