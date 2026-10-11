/** "+50 adjustment" / "−10 adjustment": an organizer's score adjustment as
 *  the team row and the profile panel show it. A plain module (no imports,
 *  no "use client"), so server and client components can both call it. */
export function adjustmentLabel(points: number): string {
  return `${points > 0 ? "+" : "−"}${Math.abs(points)} adjustment`;
}
