/**
 * Which breadcrumb segments fold into the "…" menu so the rest fit in `room`.
 * Where you are (the last) always stays. Folders fold first, nearest the top
 * first, then the project, then the space; the menu itself takes `menu`. Any
 * room left over goes back to the folders nearest where you are.
 */
export function foldedSegments(widths: number[], room: number, menu: number): number[] {
  let used = widths.reduce((sum, width) => sum + width, 0);
  if (used <= room) return [];
  used += menu;
  const last = widths.length - 1;
  const order = [...widths.keys()].filter(i => i >= 2 && i < last).concat([1, 0].filter(i => i < last));
  const folded: number[] = [];
  for (const i of order) {
    if (used <= room) break;
    folded.push(i);
    used -= widths[i];
  }
  folded.sort((a, b) => a - b);
  while (used + widths[folded[folded.length - 1]] <= room) used += widths[folded.pop()!];
  return folded;
}
