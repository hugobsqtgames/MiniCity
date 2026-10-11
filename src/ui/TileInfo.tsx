import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isLogistics, isMonument, isPlant, isRoadType, isVenue, isZone, tileIndex, type TileType } from '../engine/map';
import { JOBS_C, JOBS_I, LOGISTICS_CAPACITY, MONUMENT_TOURISM, MONUMENT_UNLOCK, PLANT_OUTPUT, RESIDENTS, ROAD_CAPACITY, UPKEEP, VENUE_TOURISM } from '../sim/constants';
import { districtAt } from '../sim/districts';
import { plantFactor, powerUse } from '../sim/power';
import { computeCoverage, computeRoadAccess, EVENT_COST, EVENT_LABELS, type CityEventKind } from '../sim/simulation';
import { useGameStore } from '../store/useGameStore';
import { Text } from './Text';
import { TOOLBAR_HEIGHT } from './Toolbar';
import { formatMoney, formatNumber, theme } from './theme';
import { Glass } from './Glass';

const NAMES: Record<TileType, string> = {
  GRASS: 'Herbe',
  DIRT: 'Terrain vague',
  LAKE: 'Lac / rivière',
  SAND: 'Plage',
  FOREST: 'Forêt',
  ROAD: 'Rue',
  AVENUE: 'Avenue',
  HIGHWAY: 'Autoroute',
  R: 'Zone résidentielle',
  C: 'Zone commerciale',
  I: 'Zone industrielle',
  POWER: 'Centrale à charbon',
  WIND: 'Éolienne',
  SOLAR: 'Centrale solaire',
  NUCLEAR: 'Centrale nucléaire',
  PORT: 'Port de commerce',
  FREIGHT: 'Gare de fret',
  MARKET: 'Marché',
  FAIR: 'Fête foraine',
  ARENA: 'Salle de concert',
  POLICE: 'Commissariat',
  FIRE: 'Caserne de pompiers',
  HOSPITAL: 'Hôpital',
  SCHOOL: 'École',
  WATER: "Château d'eau",
  METRO: 'Station de métro',
  PARK: 'Parc',
  LANDFILL: 'Décharge',
  INCINERATOR: 'Incinérateur',
  RECYCLING: 'Centre de recyclage',
  BUSSTOP: 'Arrêt de bus',
  STADIUM: 'Stade',
  UNIVERSITY: 'Université',
  AIRPORT: 'Aéroport',
  LANDMARK: 'Tour emblématique',
};
const LEVELS = ['Parcelle vide', 'Niveau 1', 'Niveau 2', 'Niveau 3'];
const SERVICE_TEXT: Partial<Record<TileType, string>> = {
  POLICE: 'Fait baisser la criminalité (rayon 10)',
  FIRE: 'Éteint les incendies (rayon 10)',
  HOSPITAL: 'Santé : + satisfaction, + valeur (rayon 12)',
  SCHOOL: 'Éducation : + satisfaction, + valeur (rayon 9)',
  WATER: "Alimente les canalisations (12 cases) s'il a du courant",
  METRO: 'Relie les stations : moins de voitures, + valeur (rayon 6)',
  PARK: 'Espaces verts : + valeur foncière (rayon 4)',
  LANDFILL: 'Stocke les ordures des quartiers (rayon 22), finit par se remplir',
  INCINERATOR: 'Brûle les déchets sans limite, mais pollue',
  RECYCLING: 'Réduit les déchets de 30 % sans polluer',
  BUSSTOP: 'Les bus y passent : − voitures, + mobilité (rayon 5)',
};
const MONUMENT_TEXT: Partial<Record<TileType, string>> = {
  STADIUM: 'Matchs le week-end : + satisfaction, + tourisme',
  UNIVERSITY: 'Éducation supérieure sur un grand rayon',
  AIRPORT: 'Attire touristes et entreprises (+ demande commerciale)',
  LANDMARK: 'Fierté de la ville : + valeur foncière alentour',
};
const VENUE_TEXT: Partial<Record<TileType, [string, CityEventKind]>> = {
  STADIUM: ['Matchs presque tous les mois : foule, tourisme, satisfaction', 'match'],
  ARENA: ['Concerts réguliers, la nuit la salle s’illumine', 'concert'],
  FAIR: ['Festival l’été, grande roue toute l’année', 'festival'],
  MARKET: ['Jour de marché fréquent, marché de Noël en décembre', 'market'],
};
const PLANT_TEXT: Partial<Record<TileType, string>> = {
  POWER: 'Pollue beaucoup, production stable',
  WIND: 'Propre ; tourne mieux l’hiver, moins l’été',
  SOLAR: 'Propre ; produit deux fois moins l’hiver',
  NUCLEAR: 'Énorme production sans pollution… sauf accident ☢️',
};
const TERRAIN_TEXT: Partial<Record<TileType, string>> = {
  GRASS: 'Terrain constructible',
  DIRT: 'Terrain constructible',
  SAND: 'Plage : constructible, très prisée',
  FOREST: '+ valeur foncière autour · défrichage automatique (+$5)',
  LAKE: 'Seul un pont (rue, avenue ou autoroute) peut y être construit',
};

