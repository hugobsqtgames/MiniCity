/// <reference types="node" />
/**
 * Garde-fou : le plugin des worklets transforme les fonctions 'worklet' en
 * constantes, qui capturent leurs dépendances à leur définition. Une fonction
 * worklet qui en appelle une autre définie PLUS BAS dans le même fichier fait
 * planter l'application au chargement (« Cannot access … before initialization »).
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === '__tests__' ? [] : files(p);
    return /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe('worklets', () => {
  it('aucune fonction worklet n’appelle une fonction déclarée plus bas dans son fichier', () => {
    const problems: string[] = [];
    for (const f of files(join(__dirname, '..'))) {
      const src = readFileSync(f, 'utf8');
      const decl = new Map<string, number>();
      for (const m of src.matchAll(/^(?:export )?function (\w+)\s*\(/gm)) decl.set(m[1], m.index!);
      for (const m of src.matchAll(/^(?:export )?function (\w+)\s*\([^{]*\{\s*'worklet'/gms)) {
        const start = m.index!;
        const next = [...decl.values()].filter((p) => p > start).sort((a, b) => a - b)[0] ?? src.length;
        const body = src.slice(start, next);
        for (const [other, pos] of decl) {
          if (other !== m[1] && pos > start && new RegExp(`\\b${other}\\s*\\(`).test(body)) problems.push(`${f} : ${m[1]} → ${other}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
