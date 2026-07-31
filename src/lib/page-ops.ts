// Pure page-order arithmetic for thumbnail drag-reorder and deletion.

/**
 * Moves the view slots in `selected` (indices into `order`) so the block
 * lands where slot `insertAt` currently begins, preserving the selection's
 * internal order. `insertAt` may equal order.length (drop at the end).
 */
export function moveSlots(
  order: number[],
  selected: number[],
  insertAt: number,
): number[] {
  const sel = new Set(selected);
  const block = order.filter((_, i) => sel.has(i));
  const rest = order.filter((_, i) => !sel.has(i));
  // Where the insertion point lands once the selection is pulled out.
  let target = 0;
  for (let i = 0; i < insertAt; i++) {
    if (!sel.has(i)) target++;
  }
  return [...rest.slice(0, target), ...block, ...rest.slice(target)];
}

/** Removes the selected view slots; refuses to delete the last page. */
export function removeSlots(order: number[], selected: number[]): number[] {
  const sel = new Set(selected);
  const next = order.filter((_, i) => !sel.has(i));
  return next.length === 0 ? order : next;
}
