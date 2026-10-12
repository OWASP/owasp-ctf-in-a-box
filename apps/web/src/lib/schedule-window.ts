// The scheduled-window checks, in a dependency-free leaf.
//
// This is the app's copy of the pause/schedule contract's window logic —
// `outsideWindow` (generic: absent bound = open, used by the registration
// window) and `outsideScoringWindow` (a start is REQUIRED: no start = not
// launched, issue #464) —
// kept IDENTICAL in scorer/src/store.js and sync/src/redis.js; change all
// three together (AGENTS.md: "the pause/schedule contract lives in THREE
// readers"). It lives here rather than in admin-store.ts because admin-store
// is `server-only` and the /admin Event tab (a Client Component) needs the
// same function to render its "right now" readout — a client-side
// re-implementation would have been a FOURTH copy of the contract, which is
// the exact drift the three-reader rule exists to prevent. admin-store
// re-exports it, so its own callers and tests are unchanged.

/** True when a scheduled window puts `now` outside [startsAt, endsAt].
 *  Unparseable/absent bounds are ignored (treated as no bound) so a bad
 *  value can never wedge scoring off. */
export function outsideWindow(nowMs: number, startsAt: string | null, endsAt: string | null): boolean {
  const s = startsAt ? Date.parse(startsAt) : NaN;
  const e = endsAt ? Date.parse(endsAt) : NaN;
  if (Number.isFinite(s) && nowMs < s) return true;
  if (Number.isFinite(e) && nowMs > e) return true;
  return false;
}

/** The SCORING window: `outsideWindow` plus a REQUIRED start (issue #464 —
 *  every event needs an official launch). An absent or unparseable
 *  `scoringStartsAt` means "not launched", so scoring is closed; Launch in
 *  /admin writes it. Deliberately a separate function: the registration
 *  window keeps `outsideWindow`'s "absent bound = open" meaning. Kept
 *  IDENTICAL in scorer/src/store.js and sync/src/redis.js, pinned by
 *  test/fixtures/scoring-window-corpus.json. */
export function outsideScoringWindow(nowMs: number, startsAt: string | null, endsAt: string | null): boolean {
  const s = startsAt ? Date.parse(startsAt) : NaN;
  if (!Number.isFinite(s)) return true;
  return outsideWindow(nowMs, startsAt, endsAt);
}

/** WHY scoring is closed right now, or null while it is live (#567).
 *  `effectivePaused` (admin-store) folds the manual freeze and the schedule
 *  into one boolean — right for the scorer/sync readers, which only need
 *  "count or don't" — but the contestant-facing refusal has to tell a pause
 *  ("try again later") from the END of the event (final). A passed scheduled
 *  end wins over everything: a freeze toggled on after the close is still
 *  the end. Everything else that closes scoring — the manual freeze, a
 *  start still ahead, no start at all (#464) — reads as "paused", exactly
 *  what `outsideScoringWindow` and the freeze refuse on today. App-only: the
 *  scorer and sync keep their boolean. */
export function scoringClosure(
  nowMs: number,
  paused: boolean,
  startsAt: string | null,
  endsAt: string | null,
): "paused" | "ended" | null {
  if (scoringEnded(nowMs, endsAt)) return "ended";
  if (paused || outsideScoringWindow(nowMs, startsAt, endsAt)) return "paused";
  return null;
}

/** Whether the scheduled scoring END has passed — `outsideWindow`'s end
 *  bound on its own (`now > e`, unparseable/absent = no end). The hint gate
 *  (#566) asks this directly: a paid reveal closes with the freeze and the
 *  end, but NOT with "not launched", which the route's launch lock owns. */
export function scoringEnded(nowMs: number, endsAt: string | null): boolean {
  const e = endsAt ? Date.parse(endsAt) : NaN;
  return Number.isFinite(e) && nowMs > e;
}

/** Effective registration state: the manual toggle AND inside the
 *  registration window (absent bound = open). Here rather than only in
 *  admin-store (server-only, which re-exports it) so Server and Client
 *  Components alike share ONE copy of the rule. */
export function effectiveRegistrationOpen<
  S extends { teamRegistrationOpen: boolean; registrationStartsAt: string | null; registrationEndsAt: string | null },
