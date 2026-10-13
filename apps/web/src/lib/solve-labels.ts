/** "1 team" / "3 teams": the solve count as the board, the story lanes and
 *  the detail page all say it. Kept in a module with no "use client" marker
 *  and no imports: the board and story lanes render on the server and call
 *  it, and a function exported from a client module cannot be called there. */
export function teamsLabel(n: number): string {
  return `${n} team${n === 1 ? "" : "s"}`;
}
