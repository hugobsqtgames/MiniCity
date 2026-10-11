import type { ToolId } from './constants';

/** Glisser pour zoner un rectangle ou tracer une route droite. */
export type DragMode = 'rect' | 'line';
export type Drag = { ax: number; ay: number; bx: number; by: number; mode: DragMode };

/** Mode de glisser de chaque outil : rectangle pour les zones, ligne droite pour les routes. */
export function dragModeOf(tool: ToolId): DragMode | null {
  if (tool === 'zoneR' || tool === 'zoneC' || tool === 'zoneI' || tool === 'bulldoze') return 'rect';
  if (tool === 'road' || tool === 'avenue' || tool === 'highway') return 'line';
  return null;
}

/** Tuiles couvertes par un glisser (rectangle, ou segment droit sur l'axe dominant). */
export function dragTiles(d: Drag): [number, number][] {
  const out: [number, number][] = [];
  if (d.mode === 'rect') {
    const [x0, x1] = [Math.min(d.ax, d.bx), Math.max(d.ax, d.bx)];
    const [y0, y1] = [Math.min(d.ay, d.by), Math.max(d.ay, d.by)];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y]);
    return out;
  }
  if (Math.abs(d.bx - d.ax) >= Math.abs(d.by - d.ay)) {
    const step = d.bx >= d.ax ? 1 : -1;
    for (let x = d.ax; x !== d.bx + step; x += step) out.push([x, d.ay]);
  } else {
    const step = d.by >= d.ay ? 1 : -1;
    for (let y = d.ay; y !== d.by + step; y += step) out.push([d.ax, y]);
  }
  return out;
}