>(s: S, nowMs: number = Date.now()): boolean {
  return s.teamRegistrationOpen && !outsideWindow(nowMs, s.registrationStartsAt, s.registrationEndsAt);
}

/** Whether the event has LAUNCHED (#464): the scoring start parses and has
 *  passed. Unlike `outsideScoringWindow`, a passed END does not un-launch —
 *  results stay browsable after scoring closes. App-only (the pre-launch
 *  page/API lock); the scorer and sync only care about scoring itself. */
export function isLaunched(nowMs: number, startsAt: string | null): boolean {
  const s = startsAt ? Date.parse(startsAt) : NaN;
  return Number.isFinite(s) && nowMs >= s;
}

/** The /admin Launch block's state (#464): not launched (no or an
 *  unparseable start), scheduled (a start still ahead), or live (the start has
 *  passed). Instants come back normalised to ISO-8601 UTC. */
export type LaunchState = { kind: "not-launched" } | { kind: "scheduled"; at: string } | { kind: "live"; since: string };

export function launchState(nowMs: number, startsAt: string | null): LaunchState {
  const s = startsAt ? Date.parse(startsAt) : NaN;
  if (!Number.isFinite(s)) return { kind: "not-launched" };
  const iso = new Date(s).toISOString();
  return nowMs < s ? { kind: "scheduled", at: iso } : { kind: "live", since: iso };
}

/** The next instant strictly after `nowMs` at which `outsideWindow` flips for
 *  any of `windows`, or null when no bound lies ahead. A start bound flips at
 *  the bound itself (`now < s` stops holding); an end bound flips one ms
 *  after it (`now > e` starts holding). Unparseable bounds are ignored, as
 *  outsideWindow ignores them. App-only: the /admin shell uses it to re-stamp
 *  the "Right now" readout when a window opens or closes while the page is
 *  open, so the clock read stays in a timer callback rather than in render. */
export function nextScheduleBoundary(
  nowMs: number,
  windows: ReadonlyArray<{ startsAt: string | null; endsAt: string | null }>,
): number | null {
  let next: number | null = null;
  const consider = (at: number) => {
    if (Number.isFinite(at) && at > nowMs && (next === null || at < next)) next = at;
  };
  for (const { startsAt, endsAt } of windows) {
    if (startsAt) consider(Date.parse(startsAt));
    if (endsAt) consider(Date.parse(endsAt) + 1);
  }
  return next;
}

/** The /admin readouts' "now" (#464): the client's stamp, floored at the last
 *  server instant it knows (the settings' `updatedAt`). A start is written on
 *  the SERVER's clock, so a client clock behind it would otherwise show a
 *  just-launched event as scheduled and its scoring as closed. */
export function serverFloorNow(nowMs: number, updatedAt: string | null | undefined): number {
  const floor = updatedAt ? Date.parse(updatedAt) : NaN;
  return Number.isFinite(floor) ? Math.max(nowMs, floor) : nowMs;
}

/** A readout stamp: `at` on the floored timeline the readouts use, and
 *  `client`, the client-clock instant it was taken at — the anchor elapsed
 *  time is measured from, so the two clocks are never subtracted. */
export type ReadoutStamp = { at: number; client: number };

/** When the /admin boundary timer should fire and what to stamp (#464). The
 *  delay is the distance to the next boundary on the floored timeline
 *  (`serverFloorNow`), less the client time elapsed since the stamp's own
 *  anchor. The new stamp IS the boundary, so a client clock behind the
 *  server can neither fall back under the floor and re-arm the same boundary
 *  nor add its skew to the next delay. Null when no bound lies ahead. */
export function restampPlan(
  stamp: ReadoutStamp,
  updatedAt: string | null | undefined,
  windows: readonly { startsAt: string | null | undefined; endsAt: string | null | undefined }[],
  clientNow: number,
): { delayMs: number; stampAt: number } | null {
  const base = serverFloorNow(stamp.at, updatedAt);
  const at = nextScheduleBoundary(base, windows.map((w) => ({ startsAt: w.startsAt ?? null, endsAt: w.endsAt ?? null })));
  if (at === null) return null;
  return { delayMs: Math.max(0, at - base - (clientNow - stamp.client)), stampAt: at };
}
