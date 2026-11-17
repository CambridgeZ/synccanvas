import type { MaterializedElement } from './types';

export type LayerOrderAction = 'front' | 'back' | 'forward' | 'backward';

/**
 * Deterministic comparator for element stacking order:
 * Primary key: numeric `zIndex`
 * Tie-breaker: lexicographic `id` so concurrent equal zIndex assignments converge identically.
 */
export function compareElementOrder(
  a: Pick<MaterializedElement, 'id' | 'zIndex'>,
  b: Pick<MaterializedElement, 'id' | 'zIndex'>,
): number {
  if (a.zIndex !== b.zIndex) {
    return a.zIndex - b.zIndex;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Computes the next fractional zIndex for a newly created element (placed on top).
 */
export function computeNextTopZIndex(elements: ReadonlyArray<Pick<MaterializedElement, 'zIndex'>>): number {
  if (elements.length === 0) return 1;
  let maxZ = -Infinity;
  for (const el of elements) {
    if (el.zIndex > maxZ) maxZ = el.zIndex;
  }
  return Number.isFinite(maxZ) ? Math.floor(maxZ) + 1 : 1;
}

/**
 * Computes the target fractional zIndex to move `targetId` in the ordered visible stack.
 * Returns null if the element is already at the requested boundary or not found.
 */
export function computeLayerZIndex(
  visibleElements: ReadonlyArray<Pick<MaterializedElement, 'id' | 'zIndex'>>,
  targetId: string,
  action: LayerOrderAction,
): number | null {
  if (visibleElements.length <= 1) return null;
  const sorted = [...visibleElements].sort(compareElementOrder);
  const idx = sorted.findIndex((el) => el.id === targetId);
  if (idx === -1) return null;

  if (action === 'front') {
    if (idx === sorted.length - 1) return null;
    return sorted[sorted.length - 1].zIndex + 1;
  }

  if (action === 'back') {
    if (idx === 0) return null;
    return sorted[0].zIndex - 1;
  }

  if (action === 'forward') {
    if (idx === sorted.length - 1) return null;
    const above = sorted[idx + 1];
    const twoAbove = sorted[idx + 2];
    if (!twoAbove) {
      return above.zIndex + 1;
    }
    if (above.zIndex === twoAbove.zIndex) {
      return above.zIndex + 0.001;
    }
    return (above.zIndex + twoAbove.zIndex) / 2;
  }

  if (action === 'backward') {
    if (idx === 0) return null;
    const below = sorted[idx - 1];
    const twoBelow = sorted[idx - 2];
    if (!twoBelow) {
      return below.zIndex - 1;
    }
    if (below.zIndex === twoBelow.zIndex) {
      return below.zIndex - 0.001;
    }
    return (twoBelow.zIndex + below.zIndex) / 2;
  }

  return null;
}
