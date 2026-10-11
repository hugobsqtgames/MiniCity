import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isBuildableGround, isRoadType } from '../engine/map';
import { TOOL_BY_ID } from '../sim/constants';
import { toolCost } from '../sim/tools';
import { dragTiles, useGameStore } from '../store/useGameStore';
import { Glass } from './Glass';
import { HUD_HEIGHT } from './Hud';
import { Text } from './Text';
import { formatMoney, theme } from './theme';

/** Pendant un glisser (zonage en rectangle, route droite) : dimensions et coût estimé. */
export function DragInfo() {
  const insets = useSafeAreaInsets();
  const drag = useGameStore((s) => s.drag);
  const tiles = useGameStore((s) => s.tiles);
  const size = useGameStore((s) => s.gridSize);
  const tool = useGameStore((s) => s.tool);
  const treasury = useGameStore((s) => s.treasury);

  const info = useMemo(() => {
    if (!drag) return null;
    const cells = dragTiles(drag).filter(([x, y]) => x >= 0 && y >= 0 && x < size && y < size);
    let cost = 0;
    let count = 0;
    for (const [x, y] of cells) {
      const t = tiles[y * size + x];
      if (drag.mode === 'rect' && tool !== 'bulldoze' && !isBuildableGround(t.type) && t.type !== 'FOREST') continue;
      if (drag.mode === 'line' && t.type === TOOL_BY_ID[tool].places) continue;
      if (drag.mode === 'line' && isRoadType(t.type) && t.type === 'HIGHWAY') continue;
      cost += toolCost(tiles, size, tool, x, y);
      count++;
    }
    const w = Math.abs(drag.bx - drag.ax) + 1;
    const h = Math.abs(drag.by - drag.ay) + 1;
    return { dims: drag.mode === 'rect' ? `${w} × ${h}` : `${cells.length} tuiles`, count, cost };
  }, [drag, tiles, size, tool]);

  if (!info) return null;
  const tooExpensive = info.cost > treasury;
  return (
    <View pointerEvents="none" style={[styles.wrap, { top: insets.top + HUD_HEIGHT + 14 }]}>
      <Glass intensity={45} style={styles.chip}>
        <Text style={styles.text}>
          {TOOL_BY_ID[tool].icon} {info.dims} · {info.count} à poser ·{' '}
          <Text style={[styles.text, { color: tooExpensive ? theme.negative : theme.positive }]}>{formatMoney(info.cost)}</Text>
        </Text>
      </Glass>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  chip: { borderRadius: 14, overflow: 'hidden', paddingHorizontal: 14, paddingVertical: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.glassBorder },
  text: { color: theme.text, fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'] },
});
