// The profile's per-module numbers, lifted out of the page so that file stays
// a data-fetching Server Component rather than a fetcher plus four modules'
// worth of arithmetic. Pure functions over what the page has already read —
// no store access of their own.
//
// Every list item is built FIELD BY FIELD from the public records, never a
// spread of a store row: a classic record's siblings include the flag, a quiz
// record's the answer key.

import type { AppId } from "@/lib/apps";
import type { AppProgress, ModuleProgress, UserProfile } from "@/lib/leaderboard/types";
import type { ModuleId, ResolvedModule } from "@/lib/modules";
import { moduleUnit } from "@/components/progress/progress-row";
import { atLeast, unionDenominators } from "@/lib/leaderboard/denominators";
import type { ProgressItem } from "@/components/progress/challenge-list";
import type { RemainingModule } from "@/components/progress/remaining-line";
import type { AiChallenge, AiTotal, ViewerAi } from "@/lib/ai-store";
import type { Challenge, ClassicTotal, ViewerClassic } from "@/lib/classic-store";
import type { Question, QuizTotal, ViewerQuiz } from "@/lib/quiz-store";

/** Everything the builders below read, gathered by the page. One module's
 *  slice is `undefined` exactly when that module is disabled. */
export type ProfileModuleInput = {
  profile: UserProfile | null;
  appsRecord: Partial<Record<AppId, AppProgress>>;
  /** The event's completable secure-development challenges — the LIVE target
   *  list's total (lib/enabled-apps.ts's `getEnabledTotals()`, issue #386, PR
   *  2), resolved through the same `challengeTotal` helper the public board
   *  uses, not a build-time constant. */
  challengeCount: number;
  /** The live target list's total catalogue points — `lib/enabled-apps.ts`'s
   *  `getEnabledTotals().maxPoints` (issue #386, PR 2), read once by the
   *  page and threaded in here so this module stays a pure function with no
   *  server-only import of its own. Viewer-independent, same as
   *  `challengeCount` above. */
  enabledMaxPoints: number;
  secureDev: boolean;
  quiz?: { total?: QuizTotal; questions: Question[]; maxPoints: number; viewer: ViewerQuiz };
  classic?: {
    total?: ClassicTotal;
    challenges: Challenge[];
    maxPoints: number;
    viewer: ViewerClassic;
    /** #463: story steps still locked for the viewer's team — left out of
     *  the list entirely, so nothing about them reaches the page. */
    locked?: ReadonlySet<string>;
  };
  ai?: { total?: AiTotal; challenges: AiChallenge[]; maxPoints: number; viewer: ViewerAi };
};

/** Each enabled module's contribution, keyed the way `withModuleContributions`
 *  keys `LeaderboardEntry.modules` — which is what drives the page's block loop
 *  off the enabled-module LIST rather than a per-module branch. A module with
 *  nothing to show contributes no entry and so renders no block, mirroring the
 *  leaderboard's own gate.
 *
 *  Every denominator is clamped to its own numerator, mirroring
 *  module-contributions.ts: a deleted item deliberately leaves banked points
 *  and the aggregate counter alone, so the list can shrink while the count
 *  does not, and "1 / 0 answered" is worse than an imprecise "1 / 1". */
/** The classic challenges this viewer may know about, and their points
 *  ceiling (#463): a story step still locked for the team is left out of
 *  BOTH — its title and points would otherwise leak through the list, the
 *  row's max, the "still winnable" line and the overall progress ceiling. */
export function visibleClassic(
  challenges: readonly Challenge[],
  locked: ReadonlySet<string>,
): { challenges: Challenge[]; maxPoints: number } {
  const shown = challenges.filter((c) => !locked.has(c.id));
  return { challenges: shown, maxPoints: shown.reduce((sum, c) => sum + (Number(c.points) || 0), 0) };
}

export function buildModuleProgress(input: ProfileModuleInput): Partial<Record<ModuleId, ModuleProgress>> {
  const { profile } = input;
  const blocks: Partial<Record<ModuleId, ModuleProgress>> = {};
  if (input.secureDev && Object.keys(input.appsRecord).length > 0) {
    blocks["secure-development"] = {
      // GROSS scorer points, same as the leaderboard's own module block — the
      // hint penalty nets the TOTAL exactly once (headline + the −spent tile),
      // never a module's block, matching the board's fold order.
      points: profile?.points ?? 0,
      completed: profile?.patched ?? 0,
      lastActivityAt: profile?.updatedAt ?? null,
      detail: { kind: "secure-development", apps: input.appsRecord },
    };
  }
  const quiz = input.quiz?.total;
  if (quiz && quiz.answered > 0) {
    blocks.quiz = {
      points: quiz.points,
      completed: quiz.answered,
      lastActivityAt: quiz.lastAt,
      detail: {
        kind: "quiz",
        answered: quiz.answered,
        total: Math.max(input.quiz!.questions.length, quiz.answered),
        points: quiz.points,
      },
    };
  }
  const classic = input.classic?.total;
  if (classic && classic.solved > 0) {
    blocks.classic = {
      points: classic.points,
      completed: classic.solved,
      lastActivityAt: classic.lastAt,
      detail: {
        kind: "classic",
        solved: classic.solved,
        total: Math.max(input.classic!.challenges.length, classic.solved),
        points: classic.points,
      },
    };
  }
  const ai = input.ai?.total;
  if (ai && ai.solved > 0) {
    blocks.ai = {
      points: ai.points,
      completed: ai.solved,
      lastActivityAt: ai.lastAt,
      detail: {
        kind: "ai",
        solved: ai.solved,
        total: Math.max(input.ai!.challenges.length, ai.solved),
        points: ai.points,
      },
    };
  }
  return blocks;
}

