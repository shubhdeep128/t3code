/**
 * The row that takes over once the selected row leaves the list, given the
 * list's order while it was still there: the next row that remains, else the
 * closest one above it. Triage keeps its place instead of jumping to the top.
 */
export function selectionAfterLeaving(
  orderBefore: ReadonlyArray<string>,
  leftKey: string,
  order: ReadonlyArray<string>,
): string | null {
  const remaining = new Set(order);
  const index = orderBefore.indexOf(leftKey);
  const below = orderBefore.slice(index + 1).find((key) => remaining.has(key));
  const above = orderBefore
    .slice(0, Math.max(index, 0))
    .reverse()
    .find((key) => remaining.has(key));
  return below ?? above ?? order[0] ?? null;
}
