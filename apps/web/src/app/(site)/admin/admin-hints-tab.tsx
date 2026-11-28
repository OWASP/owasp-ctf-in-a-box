"use client";

// The Hints tab (admin-redesign.md PR 1: the Event/Hints/Admins split). The
// four hint-policy settings, lifted verbatim out of admin-event-tab.tsx onto
// their own destination — the policy is not any one module's:
// `hint-store.ts` reads the same four settings (`hintsEnabled`, `hintCost`,
// `hintsMinSolves`, `hintsUnlockAfterMin`) for secure-development targets,
// classic challenges alike, so a classic-only
// event needs them reachable somewhere that always exists (UX audit F1) —
// same reasoning that put them on Event before this split, just its own
// screen now rather than a section of a longer one.
//
// Presentational, like every other destination: state and mutations are
// owned by admin-controls.tsx and passed in.

import type { AdminSettings } from "@/lib/admin-store";
import { HINT_COST, HINT_DEFAULT_ENABLED, HINT_MIN_SOLVES, HINT_UNLOCK_AFTER_MIN } from "@/lib/hint-defaults";
import AdminNumberField, { type FieldStatus } from "@/components/admin-number-field";
import AdminSwitch from "@/components/admin-switch";
import type { CommitNumber } from "./types";

type AdminHintsTabProps = {
  settings: AdminSettings;
  pending: boolean;
  /** A write that belongs to one row, reported beside it (Saving… / Saved /
   *  the refusal) rather than on the panel-wide error line. */
  applyField: (key: string, patch: Record<string, unknown>, label: string) => Promise<boolean>;
  statusOf: (key: string) => FieldStatus;
  commitNumber: CommitNumber;
  hintCostInput: string;
  setHintCostInput: (v: string) => void;
  minSolvesInput: string;
  setMinSolvesInput: (v: string) => void;
  unlockAfterInput: string;
  setUnlockAfterInput: (v: string) => void;
  /** How many challenges contestants see on the Jeopardy board, as its panel
   *  reported it; undefined while not yet known or with Jeopardy off. */
  classicChallenges?: number;
};

/** The warning for a "solves required" no Jeopardy hint can ever meet, or
 *  null. The gate counts a player's solves across the whole board
 *  (hint-store.ts `countSolves`), and the challenge a player wants a hint for
 *  is one they haven't solved, so a hint can only be bought when the board has
 *  more challenges than the value. */
export function hintThresholdWarning(
  challenges: number | undefined,
  minSolves: number,
  enabled: boolean,
): string | null {
  if (!enabled || minSolves <= 0 || challenges === undefined || challenges === 0 || challenges > minSolves) {
    return null;
  }
  const board = `The Jeopardy board has ${challenges} ${challenges === 1 ? "challenge" : "challenges"}`;
  const need = `${minSolves} other ${minSolves === 1 ? "challenge" : "challenges"}`;
  const fix = challenges - 1 === 0 ? "0 (no gate)" : `${challenges - 1} or lower`;
  return `${board}, so with "solves required" at ${minSolves} nobody can buy a hint for a challenge they haven't solved yet: they must first solve ${need}. Set it to ${fix}, or add challenges.`;
}

export default function AdminHintsTab({
  settings,
  pending,
  applyField,
  statusOf,
  commitNumber,
  hintCostInput,
  setHintCostInput,
  minSolvesInput,
  setMinSolvesInput,
  unlockAfterInput,
  setUnlockAfterInput,
  classicChallenges,
}: AdminHintsTabProps) {
  const thresholdWarning = hintThresholdWarning(
    classicChallenges,
    settings.hintsMinSolves ?? HINT_MIN_SOLVES,
    settings.hintsEnabled ?? HINT_DEFAULT_ENABLED,
  );
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-white">Hints</h3>
        <p className="text-sm text-muted">
          Event-wide policy. Jeopardy sells its hints through these four settings,
          and holds its own hint text on its own tab. Quiz and Secure Development have no hints —
          nothing authors hint text for a secure-development target, so no challenge on
          &#8288;/challenges&#8288; offers one (issue #334).
        </p>
      </div>

      <AdminSwitch
        id="hints-enabled"
        label="Hints enabled"
        help={
          <>
            Hints are on unless you turn them off. Off hides the hint button and the leaderboard&rsquo;s hint-penalty
            column; points already spent stay recorded.
          </>
        }
        checked={settings.hintsEnabled ?? HINT_DEFAULT_ENABLED}
        disabled={pending}
        status={statusOf("hintsEnabled")}
        onChange={(next) => void applyField("hintsEnabled", { hintsEnabled: next }, "Hints enabled")}
      />

      <AdminNumberField
        id="hint-cost"
        label="Hint cost"
        help="Points deducted from the buyer when a hint is revealed."
        value={hintCostInput}
        placeholder={String(HINT_COST)}
        disabled={pending}
        status={statusOf("hintCost")}
        onChange={setHintCostInput}
        onBlur={() => commitNumber("hintCost", hintCostInput, setHintCostInput, "Hint cost")}
      />

      <AdminNumberField
        id="hints-min-solves"
        label="Hints: solves required"
        help="Solves needed on a target (or across the Jeopardy board) before its hints can be bought. Blocks throwaway accounts from farming hint text for a team. 0 disables the gate."
        value={minSolvesInput}
        placeholder={String(HINT_MIN_SOLVES)}
        disabled={pending}
        status={statusOf("hintsMinSolves")}
        onChange={setMinSolvesInput}
        onBlur={() => commitNumber("hintsMinSolves", minSolvesInput, setMinSolvesInput, "Hints: solves required")}
      />
      {thresholdWarning && (
        <p role="status" className="rounded-md border border-[#d4a017]/40 bg-[#d4a017]/10 px-3 py-2 text-sm text-[#f3d27a]">
          {thresholdWarning}
        </p>
      )}

      <AdminNumberField
        id="hints-unlock-after-min"
        label="Hints: unlock after (min)"
        help="Minutes after the scoring start before any hint can be bought. 0 = available immediately. Needs Scoring opens (on the Event tab) to be set to have any effect."
        value={unlockAfterInput}
        placeholder={String(HINT_UNLOCK_AFTER_MIN)}
        disabled={pending}
        status={statusOf("hintsUnlockAfterMin")}
        onChange={setUnlockAfterInput}
        onBlur={() =>
          commitNumber("hintsUnlockAfterMin", unlockAfterInput, setUnlockAfterInput, "Hints: unlock after (min)")
        }
      />
    </section>
  );
}