export type ModuleRow = { done: number; total: number; unit: string; earned: number; max: number };

/** One module's row numbers: its own unit word, its clamped done/total pair,
 *  and its earned/available points.
 *
 *  Exhaustive switch, closed with a `never` guard — this was once an
 *  if/if/unconditional-return, which silently rendered any new module's block
 *  with secure-development's numbers and no compiler complaint. */
// The denominator rule itself lives in `leaderboard/denominators.ts` — the
// leaderboard's team row needs the same rule, and while it lived HERE the two
// surfaces disagreed about the same contestant's same module (#348). Both are
// re-exported because this module's own tests and callers import them from
// here, and because what a module imports is part of its contract.
export { atLeast, unionDenominators } from "@/lib/leaderboard/denominators";

/** The ONE secure-development points ceiling, read by `moduleRow`'s own row,
 *  `remainingFor`'s footer line, and `maxPointsAcrossModules`'s header — all
 *  three used to compute this independently (two of them straight off
 *  `profile?.maxPoints`), so a profile whose `maxPoints` sat below the
 *  catalogue total showed the header at the catalogue ceiling while the row
 *  and the footer showed the lower, profile-derived number (issue #383
 *  follow-up). Viewer-independent (`input.enabledMaxPoints`, the same sum of
 *  the LIVE enabled targets' catalogue points the Challenges page shows —
 *  `getEnabledTotals().maxPoints`, read once by the page) rather than
 *  `profile?.maxPoints`, which is 0 until the scorer has ingested this
 *  login's first score; `atLeast(…, securePoints)` still floors it at
 *  whatever is banked, for a target removed from the event after points were
 *  scored on it. Contributes 0 when the module isn't live — the exact gate
 *  every caller already applied around this number, kept here so the three
 *  callers cannot drift onto three different gates either. */
function secureDevCeiling(input: ProfileModuleInput, securePoints: number): number {
  return input.secureDev ? atLeast(input.enabledMaxPoints, securePoints) : 0;
}

export function moduleRow(progress: ModuleProgress, input: ProfileModuleInput): ModuleRow {
  const detail = progress.detail;
  switch (detail.kind) {
    case "quiz": {
      const d = unionDenominators(input.quiz?.questions ?? [], input.quiz?.viewer.answered ?? {});
      return { done: detail.answered, total: d.total, unit: moduleUnit("quiz"), earned: progress.points, max: d.max };
    }
    case "classic": {
      const d = unionDenominators(input.classic?.challenges ?? [], input.classic?.viewer.solved ?? {});
      return { done: detail.solved, total: d.total, unit: moduleUnit("classic"), earned: progress.points, max: d.max };
    }
    case "ai": {
      const d = unionDenominators(input.ai?.challenges ?? [], input.ai?.viewer.solved ?? {});
      return { done: detail.solved, total: d.total, unit: moduleUnit("ai"), earned: progress.points, max: d.max };
    }
    case "secure-development":
      return {
        done: progress.completed,
        // Clamped like every other denominator here: a target removed from
        // the event shrinks the catalogue while the banked patch count stays,
        // and "8 / 0 patched" is the same nonsense this PR set out to end.
        total: atLeast(input.challengeCount, progress.completed),
        unit: moduleUnit("secure-development"),
        earned: progress.points,
        // The same ceiling the header (`maxPointsAcrossModules`) and the
        // footer (`remainingFor`) read — see `secureDevCeiling`.
        max: secureDevCeiling(input, progress.points),
      };
    default: {
      const unhandled: never = detail;
      return unhandled;
    }
  }
}

/** Per-item rows for a module's expanded list: which questions are answered,
 *  which flags are solved. Classic groups by the category an organizer
 *  authored (Web, Crypto…); quiz and ai have no grouping of their own and
 *  render one flat bucket. secure-development has its own per-target rows via
 *  AppBreakdown and returns nothing here. */
