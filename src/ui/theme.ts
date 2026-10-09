import { MONTHS, START_YEAR } from '../sim/constants';

export const theme = {
  text: '#ffffff',
  textDim: 'rgba(255,255,255,0.65)',
  glassBorder: 'rgba(255,255,255,0.18)',
  glassFill: 'rgba(12,22,34,0.62)',
  positive: '#2ecc71',
  negative: '#e74c3c',
  r: '#2ecc71',
  c: '#3498db',
  i: '#f1c40f',
  radius: 22,
  gutter: 12,
} as const;

/** 15400 -> "15,400" (formatage maison : pas de dépendance à Intl). */
export function formatNumber(n: number): string {
  const s = Math.abs(Math.round(n)).toString();
  const grouped = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `-${grouped}` : grouped;
}

export function formatMoney(n: number): string {
  return n < 0 ? `-$${formatNumber(-n)}` : `$${formatNumber(n)}`;
}

export function formatDate(month: number): string {
  return `${MONTHS[month % 12]} ${START_YEAR + Math.floor(month / 12)}`;
}
