import type { AppMeta } from "@/lib/apps";
import ProgressRow, { moduleUnit } from "@/components/progress/progress-row";
import ChallengeList, { type ProgressItem } from "@/components/progress/challenge-list";
import type { ChallengeCatalog, ChallengeCatalogEntry, ChallengeResult, LeaderboardEntry } from "@/lib/leaderboard/types";

/** Scorer semantics in the words a contestant reads. "missing" is the one
 *  that needs saying out loud: the test never ran, which is not the same
 *  claim as "the vulnerability is still there". */
const STATUS: Record<ChallengeResult["status"], { label: string; tone: ProgressItem["tone"]; done: boolean }> = {
  patched: { label: "Patched", tone: "done", done: true },
  open: { label: "Open", tone: "open", done: false },
  missing: { label: "Not attempted", tone: "unknown", done: false },
};

/** Field by field from the public catalogue record — the grouping key is the
 *  OWASP code the data already carries, which is what turns a 110-row target
 *  into ten readable groups. */
/** The join that used to happen on the server for every row (issue #434):
 *  catalogue (once per response) × this row's solved ids → the per-challenge
 *  list, at render time, for the one row that is open. An id the catalogue no
 *  longer holds is simply not a row. No catalogue → no list, and the target
 *  row still renders its counts. */
export function resolveChallenges(
  catalog: readonly ChallengeCatalogEntry[] | undefined,
  solvedIds: readonly string[] | undefined,
): ChallengeResult[] {
  if (!catalog || catalog.length === 0) return [];
  const solved = new Set(solvedIds ?? []);
  return catalog.map((c) => ({
    key: c.key,
    name: c.name,
    points: c.points,
    owasp: c.owasp,
    status: solved.has(c.key) ? "patched" : "open",
  }));
}

export function challengeItems(challenges: ChallengeResult[]): ProgressItem[] {
  return challenges.map((c) => ({
    key: c.key,
    name: c.name,
    points: c.points,
    group: c.owasp,
    done: STATUS[c.status].done,
    tone: STATUS[c.status].tone,
    status: STATUS[c.status].label,
  }));
}

/** The contestant's (or team's) per-target progress. Every target is one
 *  ProgressRow — the same row a module renders — opening into its grouped
 *  challenge list. It used to be two layouts side by side: a compact stats
 *  grid for targets with no catalogue and a wider card for the rest, so the
 *  same target changed shape depending on what the source knew about it.
 *
 *  `showPoints` is opt-in and defaults to unset: a caller that passes none
 *  gets the count and the bar, and no points column.
 *
 *  `enabledApps` is the event's LIVE target list (lib/enabled-apps.ts,
 *  resolved server-side and threaded down as a prop — this is a leaf/client
 *  component with no server-only import of its own), in catalogue order.
 *  Filtering it rather than the full six-app catalogue keeps a target an
 *  organizer has since switched off out of the breakdown even if a stale
 *  scored row still names it. */
export default function AppBreakdown({
  entry,
  showPoints,
  enabledApps,
  catalog,
}: {
  entry: LeaderboardEntry;
  showPoints?: boolean;
  enabledApps: readonly AppMeta[];
  /** `LeaderboardData.catalog` (or `UserProfile.catalog`). Absent → target
   *  rows render their counts with no per-challenge list. */
  catalog?: ChallengeCatalog;
}) {
  const attempted = enabledApps.filter((app) => entry.apps[app.id]);
  if (attempted.length === 0) {
    return <p className="text-sm text-muted">No app breakdown reported yet.</p>;
  }
  const unit = moduleUnit("secure-development");
  return (
    <div className="flex flex-col gap-1">
      {attempted.map((app) => {
        const progress = entry.apps[app.id]!;
        const items = challengeItems(resolveChallenges(catalog?.[app.id], progress.solvedIds));
        return (
          <ProgressRow
            key={app.id}
            label={app.name}
            accent={app.accent}
            level="target"
            done={progress.patched}
            total={progress.total}
            unit={unit}
            earned={showPoints ? progress.points : 0}
            // Sources without per-target point data (lambda with no
            // catalogue) report 0, and the row hides the pair rather than
            // rendering "0 / 0 pts".
            max={showPoints ? progress.maxPoints : 0}
          >
            {items.length > 0 ? <ChallengeList items={items} unit={unit} doneWord={unit} /> : undefined}
          </ProgressRow>
        );
      })}
    </div>
  );
}