export function moduleItemsFor(id: ModuleId, input: ProfileModuleInput): { items: ProgressItem[]; doneWord: string } | null {
  if (id === "quiz" && input.quiz && input.quiz.questions.length > 0) {
    const { questions, viewer } = input.quiz;
    return {
      doneWord: "answered",
      items: questions.map((qn) => {
        const done = Boolean(viewer.answered[qn.id]);
        return {
          key: qn.id,
          name: qn.prompt,
          points: viewer.answered[qn.id]?.points ?? qn.points,
          done,
          status: done ? "Answered" : "Open",
          tone: done ? "done" : "open",
        };
      }),
    };
  }
  if (id === "classic" && input.classic && input.classic.challenges.length > 0) {
    const { challenges, viewer, locked } = input.classic;
    return {
      doneWord: "solved",
      items: challenges.filter((c) => !locked?.has(c.id)).map((c) => {
        const done = Boolean(viewer.solved[c.id]);
        return {
          key: c.id,
          name: c.title,
          points: viewer.solved[c.id]?.points ?? c.points,
          group: c.category,
          done,
          status: done ? "Solved" : "Open",
          tone: done ? "done" : "open",
        };
      }),
    };
  }
  if (id === "ai" && input.ai && input.ai.challenges.length > 0) {
    const { challenges, viewer } = input.ai;
    return {
      doneWord: "cleared",
      items: challenges.map((c) => {
        const done = Boolean(viewer.solved[c.id]);
        return {
          key: c.id,
          name: c.title,
          points: viewer.solved[c.id]?.points ?? c.points,
          done,
          status: done ? "Cleared" : "Open",
          tone: done ? "done" : "open",
        };
      }),
    };
  }
  return null;
}

/** What is still winnable, per ENABLED module rather than per module already
 *  played: the contestant who has not opened Classic yet is exactly the one
 *  who needs telling that most of the board's points are sitting in it.
 *
 *  Ceilings come from the SAME union each row above uses, not the live-only
 *  `maxPoints` — the footer sits directly under those rows, so a module
 *  reading "500 / 700 pts" in its row and contributing 500 here made the two
 *  halves of one page disagree (issue #343: #330 moved `moduleRow` and
 *  `maxPointsAcrossModules` onto the union and left this reader behind). */
export function remainingFor(modules: readonly ResolvedModule[], input: ProfileModuleInput): RemainingModule[] {
  const quiz = unionDenominators(input.quiz?.questions ?? [], input.quiz?.viewer.answered ?? {});
  const classic = unionDenominators(input.classic?.challenges ?? [], input.classic?.viewer.solved ?? {});
  const ai = unionDenominators(input.ai?.challenges ?? [], input.ai?.viewer.solved ?? {});
  const pairs: Partial<Record<ModuleId, { earned: number; max: number }>> = {
    // Clamped rather than unioned, for the reason `atLeast` gives: this
    // catalogue is baked from the rubrics, so it has no per-item identity to
    // union over — it can only lose a whole target from under banked points.
    // Ceiling from `secureDevCeiling` — the same one `moduleRow`'s row and
    // `maxPointsAcrossModules`'s header read, so this footer line can't drift
    // from either.
    "secure-development": input.secureDev
      ? {
          earned: input.profile?.points ?? 0,
          max: secureDevCeiling(input, input.profile?.points ?? 0),
        }
      : undefined,
    quiz: input.quiz ? { earned: input.quiz.total?.points ?? 0, max: quiz.max } : undefined,
    classic: input.classic ? { earned: input.classic.total?.points ?? 0, max: classic.max } : undefined,
    ai: input.ai ? { earned: input.ai.total?.points ?? 0, max: ai.max } : undefined,
  };
  return modules
    .map((m) => ({ title: m.title, ...pairs[m.id] }))
    .filter((m): m is RemainingModule => m.earned != null && m.max != null);
}

/** The all-module points ceiling, on the same union semantics as each row's —
 *  so the header's "N of M pts available" cannot disagree with the rows under
 *  it after a solved challenge is deleted (issue #330), NOR with
 *  secure-development's own row and the "still winnable" footer line (issue
 *  #383 and its follow-up): all three read the secure-development term
 *  through the same `secureDevCeiling`, so a profile whose `maxPoints` sits
 *  below the live catalogue total — or is 0 because the scorer has never
 *  ingested a score for this login — cannot make this header disagree with
 *  what `moduleRow` and `remainingFor` show underneath it. */
export function maxPointsAcrossModules(input: ProfileModuleInput, securePoints: number): number {
  const quiz = unionDenominators(input.quiz?.questions ?? [], input.quiz?.viewer.answered ?? {});
  const classic = unionDenominators(input.classic?.challenges ?? [], input.classic?.viewer.solved ?? {});
  const ai = unionDenominators(input.ai?.challenges ?? [], input.ai?.viewer.solved ?? {});
  return secureDevCeiling(input, securePoints) + quiz.max + classic.max + ai.max;
}
