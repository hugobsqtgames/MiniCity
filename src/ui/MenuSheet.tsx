import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, TextInput, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideInRight, SlideOutDown, SlideOutRight } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  DEFAULT_MAP_SIZE,
  FUNDING_LABELS,
  MAP_SIZES,
  MAX_TAX,
  MIN_TAX,
  ORDINANCES,
  SPEEDS,
  STRIKE_BELOW,
  type FundingKey,
  type Taxes,
} from '../sim/constants';
import { Canvas, Picture } from '@shopify/react-native-skia';

import type { SlotActions } from '../hooks/usePersistence';
import { ADVISORS } from '../sim/advisors';
import { computeDistrictStats, districtMap } from '../sim/districts';
import { missionProgress, missionText } from '../sim/missions';
import type { CityRecords } from '../sim/records';
import { DISASTER_LABELS, EVENT_LABELS, type DisasterKind } from '../sim/simulation';
import { SPEC_NAMES } from '../engine/map';
import { previewType, type Quality, type SlotMeta } from '../store/persistence';
import { useGameStore, type MenuTab } from '../store/useGameStore';
import { buildThumbPicture } from './MapThumb';
import { Text } from './Text';
import { formatDate, formatMoney, formatNumber, theme } from './theme';
import { Glass } from './Glass';
import { HistoryChart } from './HistoryChart';

/** À partir de cette largeur (tablette, paysage), le menu devient un panneau latéral. */
export const WIDE_LAYOUT = 700;

const TABS: { id: MenuTab; label: string }[] = [
  { id: 'advisors', label: '💡 Conseillers' },
  { id: 'city', label: '🏙️ Ville' },
  { id: 'districts', label: '🏘️ Quartiers' },
  { id: 'budget', label: '💰 Budget' },
  { id: 'laws', label: '📜 Lois' },
  { id: 'events', label: '🎉 Événements' },
  { id: 'news', label: '📰 Journal' },
  { id: 'charts', label: '📈 Graphiques' },
  { id: 'records', label: '🏅 Records' },
  { id: 'settings', label: '⚙️ Réglages' },
];

function Row({ label, children, dim }: { label: string; children: ReactNode; dim?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, dim && { color: theme.negative }]} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.rowRight}>{children}</View>
    </View>
  );
}

function Btn({
  label,
  onPress,
  tone = 'default',
  selected,
  small,
}: {
  label: string;
  onPress: () => void;
  tone?: 'default' | 'primary' | 'danger';
  selected?: boolean;
  small?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.btn,
        small && styles.btnSmall,
        tone === 'primary' && styles.btnPrimary,
        tone === 'danger' && styles.btnDanger,
        selected && styles.btnSelected,
        pressed && { opacity: 0.7 },
      ]}
    >
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

/** Curseur à crans : − [barre] +. */
function Stepper({ value, min, max, onChange, step, color, suffix }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; color: string; suffix: string }) {
  return (
    <>
      <Btn small label="−" onPress={() => onChange(value - step)} />
      <View style={styles.track}>
        <View style={[styles.trackFill, { width: `${((value - min) / (max - min)) * 100}%`, backgroundColor: color }]} />
      </View>
      <Btn small label="+" onPress={() => onChange(value + step)} />
      <Text style={styles.stepValue}>
        {value}
        {suffix}
      </Text>
    </>
  );
}

