// Types shared by the admin panel's tab shell (`admin-controls.tsx`) and the
// individual tab bodies (`admin-event-tab.tsx`, `admin-secure-dev-tab.tsx`,
// `components/admin-quiz-controls.tsx`). Type-only on purpose: it carries no
// runtime code, so importing it never drags either side of the tab split into
// the other's bundle.

import type { ReactNode } from "react";

/** A pending confirmation. The tab bodies only ever *request* one (via
 *  `setConfirm`); the shell owns the single `<ConfirmModal>` that renders it,
 *  so a confirmation never disappears just because its tab is hidden. */
export type ConfirmState = {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  requireType?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<unknown>;
};

/** Shared commit signature for every numeric settings knob. The shell owns the
 *  implementation (it needs `settings` + `apply`); tabs receive it as a prop
 *  rather than each re-deriving the same validate-then-POST plumbing. Keys are
 *  the union across all tabs — a function that accepts the whole union is
 *  assignable to a tab prop that only names its own subset. */
export type CommitNumber = (
  key:
    | "hintCost"
    | "hintsMinSolves"
    | "hintsUnlockAfterMin"
    | "quizMaxAttempts"
    | "quizRetryAfterMin"
    | "classicCooldownSec"
    | "aiCooldownSec"
    | "aiMaxAttempts"
    | "teamMaxMembers"
    | "scoreCooldownMin",
  raw: string,
  reset: (v: string) => void,
  /** The field's visible label — what a rejection is phrased through, so the
   *  organizer reads "Hint cost must be…", not "hintCost must be…". */
  label: string,
) => void;
