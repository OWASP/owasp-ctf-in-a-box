// Whether a Jeopardy challenge is on the board for contestants right now.
// Pure and client-safe (no `server-only`, no store import): the board, the
// challenge page, the board-items API, the profile, the leaderboard's
// denominators and the admin status chip all ask this one function, so a
// hidden challenge cannot be absent from one surface and present on another.
//
// Hidden means "does not exist" on the contestant side. The grading and hint
// scripts make the same decision in Lua (CLASSIC_HIDDEN_LUA in
// classic-keys.ts) from the stored record, so a hand-made request cannot get
// past what the pages leave out.

/** The visibility fields a stored challenge carries. `enabled` absent means
 *  live: every record written before the field existed stays on the board. */
export type ReleaseFields = { enabled?: boolean };

/** What the admin list shows for a challenge. */
export type ChallengeStatus = { kind: "live" } | { kind: "disabled" };

/** The challenge's state at `nowMs` (epoch ms, the reader's clock). */
export function challengeStatus(c: ReleaseFields, nowMs: number): ChallengeStatus {
  void nowMs;
  return c.enabled === false ? { kind: "disabled" } : { kind: "live" };
}

/** Whether contestants may see the challenge at `nowMs`. */
export function isChallengeVisible(c: ReleaseFields, nowMs: number): boolean {
  return challengeStatus(c, nowMs).kind === "live";
}

/** The visible subset of `list`, order kept. */
export function visibleChallenges<T extends ReleaseFields>(list: readonly T[], nowMs: number): T[] {
  return list.filter((c) => isChallengeVisible(c, nowMs));
}

/** `visibleChallenges` on the reader's own clock: what a page read uses. The
 *  graders decide by Redis's clock instead (CLASSIC_HIDDEN_LUA). */
export function visibleNow<T extends ReleaseFields>(list: readonly T[]): T[] {
  return visibleChallenges(list, Date.now());
}
