// One row shape for every level of the progress tree: a module, a target
// inside a module, or a module that has no targets of its own. Before this,
// the profile drew module cards in one grammar (bold sans label, bar inline
// right) and target cards in another (coloured mono label, hairline bar
// below), and the leaderboard drew a third with no points and no bar at all —
// so the same underlying numbers read as three unrelated screens.
//
// Presentational and client-safe: no state beyond the native <details>, no
// data reads. The profile renders it from a Server Component, the leaderboard
// from a Client one; nothing here may import server-only code.

import type { ReactNode } from "react";
import type { ModuleId } from "@/lib/modules";
import ProgressBar from "@/components/progress/progress-bar";

/** Each module's noun for one completed item. This is the UNIT — the word
 *  after the fraction ("5 / 38 patched"). Kept beside the row that renders it
 *  so a module cannot say "solved" on one surface and "flags" on another,
 *  which is exactly how the team card came to read "3 solved · 3 solved" for
 *  two different modules. */
export const MODULE_UNIT: Record<string, string> = {
  "secure-development": "patched",
  quiz: "answered",
  classic: "solved",
  ai: "cleared",
};

/** The team card's VERB slot ("6 patched", "3 flags") — the same vocabulary
 *  with one deliberate difference: classic's items are flags, and "3 flags"
 *  disambiguates a member summary that already carries a "solved" from
 *  another module. */
export const MODULE_VERB: Record<string, string> = {
  ...MODULE_UNIT,
  classic: "flags",
};

export function moduleUnit(id: ModuleId | string): string {
  return MODULE_UNIT[id] ?? "solved";
}

export function moduleVerb(id: ModuleId | string): string {
  return MODULE_VERB[id] ?? "solved";
}

type ProgressRowProps = {
  label: string;
  /** Target accent, where the level has one. Modules use the default white. */
  accent?: string;
  done: number;
  total: number;
  /** The module's own word for a completed item — see MODULE_UNIT. */
  unit: string;
  earned: number;
  /** Points available. Zero means "this source has no ceiling to divide by":
   *  the row then shows the earned figure alone rather than "8 / 0 pts", and
   *  shows nothing at all when there is no score either. */
  max: number;
  /** Points already spent on hints, shown after the points in the hint
   *  colour. Omitted on the leaderboard: another team's hint spend is theirs. */
  hints?: number;
  /** Qualifier for the points figure — "net" where the total shown is
   *  post-hint and the spend itself is not on screen. */
  totalLabel?: string;
  level?: "module" | "target";
  /** Present ⇒ the row becomes a keyboard-operable disclosure. */
  children?: ReactNode;
  defaultOpen?: boolean;
};

function Chevron() {
  return (
    <svg
      className="flex-none text-muted transition-transform group-open:rotate-90"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      aria-hidden="true"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function RowBody({ label, accent, done, total, unit, earned, max, hints, totalLabel, level }: ProgressRowProps) {
  // A team's quiz/classic/ai contribution arrives with points but no ceiling
  // (the board carries per-module totals, not per-module maxima), so "no max"
  // has to mean "show what they scored", not "show nothing".
  const showPoints = max > 0 || earned > 0;
  return (
    <div className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1.5">
      <span
        className={level === "target" ? "font-mono text-sm" : "text-sm font-semibold text-white"}
        style={level === "target" && accent ? { color: accent } : undefined}
      >
        {label}
      </span>

      <span className="whitespace-nowrap font-mono text-sm tabular-nums">
        <span className="text-[#22c55e]">{done}</span>
        <span className="text-muted">
          {" "}
          / {total} {unit}
        </span>
      </span>

      {showPoints && (
        <>
          {/* Below md the count and the points sit on one line, so they get a
              separator; from md the fixed points column already parts them.
              Two mono fractions with nothing between them is how the profile
              came to read "1 / 38 patched2 / 141 pts". */}
          <span className="text-zinc-600 md:hidden" aria-hidden="true">
            ·
          </span>
          <span className="whitespace-nowrap font-mono text-sm tabular-nums md:w-40 md:text-right">
            <span className="text-white">{earned.toLocaleString("en-US")}</span>
            <span className="text-muted">
              {max > 0 ? ` / ${max.toLocaleString("en-US")} pts` : " pts"}
            </span>
            {totalLabel && <span className="ml-1 text-muted">{totalLabel}</span>}
            {hints != null && hints > 0 && <span className="ml-2 text-[#d4a017]">−{hints} hints</span>}
          </span>
        </>
      )}

      {/* Below md the bar takes its own line under the text (basis-full);
          from md it shares the line and absorbs the slack. */}
      <ProgressBar
        label={label}
        done={done}
        total={total}
        unit={unit}
        earned={earned}
        max={max}
        className="basis-full md:min-w-24 md:flex-1 md:basis-0"
      />
    </div>
  );
}

export default function ProgressRow(props: ProgressRowProps) {
  const { children, defaultOpen } = props;
  if (!children) {
    return (
      <div className="py-1.5">
        <RowBody {...props} />
      </div>
    );
  }
  return (
    <details className="group" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017] [&::-webkit-details-marker]:hidden">
        <Chevron />
        <RowBody {...props} />
      </summary>
      <div className="mt-1 pl-5">{children}</div>
    </details>
  );
}
