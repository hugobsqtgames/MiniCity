import { Canvas, createPicture, PaintStyle, Picture, Skia, type SkPaint } from '@shopify/react-native-skia';
import { useState } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';

import type { Weather } from '../sim/simulation';
import { keep, makeBin, RECYCLE_PICTURES } from '../engine/pictureBin';

const DROPS = 140;

function paint(color: string, alpha: number, stroke = 0): SkPaint {
  'worklet';
  const p = Skia.Paint();
  p.setAntiAlias(true);
  p.setColor(Skia.Color(color));
  p.setAlphaf(alpha);
  if (stroke > 0) {
    p.setStyle(PaintStyle.Stroke);
    p.setStrokeWidth(stroke);
  }
  return p;
}

/** Pseudo-aléatoire stable par particule (worklet). */
function rnd(i: number, k: number): number {
  'worklet';
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Météo à l'écran (indépendante de la caméra) : pluie, orage avec éclairs,
 * neige, brouillard, ombres de nuages, chaleur de la canicule.
 */
export function WeatherLayer({ weather, clock }: { weather: Weather; clock: SharedValue<number> }) {
  const { width, height } = useWindowDimensions();
  const [bin0] = useState(makeBin);
  const picture = useDerivedValue(() => {
    const t = clock.get() / 1000;
    return keep(bin0, createPicture(
      (canvas) => {
        if (weather === 'rain' || weather === 'storm') {
          const rain = Skia.PathBuilder.Make();
          const n = weather === 'storm' ? DROPS * 1.4 : DROPS;
          for (let i = 0; i < n; i++) {
            const speed = 700 + rnd(i, 1) * 300;
            const y = ((rnd(i, 2) * (height + 60) + t * speed) % (height + 60)) - 30;
            const x = (rnd(i, 3) * (width + 80) - t * speed * 0.18 + 2000 * width) % (width + 80);
            rain.moveTo(x, y);
            rain.lineTo(x - 4, y + 16);
          }
          canvas.drawPath(rain.detach(), paint('#cfe6ff', 0.55, 1.2));
          canvas.drawRect({ x: 0, y: 0, width, height }, paint('#1b2631', weather === 'storm' ? 0.22 : 0.12));
          // Éclair : un flash bref toutes les 7 secondes environ.
          if (weather === 'storm') {
            const f = t % 7;
            if (f < 0.12 || (f > 0.2 && f < 0.27)) canvas.drawRect({ x: 0, y: 0, width, height }, paint('#ffffff', 0.35));
          }
        } else if (weather === 'snow') {
          const flakes = Skia.PathBuilder.Make();
          for (let i = 0; i < DROPS; i++) {
            const speed = 40 + rnd(i, 1) * 50;
            const y = ((rnd(i, 2) * (height + 20) + t * speed) % (height + 20)) - 10;
            const x = (rnd(i, 3) * width + Math.sin(t * 0.8 + i) * 14 + width) % width;
            flakes.addCircle(x, y, 1.2 + rnd(i, 4) * 1.8);
          }
          canvas.drawPath(flakes.detach(), paint('#ffffff', 0.9));
        } else if (weather === 'fog') {
          canvas.drawRect({ x: 0, y: 0, width, height }, paint('#e5e8e8', 0.22));
          for (let i = 0; i < 6; i++) {
            const x = ((rnd(i, 5) * width + t * (8 + i * 3)) % (width + 400)) - 200;
            const y = rnd(i, 6) * height;
            canvas.drawOval({ x: x - 160, y: y - 50, width: 320, height: 100 }, paint('#f2f3f4', 0.18));
          }
        } else if (weather === 'cloudy') {
          // Ombres de nuages qui glissent sur la ville.
          for (let i = 0; i < 5; i++) {
            const x = ((rnd(i, 7) * width + t * (12 + i * 4)) % (width + 500)) - 250;
            const y = rnd(i, 8) * height;
            canvas.drawOval({ x: x - 150, y: y - 60, width: 300, height: 120 }, paint('#0b1622', 0.1));
          }
        } else if (weather === 'heat') {
          canvas.drawRect({ x: 0, y: 0, width, height }, paint('#ff9f43', 0.07 + Math.sin(t * 1.3) * 0.015));
        }
      },
      { x: 0, y: 0, width, height },
    ), RECYCLE_PICTURES);
  }, [weather, width, height]);
  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
      <Picture picture={picture} />
    </Canvas>
  );
}