/** Fiche de la tuile inspectée (outil Explorer). */
export function TileInfo() {
  const insets = useSafeAreaInsets();
  const selected = useGameStore((s) => s.selected);
  const tiles = useGameStore((s) => s.tiles);
  const size = useGameStore((s) => s.gridSize);
  const clear = useGameStore((s) => s.setTool);
  const funding = useGameStore((s) => s.funding);
  const maps = useGameStore((s) => s.maps);
  const month = useGameStore((s) => s.month);
  const forced = useGameStore((s) => s.forcedEvents);
  const cityEvents = useGameStore((s) => s.cityEvents);
  const organizeEvent = useGameStore((s) => s.organizeEvent);

  const info = useMemo(() => {
    if (!selected) return null;
    const idx = tileIndex(selected.x, selected.y, size);
    const t = tiles[idx];
    const lines: string[] = [];
    lines.push(`🏘️ Quartier : ${districtAt(size, t.x, t.y).name}`);
    if (t.fire > 0) lines.push(`🔥 EN FEU depuis ${t.fire} mois !`);
    if (t.flood > 0) lines.push(`🌊 Hors service encore ${t.flood} mois`);
    if (t.rad > 0) lines.push(`☢️ Contaminé (niveau ${t.rad}/9) : inhabitable, baisse d’un cran par an`);
    if (t.value < 0 && t.density === 0 && isZone(t.type)) lines.push('🏗️ Parcelle sinistrée : reconstruction en cours');
    if (isZone(t.type)) {
      const road = computeRoadAccess(tiles, size)[idx] === 1;
      const cov = computeCoverage(tiles, size, funding);
      lines.push(LEVELS[t.density]);
      lines.push(`${t.powered ? '⚡ Alimentée' : '⚠️ Pas de courant'} · ${t.water ? '💧 Eau courante' : '⚠️ Pas d’eau'}`);
      lines.push(road ? '🛣️ Accès routier' : '⚠️ Pas de route à moins de 3 cases');
      if (t.type === 'R') lines.push(`👨‍👩‍👧‍👦 ${formatNumber(RESIDENTS[t.density])} habitants`);
      if (t.type === 'C') lines.push(`💼 ${formatNumber(JOBS_C[t.density])} emplois`);
      if (t.type === 'I') lines.push(`🏭 ${formatNumber(JOBS_I[t.density])} emplois`);
      const services = [
        cov.POLICE[idx] > 0 && '🚓',
        cov.FIRE[idx] > 0 && '🚒',
        cov.HOSPITAL[idx] > 0 && '🏥',
        cov.SCHOOL[idx] > 0 && '🏫',
        cov.METRO[idx] > 0 && '🚇',
        cov.BUSSTOP[idx] > 0 && '🚏',
        (cov.LANDFILL[idx] > 0 || cov.INCINERATOR[idx] > 0) && '🗑️',
      ].filter(Boolean);
      lines.push(services.length ? `Services : ${services.join(' ')}` : 'Aucun service public à proximité');
      lines.push(`💎 Valeur foncière ${Math.max(0, t.value)}/100 · ⚡ ${Math.round(powerUse(t) * 10) / 10} MW`);
      if (maps) {
        const pol = Math.round(maps.pollution[idx] * 100);
        const cri = Math.round(maps.crime[idx] * 100);
        lines.push(`🏭 Pollution ${pol} % · 🚨 Criminalité ${cri} %`);
      }
      if (t.garbage >= 5) lines.push('🗑️ Les ordures s’entassent : il faut une décharge');
      if (!t.water && t.density >= 1) lines.push('💡 Il faut de l’eau pour dépasser le niveau 1');
    } else if (isPlant(t.type)) {
      const mw = Math.round(PLANT_OUTPUT[t.type] * plantFactor(t.type, month));
      lines.push(PLANT_TEXT[t.type]!);
      lines.push(t.flood > 0 ? '⚠️ En panne' : `⚡ Produit ${formatNumber(mw)} MW ce mois-ci (portée 15 cases)`);
      lines.push(`Entretien ${formatMoney(UPKEEP[t.type] ?? 0)}/mois`);
    } else if (isLogistics(t.type)) {
      lines.push(`Exporte la production de ${formatNumber(LOGISTICS_CAPACITY[t.type])} emplois industriels`);
      lines.push('Les usines doivent être reliées par la route');
      lines.push(t.powered ? '⚡ En service' : '⚠️ Hors service : pas de courant');
      lines.push(`Entretien ${formatMoney(UPKEEP[t.type] ?? 0)}/mois`);
    } else if (isVenue(t.type)) {
      const [text] = VENUE_TEXT[t.type]!;
      lines.push(text);
      const now = cityEvents.find((e) => e.x === t.x && e.y === t.y);
      if (now) lines.push(`${EVENT_LABELS[now.kind].icon} En ce moment : ${EVENT_LABELS[now.kind].label}`);
      lines.push(`Tourisme +${formatMoney(VENUE_TOURISM[t.type])}/mois, plus les événements`);
      lines.push(t.powered ? '⚡ En service' : '⚠️ Hors service : pas de courant');
    } else if (isRoadType(t.type)) {
      const load = maps ? Math.round(maps.traffic[idx] * 100) : 0;
      lines.push(`Capacité ${formatNumber(ROAD_CAPACITY[t.type])} trajets/mois · trafic ${load} %`);
      lines.push(load > 100 ? '🚦 Embouteillages !' : load > 70 ? '🚗 Trafic dense' : '🟢 Fluide');
      if (t.type === 'HIGHWAY') lines.push('Rapide, mais ne dessert pas les zones directement');
      if (t.lake) lines.push('🌉 Pont');
      lines.push(`Entretien ${formatMoney(UPKEEP[t.type] ?? 1)}/mois`);
    } else if (isMonument(t.type)) {
      lines.push(MONUMENT_TEXT[t.type]!);
      lines.push(`Débloqué à ${formatNumber(MONUMENT_UNLOCK[t.type])} habitants · tourisme +${formatMoney(MONUMENT_TOURISM[t.type])}/mois`);
      lines.push(t.powered ? '⚡ En service' : '⚠️ Hors service : pas de courant');
    } else if (TERRAIN_TEXT[t.type]) {
      lines.push(TERRAIN_TEXT[t.type]!);
    } else if (SERVICE_TEXT[t.type]) {
      lines.push(SERVICE_TEXT[t.type]!);
      if (t.type === 'LANDFILL') lines.push(`Remplissage ${Math.round((t.garbage / 9) * 100)} %${t.garbage >= 9 ? ' — PLEINE' : ''}`);
      if (t.type !== 'PARK' && t.type !== 'BUSSTOP') lines.push(t.powered ? '⚡ En service' : '⚠️ Hors service : pas de courant');
      lines.push(`Entretien ${formatMoney(UPKEEP[t.type] ?? 0)}/mois`);
    }
    const venue = isVenue(t.type) && t.powered ? VENUE_TEXT[t.type]![1] : null;
    return { title: NAMES[t.type], lines, x: t.x, y: t.y, venue, planned: forced.some((f) => f.x === t.x && f.y === t.y) };
  }, [selected, tiles, size, funding, maps, month, cityEvents, forced]);

  if (!info) return null;
  return (
    <Animated.View
      entering={FadeInDown.springify().damping(18)}
      exiting={FadeOutDown.duration(150)}
      style={[styles.wrap, { bottom: insets.bottom + TOOLBAR_HEIGHT + 16 }]}
    >
      <Glass intensity={45} style={styles.card}>
        <View style={styles.header}>
          <Text style={styles.title}>{info.title}</Text>
          <Text style={styles.coords}>
            ({info.x}, {info.y})
          </Text>
          <Pressable onPress={() => clear('inspect')} hitSlop={10}>
            <Text style={styles.close}>✕</Text>
          </Pressable>
        </View>
        {info.lines.map((l) => (
          <Text key={l} style={styles.line}>
            {l}
          </Text>
        ))}
        {info.venue && (
          <Pressable
            onPress={() => organizeEvent(info.x, info.y)}
            disabled={info.planned}
            style={({ pressed }) => [styles.cta, info.planned && { opacity: 0.6 }, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.ctaText}>
              {info.planned ? '✅ Événement programmé le mois prochain' : `${EVENT_LABELS[info.venue].icon} Organiser un événement (${formatMoney(EVENT_COST)})`}
            </Text>
          </Pressable>
        )}
      </Glass>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: theme.gutter, right: theme.gutter },
  card: {
    borderRadius: 18,
    overflow: 'hidden',
    padding: 14,
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.glassBorder,
  },
  header: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 4 },
  title: { color: theme.text, fontSize: 17, fontWeight: '800' },
  coords: { color: theme.textDim, fontSize: 13, flex: 1, fontVariant: ['tabular-nums'] },
  close: { color: theme.textDim, fontSize: 16, fontWeight: '700' },
  line: { color: theme.text, fontSize: 14 },
  cta: { alignSelf: 'flex-start', marginTop: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: 'rgba(142,68,173,0.9)' },
  ctaText: { color: theme.text, fontSize: 13, fontWeight: '800' },
});