/** Menu de la ville : statistiques, budget, ordonnances, journal, graphiques et réglages. */
export function MenuSheet({ onSaveNow, lastSavedAt, slots }: { onSaveNow: () => void; lastSavedAt: number | null; slots: SlotActions }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const wide = width >= WIDE_LAYOUT;
  const tab = useGameStore((s) => s.menuTab) ?? 'city';
  const setTab = useGameStore((s) => s.openMenu);
  const cityName = useGameStore((s) => s.cityName);
  const onClose = () => setTab(null);

  const body = (
    <Glass intensity={60} style={[styles.sheet, wide && styles.sheetWide]} tint="rgba(12,22,34,0.78)">
      {!wide && <View style={styles.grabber} />}
      <View style={styles.titleRow}>
        <Text style={styles.title} numberOfLines={1}>
          {cityName}
        </Text>
        <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Fermer le menu">
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs} style={styles.tabsWrap}>
        {TABS.map((t) => (
          <Pressable key={t.id} onPress={() => setTab(t.id)} style={[styles.tab, tab === t.id && styles.tabOn]}>
            <Text style={[styles.tabText, tab === t.id && styles.tabTextOn]}>{t.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <ScrollView
        style={wide ? { flex: 1 } : { maxHeight: height * 0.62 }}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {tab === 'advisors' && <AdvisorsTab />}
        {tab === 'city' && <CityTab />}
        {tab === 'districts' && <DistrictsTab />}
        {tab === 'events' && <EventsTab />}
        {tab === 'budget' && <BudgetTab />}
        {tab === 'laws' && <LawsTab />}
        {tab === 'news' && <NewsTab />}
        {tab === 'charts' && <ChartsTab />}
        {tab === 'records' && <RecordsTab />}
        {tab === 'settings' && <SettingsTab onClose={onClose} onSaveNow={onSaveNow} lastSavedAt={lastSavedAt} slots={slots} />}
      </ScrollView>
    </Glass>
  );

  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View entering={FadeIn} exiting={FadeOut} style={[StyleSheet.absoluteFill, styles.backdrop]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Fermer le menu" />
      </Animated.View>
      {wide ? (
        <Animated.View
          entering={SlideInRight.springify().damping(20)}
          exiting={SlideOutRight.duration(200)}
          style={[styles.sideWrap, { top: insets.top + 8, bottom: insets.bottom + 8, right: insets.right + 8 }]}
        >
          {body}
        </Animated.View>
      ) : (
        <Animated.View
          entering={SlideInDown.springify().damping(20)}
          exiting={SlideOutDown.duration(200)}
          style={[styles.sheetWrap, { paddingBottom: insets.bottom + 12 }]}
        >
          {body}
        </Animated.View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Onglets
// ---------------------------------------------------------------------------

function CityTab() {
  const st = useGameStore((s) => s.stats);
  const powerPct = st.zones ? Math.round((st.poweredZones / st.zones) * 100) : 0;
  const waterPct = st.zones ? Math.round((st.wateredZones / st.zones) * 100) : 0;
  return (
    <>
      <Text style={styles.section}>Citoyens</Text>
      <View style={styles.statsGrid}>
        <Stat label="Habitants" value={formatNumber(st.population)} />
        <Stat label="Emplois" value={formatNumber(st.jobsC + st.jobsI)} />
        <Stat label="Chômage" value={`${st.unemployment} %`} color={st.unemployment > 15 ? theme.negative : undefined} />
        <Stat label="Satisfaction" value={`${st.happiness} %`} color={st.happiness >= 60 ? theme.positive : st.happiness < 40 ? theme.negative : undefined} />
        <Stat label="Criminalité" value={`${st.crime} %`} color={st.crime > 35 ? theme.negative : undefined} />
        <Stat label="Pollution" value={`${st.pollution} %`} color={st.pollution > 40 ? theme.negative : undefined} />
      </View>

      <Text style={styles.section}>Déplacements</Text>
      <View style={styles.statsGrid}>
        <Stat label="Trajet moyen" value={`${st.commute} min`} color={st.commute > 30 ? theme.negative : undefined} />
        <Stat label="Bouchons" value={`${st.congestion} %`} color={st.congestion > 60 ? theme.negative : undefined} />
        <Stat label="Bus + métro" value={formatNumber(st.busRiders + st.metroRiders)} />
        <Stat label="Tram + train" value={formatNumber(st.tramRiders + st.trainRiders)} />
        <Stat label="Parkings" value={st.parkingShortage ? `${st.parkingShortage} manquent` : 'OK'} color={st.parkingShortage ? theme.negative : undefined} />
      </View>

      <Text style={styles.section}>Éducation, santé, tourisme</Text>
      <View style={styles.statsGrid}>
        <Stat label="Niveau d’études" value={`${st.educationLevel} %`} color={st.educationLevel < 35 ? theme.negative : st.educationLevel >= 70 ? theme.positive : undefined} />
        <Stat label="Épidémie" value={st.epidemic ? `${st.epidemic} %` : 'aucune'} color={st.epidemic ? theme.negative : theme.positive} />
        <Stat label="Eau des lacs" value={`${st.waterPollution} % polluée`} color={st.waterPollution > 30 ? theme.negative : undefined} />
        <Stat label="Touristes" value={formatNumber(st.tourists)} />
        <Stat label="À l’hôtel" value={st.tourists ? `${Math.round((st.hotelGuests / st.tourists) * 100)} %` : '—'} color={st.tourists && st.hotelGuests < st.tourists * 0.5 ? theme.negative : undefined} />
      </View>
      <Text style={styles.hint}>
        École 40 %, lycée 35 %, université 25 % : sans diplômés, pas de tours de bureaux ni d’industrie de pointe. Sans hôtel, les touristes ne restent que la journée et dépensent moitié moins.
      </Text>

      <Text style={styles.section}>Énergie et industrie</Text>
      <View style={styles.statsGrid}>
        <Stat label="Production" value={`${formatNumber(st.power.supply)} MW`} />
        <Stat label="Besoin" value={`${formatNumber(st.power.demand)} MW`} color={st.power.demand > st.power.served + 1 ? theme.negative : undefined} />
        <Stat
          label="Export"
          value={st.exports.jobs ? `${Math.round((Math.min(st.exports.capacity, st.exports.connected) / st.exports.jobs) * 100)} %` : '—'}
          color={st.exports.jobs && Math.min(st.exports.capacity, st.exports.connected) < st.exports.jobs * 0.9 ? theme.negative : undefined}
        />
      </View>
      {st.jobsI > 0 && (
        <View style={styles.statsGrid}>
          {SPEC_NAMES.map((n, k) => (
            <Stat key={n} label={['🏭', '🌾', '🪵', '💾'][k] + ' ' + n} value={formatNumber(st.specJobs[k])} />
          ))}
        </View>
      )}
      <Gauge icon="🔌" label="Charge du réseau" value={st.power.supply ? Math.min(100, Math.round((st.power.demand / st.power.supply) * 100)) : 0} color={st.power.demand > st.power.supply * 0.9 ? '#e74c3c' : '#f1c40f'} />

      <Text style={styles.section}>Services publics (bâtiments desservis)</Text>
      <Gauge icon="⚡" label="Électricité" value={powerPct} color="#f1c40f" />
      <Gauge icon="💧" label="Eau courante" value={waterPct} color="#5dade2" />
      <Gauge icon="🚓" label="Police" value={st.coverage.police} color="#3498db" />
      <Gauge icon="🚒" label="Pompiers" value={st.coverage.fire} color="#e74c3c" />
      <Gauge icon="🏥" label="Santé" value={st.coverage.health} color="#ecf0f1" />
      <Gauge icon="🏫" label="Éducation" value={st.coverage.education} color="#f39c12" />
      <Gauge icon="🚇" label="Métro" value={st.coverage.metro} color="#1abc9c" />
      <Gauge icon="🚏" label="Bus" value={st.coverage.bus} color="#f39c12" />
      <Gauge icon="🗑️" label="Collecte des déchets" value={st.coverage.waste} color="#8d6e63" />
      <Gauge icon="⛰️" label="Décharges remplies" value={st.landfill} color={st.landfill > 80 ? '#e74c3c' : '#a1887f'} />
      {st.fires > 0 && <Text style={styles.alert}>🔥 {st.fires} incendie(s) en cours</Text>}
      {st.strikes.length > 0 && <Text style={styles.alert}>✊ Grève : {st.strikes.map((k) => FUNDING_LABELS[k]).join(', ')}</Text>}
    </>
  );
}

function BudgetTab() {
  const taxes = useGameStore((s) => s.taxes);
  const funding = useGameStore((s) => s.funding);
  const setTax = useGameStore((s) => s.setTax);
  const setFunding = useGameStore((s) => s.setFunding);
  const income = useGameStore((s) => s.lastIncome);
  const expenses = useGameStore((s) => s.lastExpenses);
  const tourism = useGameStore((s) => s.stats.tourism);
  const zoneColor: Record<keyof Taxes, string> = { R: theme.r, C: theme.c, I: theme.i };
  const zoneName: Record<keyof Taxes, string> = { R: 'Résidentiel', C: 'Commerce', I: 'Industrie' };

  return (
    <>
      <Text style={styles.section}>Bilan du mois</Text>
      <View style={styles.statsGrid}>
        <Stat label="Recettes" value={`+${formatMoney(income)}`} color={theme.positive} />
        <Stat label="Dépenses" value={`-${formatMoney(expenses)}`} color={theme.negative} />
        <Stat label="Tourisme" value={formatMoney(tourism)} />
      </View>

      <Text style={styles.section}>Impôts par zone</Text>
      {(['R', 'C', 'I'] as const).map((z) => (
        <Row key={z} label={zoneName[z]}>
          <Stepper value={taxes[z]} min={MIN_TAX} max={MAX_TAX} step={1} onChange={(v) => setTax(z, v)} color={zoneColor[z]} suffix=" %" />
        </Row>
      ))}
      <Text style={styles.hint}>Au-delà de 12 %, la demande de la zone chute. En dessous de 5 %, elle s’envole.</Text>

      <Text style={styles.section}>Budget des services</Text>
      {(Object.keys(FUNDING_LABELS) as FundingKey[]).map((k) => (
        <Row key={k} label={FUNDING_LABELS[k]} dim={funding[k] < STRIKE_BELOW}>
          <Stepper
            value={funding[k]}
            min={0}
            max={120}
            step={10}
            onChange={(v) => setFunding(k, v)}
            color={funding[k] < STRIKE_BELOW ? theme.negative : funding[k] > 100 ? '#9b59b6' : theme.positive}
            suffix=" %"
          />
        </Row>
      ))}
      <Text style={styles.hint}>
        Sous {STRIKE_BELOW} %, le personnel se met en grève et le service s’arrête. À 120 %, la portée et l’efficacité augmentent.
      </Text>
    </>
  );
}

function LawsTab() {
  const ordinances = useGameStore((s) => s.ordinances);
  const toggle = useGameStore((s) => s.toggleOrdinance);
  const population = useGameStore((s) => s.stats.population);
  const disasters = useGameStore((s) => s.disasters);
  const setDisasters = useGameStore((s) => s.setDisasters);
  const trigger = useGameStore((s) => s.triggerDisaster);
  const pending = useGameStore((s) => s.pendingDisaster);
  const fun = useGameStore((s) => s.funDisasters);
  const setFun = useGameStore((s) => s.setFunDisasters);

  return (
    <>
      <Text style={styles.section}>Ordonnances municipales</Text>
      {ORDINANCES.map((o) => {
        const cost = Math.round((o.costPer100 * population) / 100);
        return (
          <View key={o.id} style={styles.law}>
            <Text style={styles.lawIcon}>{o.icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>{o.label}</Text>
              <Text style={styles.lawEffect}>
                {o.effect} · {cost >= 0 ? `${formatMoney(cost)}/mois` : `+${formatMoney(-cost)}/mois`}
              </Text>
            </View>
            <Switch value={ordinances[o.id]} onValueChange={() => toggle(o.id)} trackColor={{ true: theme.positive, false: 'rgba(255,255,255,0.2)' }} />
          </View>
        );
      })}

      <Text style={styles.section}>Catastrophes</Text>
      <View style={styles.law}>
        <Text style={styles.lawIcon}>🎲</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowLabel}>Catastrophes aléatoires</Text>
          <Text style={styles.lawEffect}>Séismes, inondations, tornades, pannes</Text>
        </View>
        <Switch value={disasters} onValueChange={setDisasters} trackColor={{ true: theme.negative, false: 'rgba(255,255,255,0.2)' }} />
      </View>
      <View style={styles.law}>
        <Text style={styles.lawIcon}>🦖</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowLabel}>Catastrophes fun</Text>
          <Text style={styles.lawEffect}>Météorites et monstre géant, de temps en temps</Text>
        </View>
        <Switch value={fun} onValueChange={setFun} trackColor={{ true: theme.negative, false: 'rgba(255,255,255,0.2)' }} />
      </View>
      <View style={styles.actions}>
        {(Object.keys(DISASTER_LABELS) as DisasterKind[]).map((k) => (
          <Btn key={k} label={`${DISASTER_LABELS[k].icon} ${DISASTER_LABELS[k].label}`} onPress={() => trigger(k)} selected={pending === k} />
        ))}
      </View>
      <Text style={styles.hint}>Déclencher une catastrophe la fait survenir au mois suivant.</Text>
    </>
  );
}

function NewsTab() {
  const news = useGameStore((s) => s.news);
  if (!news.length) return <Text style={styles.hint}>Rien à signaler pour l’instant. Le journal suit la vie de la ville mois après mois.</Text>;
  return (
    <>
      {news.map((n, i) => (
        <View key={`${n.month}-${i}`} style={styles.news}>
          <Text style={styles.newsIcon}>{n.icon}</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.newsDate}>{formatDate(n.month)}</Text>
            <Text style={styles.newsText}>{n.text}</Text>
          </View>
        </View>
      ))}
    </>
  );
}

function ChartsTab() {
  const h = useGameStore((s) => s.history);
  return (
    <>
      <HistoryChart label="👨‍👩‍👧‍👦 Population" data={h.pop} color={theme.r} />
      <HistoryChart label="💰 Trésorerie" data={h.money} color={theme.i} money />
      <HistoryChart label="😊 Satisfaction" data={h.happy} color="#5dade2" unit="%" />
      <HistoryChart label="🚨 Criminalité" data={h.crime} color={theme.negative} unit="%" />
      <HistoryChart label="🏭 Pollution" data={h.pollution} color="#a1887f" unit="%" />
    </>
  );
}

const QUALITIES: { id: Quality; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'high', label: 'Haute' },
  { id: 'medium', label: 'Moyenne' },
  { id: 'low', label: 'Basse' },
];

function SettingsTab({ onClose, onSaveNow, lastSavedAt, slots }: { onClose: () => void; onSaveNow: () => void; lastSavedAt: number | null; slots: SlotActions }) {
  const settings = useGameStore((s) => s.settings);
  const setSetting = useGameStore((s) => s.setSetting);
  const speed = useGameStore((s) => s.speed);
  const paused = useGameStore((s) => s.paused);
  const setSpeed = useGameStore((s) => s.setSpeed);
  const togglePause = useGameStore((s) => s.togglePause);
  const newCity = useGameStore((s) => s.newCity);
  const loadDemoCity = useGameStore((s) => s.loadDemoCity);
  const size = useGameStore((s) => s.gridSize);
  const cityName = useGameStore((s) => s.cityName);
  const setCityName = useGameStore((s) => s.setCityName);
  const askConfirm = useGameStore((s) => s.askConfirm);
  const [name, setName] = useState(cityName);
  const toggles: { key: 'music' | 'sounds' | 'ambience' | 'showAgents' | 'dayNight' | 'weather' | 'minimap'; label: string }[] = [
    { key: 'music', label: '🎵 Musique' },
    { key: 'sounds', label: '🔊 Effets sonores' },
    { key: 'ambience', label: '🐦 Ambiance (ville, oiseaux, pluie)' },
    { key: 'showAgents', label: '🚗 Trafic et piétons' },
    { key: 'dayNight', label: '🌙 Cycle jour / nuit' },
    { key: 'weather', label: '🌦️ Météo animée' },
    { key: 'minimap', label: '🗺️ Mini-carte' },
  ];

  return (
    <>
      <Text style={styles.section}>Ville</Text>
      <View style={styles.row}>
        <TextInput
          value={name}
          onChangeText={setName}
          onEndEditing={() => setCityName(name)}
          onBlur={() => setCityName(name)}
          maxLength={24}
          placeholder="Nom de la ville"
          placeholderTextColor={theme.textDim}
          style={styles.input}
          accessibilityLabel="Nom de la ville"
        />
      </View>

      <Text style={styles.section}>Simulation</Text>
      <Row label="Vitesse">
        <Btn label={paused ? '▶︎' : '❚❚'} onPress={togglePause} selected={paused} />
        {SPEEDS.map((sp) => (
          <Btn key={sp} label={`${sp}×`} onPress={() => setSpeed(sp)} selected={!paused && speed === sp} />
        ))}
      </Row>

      <Text style={styles.section}>Parties sauvegardées</Text>
      {slots.slots.map((meta, i) => (
        <SlotCard key={i} slot={i + 1} meta={meta} current={slots.current === i + 1} slots={slots} onClose={onClose} />
      ))}
      <View style={styles.actions}>
        <Btn label="💾 Sauvegarder" onPress={() => { onSaveNow(); slots.refresh(); }} />
        <Btn
          label="🏙️ Ville de démo"
          tone="primary"
          onPress={() =>
            askConfirm('Charger la ville de démo ?', `« ${cityName} » sera remplacée dans l’emplacement ${slots.current}. Copiez-la d’abord dans un emplacement libre pour la garder.`, 'Charger la démo', () => {
              loadDemoCity();
              onClose();
            })
          }
        />
      </View>
      <View style={styles.actions}>
        {MAP_SIZES.map((n) => (
          <Btn
            key={n}
            label={`🌱 Nouvelle ville ${n}×${n}`}
            tone="danger"
            onPress={() =>
              askConfirm(`Nouvelle ville ${n}×${n} ?`, `« ${cityName} » sera remplacée dans l’emplacement ${slots.current}. Cette action est définitive.`, 'Recommencer', () => {
                newCity(n);
                onClose();
              })
            }
          />
        ))}
      </View>
      <Text style={styles.hint}>« Nouvelle ville » remplace la partie de l’emplacement en cours.</Text>

      <Text style={styles.section}>Affichage et son</Text>
      {toggles.map((t) => (
        <Row key={t.key} label={t.label}>
          <Switch value={settings[t.key]} onValueChange={(v) => setSetting(t.key, v)} trackColor={{ true: theme.positive, false: 'rgba(255,255,255,0.2)' }} />
        </Row>
      ))}
      <Text style={styles.rowLabel}>✨ Qualité graphique</Text>
      <View style={styles.actions}>
        {QUALITIES.map((q) => (
          <Btn key={q.id} small label={q.label} onPress={() => setSetting('quality', q.id)} selected={settings.quality === q.id} />
        ))}
      </View>
      <Text style={styles.hint}>En mode Auto, le nombre de véhicules s’adapte pour garder une animation fluide.</Text>

      <Text style={styles.section}>Accessibilité</Text>
      <Text style={styles.rowLabel}>🔠 Taille du texte</Text>
      <View style={styles.actions}>
        {[
          { v: 1, l: 'Normale' },
          { v: 1.15, l: 'Grande' },
          { v: 1.3, l: 'Très grande' },
        ].map((o) => (
          <Btn key={o.v} small label={o.l} onPress={() => setSetting('textScale', o.v)} selected={settings.textScale === o.v} />
        ))}
      </View>
      <Row label="🎨 Couleurs pour daltoniens">
        <Switch value={settings.colorblind} onValueChange={(v) => setSetting('colorblind', v)} trackColor={{ true: theme.positive, false: 'rgba(255,255,255,0.2)' }} />
      </Row>
      <Row label="📳 Vibrations">
        <Switch value={settings.haptics} onValueChange={(v) => setSetting('haptics', v)} trackColor={{ true: theme.positive, false: 'rgba(255,255,255,0.2)' }} />
      </Row>
      <Text style={styles.hint}>La palette daltonienne (bleu → orange) s’applique aux vues de données et à leur légende.</Text>
      <Row label="🎓 Tutoriel">
        <Btn small label="Recommencer" onPress={() => { setSetting('tutorial', 0); onClose(); }} />
      </Row>
      <Text style={styles.foot}>
        Carte actuelle {size}×{size}
        {size !== DEFAULT_MAP_SIZE ? '' : ' (grande)'} · 100 % hors ligne · sauvegarde auto toutes les 15 s
        {lastSavedAt ? ` · dernière à ${new Date(lastSavedAt).toTimeString().slice(0, 8)}` : ''}
      </Text>
    </>
  );
}

/** Carte d'un emplacement de sauvegarde : aperçu de la ville, population, date. */
function SlotCard({ slot, meta, current, slots, onClose }: { slot: number; meta: SlotMeta | null; current: boolean; slots: SlotActions; onClose: () => void }) {
  const askConfirm = useGameStore((s) => s.askConfirm);
  const thumb = useMemo(() => {
    if (!meta) return null;
    const n = meta.previewSize;
    return buildThumbPicture(n, 96, (x, y) => previewType(meta.preview[y * n + x]));
  }, [meta]);
  return (
    <View style={[styles.slot, current && styles.slotCurrent]}>
      <View style={styles.slotThumb}>
        {thumb ? (
          <Canvas style={{ width: 96, height: 48 }}>
            <Picture picture={thumb} />
          </Canvas>
        ) : (
          <Text style={styles.slotEmpty}>vide</Text>
        )}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.rowLabel} numberOfLines={1}>
          {slot}. {meta ? meta.cityName : 'Emplacement libre'}
          {current ? '  ●' : ''}
        </Text>
        {meta && (
          <Text style={styles.slotSub} numberOfLines={1}>
            {formatNumber(meta.population)} hab. · {formatDate(meta.month)} · {formatMoney(meta.treasury)}
          </Text>
        )}
        <View style={styles.slotActions}>
          {!current && <Btn small label={meta ? '▶︎ Jouer' : '🌱 Commencer'} tone="primary" onPress={() => { slots.play(slot); onClose(); }} />}
          {!current && (
            <Btn
              small
              label="⤓ Copier ici"
              onPress={() =>
                meta
                  ? askConfirm('Écraser cette sauvegarde ?', `« ${meta.cityName} » (emplacement ${slot}) sera remplacée par la ville en cours.`, 'Écraser', () => slots.saveAs(slot))
                  : slots.saveAs(slot)
              }
            />
          )}
          {!current && meta && (
            <Btn
              small
              label="🗑"
              tone="danger"
              onPress={() => askConfirm('Supprimer cette sauvegarde ?', `« ${meta.cityName} » (emplacement ${slot}) sera effacée définitivement.`, 'Supprimer', () => slots.remove(slot))}
            />
          )}
          {current && <Text style={styles.slotSub}>Partie en cours</Text>}
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Conseillers, quartiers, événements
// ---------------------------------------------------------------------------

const SEVERITY_COLORS = ['#5dade2', '#f1c40f', '#e67e22', '#e74c3c'];

/** Demandes des habitants en cours : quartier, progression, échéance, récompense. */
function MissionsList() {
  const missions = useGameStore((s) => s.missions);
  const tiles = useGameStore((s) => s.tiles);
  const size = useGameStore((s) => s.gridSize);
  const analysis = useGameStore((s) => s.analysis);
  const month = useGameStore((s) => s.month);
  const focusOn = useGameStore((s) => s.focusOn);
  if (!missions.length || !analysis) return null;
  return (
    <>
      <Text style={styles.section}>🙋 Demandes des habitants</Text>
      {missions.map((m) => {
        const { icon, text } = missionText(m, size);
        const p = missionProgress(m, tiles, size, analysis);
        const d = districtMap(size).list[m.district];
        const left = m.deadline - month;
        return (
          <View key={m.id} style={[styles.advice, { borderLeftColor: left <= 3 ? theme.negative : '#f4d03f' }]}>
            <Text style={styles.adviceTitle}>
              {icon} {text}
            </Text>
            <Text style={styles.adviceText}>
              Actuellement {p.value} % (objectif {MISSION_GOAL_WORD(p.goal, p.value, p.done)}) · {left} mois restants · récompense {formatMoney(m.reward)}
            </Text>
            <View style={styles.actions}>
              <Btn small label="📍 Voir le quartier" onPress={() => focusOn(d.cx, d.cy)} />
            </View>
          </View>
        );
      })}
    </>
  );
}

const MISSION_GOAL_WORD = (goal: number, value: number, done: boolean) => (done ? 'atteint ✅' : value > goal ? `≤ ${goal} %` : `≥ ${goal} %`);

function AdvisorsTab() {
  const advice = useGameStore((s) => s.advice);
  const focusOn = useGameStore((s) => s.focusOn);
  const setTool = useGameStore((s) => s.setTool);
  const openMenu = useGameStore((s) => s.openMenu);
  if (!advice.length)
    return (
      <>
        <MissionsList />
        <Text style={styles.hint}>Vos conseillers n’ont rien à signaler pour l’instant.</Text>
      </>
    );
  return (
    <>
      <MissionsList />
      {advice.map((a) => {
        const who = ADVISORS[a.advisor];
        return (
          <View key={a.id} style={[styles.advice, { borderLeftColor: SEVERITY_COLORS[a.severity] }]}>
            <View style={styles.adviceHead}>
              <Text style={styles.adviceIcon}>{who.icon}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.adviceWho}>
                  {who.name} · {who.role}
                </Text>
                <Text style={styles.adviceTitle}>{a.title}</Text>
              </View>
            </View>
            <Text style={styles.adviceText}>{a.text}</Text>
            {(a.target || a.tool) && (
              <View style={styles.actions}>
                {a.target && <Btn small label="📍 Voir sur la carte" onPress={() => focusOn(a.target!.x, a.target!.y, a.view)} />}
                {a.tool && (
                  <Btn
                    small
                    label="🛠️ Prendre l’outil"
                    tone="primary"
                    onPress={() => {
                      setTool(a.tool!);
                      if (a.target) focusOn(a.target.x, a.target.y);
                      else openMenu(null);
                    }}
                  />
                )}
              </View>
            )}
          </View>
        );
      })}
    </>
  );
}

function DistrictsTab() {
  const tiles = useGameStore((s) => s.tiles);
  const size = useGameStore((s) => s.gridSize);
  const analysis = useGameStore((s) => s.analysis);
  const focusOn = useGameStore((s) => s.focusOn);
  const list = useMemo(() => (analysis ? computeDistrictStats(tiles, size, analysis.maps, analysis.cov) : []), [tiles, size, analysis]);
  if (!list.length) return <Text style={styles.hint}>Aucun quartier habité pour l’instant. Les quartiers apparaissent dès que l’on construit.</Text>;
  return (
    <>
      <Text style={styles.hint}>Touchez un quartier pour le voir sur la carte (vue Satisfaction).</Text>
      {list.map((d) => (
        <Pressable key={d.id} onPress={() => focusOn(d.fx, d.fy, 'happiness')} style={({ pressed }) => [styles.district, pressed && { opacity: 0.7 }]}>
          <View style={styles.districtHead}>
            <Text style={styles.rowLabel}>🏘️ {d.name}</Text>
            <Text style={styles.slotSub}>
              {formatNumber(d.population)} hab. · {formatNumber(d.jobs)} emplois
            </Text>
          </View>
          {d.happiness >= 0 ? (
            <Gauge icon="😊" label="Satisfaction" value={d.happiness} color={d.happiness >= 60 ? theme.positive : d.happiness >= 40 ? theme.i : theme.negative} />
          ) : (
            <Text style={styles.slotSub}>😊 Satisfaction : — (trop peu d’habitants)</Text>
          )}
          <Gauge icon="🚨" label="Criminalité" value={d.crime} color="#e74c3c" />
          <Gauge icon="🏭" label="Pollution" value={d.pollution} color="#a1887f" />
          <Gauge icon="💎" label="Valeur foncière" value={d.value} color="#5dade2" />
        </Pressable>
      ))}
    </>
  );
}

function EventsTab() {
  const cityEvents = useGameStore((s) => s.cityEvents);
  const counters = useGameStore((s) => s.counters);
  const tiles = useGameStore((s) => s.tiles);
  const focusOn = useGameStore((s) => s.focusOn);
  const venues = useMemo(() => {
    const c = { STADIUM: 0, ARENA: 0, FAIR: 0, MARKET: 0 } as Record<string, number>;
    for (const t of tiles) if (t.type in c) c[t.type]++;
    return c;
  }, [tiles]);
  return (
    <>
      <Text style={styles.section}>Ce mois-ci</Text>
      {cityEvents.length ? (
        cityEvents.map((e, i) => (
          <Pressable key={i} onPress={() => focusOn(e.x, e.y)} style={({ pressed }) => [styles.news, pressed && { opacity: 0.7 }]}>
            <Text style={styles.newsIcon}>{EVENT_LABELS[e.kind].icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.newsText}>{EVENT_LABELS[e.kind].label}</Text>
              <Text style={styles.newsDate}>
                +{e.bonus} % de satisfaction · +{formatMoney(e.tourism)} de tourisme · 📍 voir
              </Text>
            </View>
          </Pressable>
        ))
      ) : (
        <Text style={styles.hint}>Aucun événement ce mois-ci.</Text>
      )}

      <Text style={styles.section}>Calendrier</Text>
      <Text style={styles.calendar}>⚽ Matchs : presque chaque mois au stade ({venues.STADIUM})</Text>
      <Text style={styles.calendar}>🎸 Concerts : régulièrement dans les salles de concert ({venues.ARENA})</Text>
      <Text style={styles.calendar}>🎡 Festival d’été : juin à août à la fête foraine ({venues.FAIR})</Text>
      <Text style={styles.calendar}>🧺 Jour de marché, 🎄 marché de Noël en décembre ({venues.MARKET} marché(s))</Text>
      <Text style={styles.calendar}>🎆 Feu d’artifice du 14 juillet au-dessus du plus grand lieu</Text>
      <Text style={styles.hint}>Touchez un lieu sur la carte (outil Explorer) pour organiser un événement supplémentaire.</Text>

      <Text style={styles.section}>Bilan</Text>
      <View style={styles.statsGrid}>
        <Stat label="Événements" value={formatNumber(counters.events)} />
        <Stat label="Matchs" value={formatNumber(counters.match)} />
        <Stat label="Concerts" value={formatNumber(counters.concert)} />
      </View>
    </>
  );
}

/** Jauge horizontale de couverture d'un service. */
function Gauge({ icon, label, value, color }: { icon: string; label: string; value: number; color: string }) {
  return (
    <View style={styles.gauge}>
      <Text style={styles.gaugeLabel} numberOfLines={1}>
        {icon} {label}
      </Text>
      <View style={styles.gaugeTrack}>
        <View style={[styles.gaugeFill, { width: `${Math.max(0, Math.min(100, value))}%`, backgroundColor: color }]} />
      </View>
      <Text style={styles.gaugeValue}>{value}%</Text>
    </View>
  );
}

const RECORD_ROWS: { key: keyof CityRecords; icon: string; label: string; fmt: (v: number) => string }[] = [
  { key: 'population', icon: '👨‍👩‍👧‍👦', label: 'Population maximale', fmt: formatNumber },
  { key: 'treasury', icon: '💰', label: 'Caisse la plus pleine', fmt: formatMoney },
  { key: 'happiness', icon: '😊', label: 'Meilleure satisfaction', fmt: (v) => `${v} %` },
  { key: 'bestMonth', icon: '📈', label: 'Meilleur mois', fmt: (v) => `+${formatMoney(v)}` },
  { key: 'worstMonth', icon: '📉', label: 'Pire mois', fmt: (v) => formatMoney(v) },
  { key: 'surplusStreak', icon: '🔥', label: 'Série de mois excédentaires', fmt: (v) => `${v} mois` },
  { key: 'tourists', icon: '🧳', label: 'Touristes en un mois', fmt: formatNumber },
];

function RecordsTab() {
  const r = useGameStore((s) => s.records);
  const frames = useGameStore((s) => s.timelapse.length);
  const openTimelapse = useGameStore((s) => s.openTimelapse);
  return (
    <>
      <View style={styles.actions}>
        <Btn label={`🎞️ Timelapse de la ville (${frames} image${frames > 1 ? 's' : ''})`} tone="primary" onPress={() => openTimelapse(true)} />
      </View>
      <Text style={styles.hint}>Une image est prise tous les 6 mois : regardez votre ville grandir.</Text>
      <Text style={styles.section}>Records</Text>
      {RECORD_ROWS.map((row) => {
        const e = r[row.key] as { value: number; month: number };
        return (
          <Row key={row.key} label={`${row.icon} ${row.label}`}>
            <Text style={styles.recordValue}>{e.value || e.month ? row.fmt(e.value) : '—'}</Text>
            {e.value || e.month ? <Text style={styles.slotSub}>{formatDate(e.month)}</Text> : null}
          </Row>
        );
      })}
      <Row label={`💥 Pire catastrophe`}>
        <Text style={styles.recordValue}>{r.disaster.value ? `${r.disaster.value} tuiles` : '—'}</Text>
        {r.disaster.value ? <Text style={styles.slotSub}>{(DISASTER_LABELS[r.disaster.kind as DisasterKind]?.label ?? '') + ' · ' + formatDate(r.disaster.month)}</Text> : null}
      </Row>
      <Text style={styles.section}>Depuis la fondation</Text>
      <View style={styles.statsGrid}>
        <Stat label="Recettes cumulées" value={formatMoney(r.totalIncome)} />
        <Stat label="Événements" value={formatNumber(r.totalEvents)} />
        <Stat label="Incendies" value={formatNumber(r.totalFires)} />
        <Stat label="Catastrophes" value={formatNumber(r.totalDisasters)} />
      </View>
    </>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, color ? { color } : null]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: 'rgba(0,0,0,0.45)' },
  sheetWrap: { position: 'absolute', left: 8, right: 8, bottom: 0, maxWidth: 640, alignSelf: 'center', width: '100%' },
  sideWrap: { position: 'absolute', width: 420 },
  sheet: {
    borderRadius: 28,
    overflow: 'hidden',
    padding: 18,
    paddingTop: 10,
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.glassBorder,
  },
  sheetWide: { flex: 1, paddingTop: 16 },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.3)', marginBottom: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: theme.text, fontSize: 24, fontWeight: '800' },
  close: { color: theme.textDim, fontSize: 18, fontWeight: '700' },
  tabsWrap: { flexGrow: 0 },
  tabs: { gap: 6 },
  tab: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.08)' },
  tabOn: { backgroundColor: 'rgba(255,255,255,0.9)' },
  tabText: { color: theme.text, fontSize: 13, fontWeight: '700' },
  tabTextOn: { color: '#0b1622' },
  section: { color: theme.textDim, fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1, marginTop: 6 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 36 },
  rowLabel: { color: theme.text, fontSize: 14, fontWeight: '700', flexShrink: 1 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  btn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.12)' },
  btnSmall: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10 },
  btnPrimary: { backgroundColor: 'rgba(52,152,219,0.85)' },
  btnDanger: { backgroundColor: 'rgba(231,76,60,0.8)' },
  btnSelected: { backgroundColor: 'rgba(46,204,113,0.85)' },
  btnText: { color: theme.text, fontSize: 14, fontWeight: '800' },
  track: { width: 70, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden' },
  trackFill: { height: '100%' },
  stepValue: { color: theme.text, fontSize: 13, fontWeight: '800', width: 44, textAlign: 'right', fontVariant: ['tabular-nums'] },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stat: { width: '31.5%', padding: 10, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.08)' },
  statLabel: { color: theme.textDim, fontSize: 11, fontWeight: '700' },
  statValue: { color: theme.text, fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  content: { gap: 10, paddingBottom: 8 },
  alert: { color: '#f5b041', fontSize: 14, fontWeight: '800' },
  hint: { color: theme.textDim, fontSize: 12, lineHeight: 17 },
  gauge: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  gaugeLabel: { color: theme.text, fontSize: 13, fontWeight: '700', flexShrink: 1, minWidth: 120, maxWidth: 190 },
  gaugeTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden' },
  gaugeFill: { height: '100%', borderRadius: 4 },
  gaugeValue: { color: theme.textDim, fontSize: 12, fontWeight: '700', width: 38, textAlign: 'right', fontVariant: ['tabular-nums'] },
  law: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  lawIcon: { fontSize: 22, width: 30, textAlign: 'center' },
  lawEffect: { color: theme.textDim, fontSize: 12 },
  news: { flexDirection: 'row', gap: 10, padding: 10, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.06)' },
  newsIcon: { fontSize: 20 },
  newsDate: { color: theme.textDim, fontSize: 11, fontWeight: '700' },
  newsText: { color: theme.text, fontSize: 14, lineHeight: 19 },
  foot: { color: theme.textDim, fontSize: 11, marginTop: 4 },
  input: { flex: 1, color: theme.text, fontSize: 16, fontWeight: '700', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.1)' },
  slot: { flexDirection: 'row', gap: 10, padding: 10, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center' },
  slotCurrent: { borderWidth: 1, borderColor: theme.positive },
  slotThumb: { width: 96, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.25)' },
  slotEmpty: { color: theme.textDim, fontSize: 12 },
  slotSub: { color: theme.textDim, fontSize: 12 },
  recordValue: { color: theme.text, fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'] },
  slotActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  advice: { padding: 12, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.06)', borderLeftWidth: 4, gap: 6 },
  adviceHead: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  adviceIcon: { fontSize: 26 },
  adviceWho: { color: theme.textDim, fontSize: 11, fontWeight: '700' },
  adviceTitle: { color: theme.text, fontSize: 15, fontWeight: '800' },
  adviceText: { color: theme.text, fontSize: 13, lineHeight: 18, opacity: 0.92 },
  district: { padding: 12, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.06)', gap: 6 },
  districtHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  calendar: { color: theme.text, fontSize: 13, lineHeight: 19 },
});
