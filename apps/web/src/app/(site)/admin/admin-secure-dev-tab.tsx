"use client";

// The Secure Development module's admin tab: which of the six targets this
// event runs (issue #386, PR 2), and the re-run cooldown between scored runs
// on a PR — the two knobs that are this module's alone.
//
// The four hint knobs used to render here. They are not this module's: the
// same `hintsEnabled`/`hintCost`/`hintsMinSolves`/`hintsUnlockAfterMin`
// govern Classic's and AI's paid hints too (hint-store.ts), and this tab
// exists only while secure-development is enabled — so an event without it
// had no hint switch at all (UX audit F1). They live on the Event tab now.
// The stored keys and their server-side validation in `lib/admin-store.ts`
// are unchanged; a deployed event's settings keep their exact meaning.
//
// Presentational: the shell (`admin-controls.tsx`) owns `settings`, the
// draft input string, `apply`/`applyField`/`commitNumber` and the per-field
// save status; nothing here writes to Redis directly.

import type { AdminSettings } from "@/lib/admin-store";
import { DEFAULT_SECURE_DEV_TARGETS } from "@/lib/secure-dev-targets";
import { SCORE_COOLDOWN_MIN, SCORE_COOLDOWN_MIN_MAX } from "@/lib/scoring-defaults";
import AdminNumberField, { type FieldStatus } from "@/components/admin-number-field";
import AdminSettingsCard, { type ModuleSettingsSlot } from "@/components/admin/settings-card";
import AdminTargetList from "./admin-target-list";
import type { CommitNumber } from "./types";

type AdminSecureDevTabProps = {
  settings: AdminSettings;
  pending: boolean;
  apply: (patch: Record<string, unknown>) => Promise<boolean>;
  /** A write that belongs to one field — the target list — reported beside
   *  it rather than on the panel-wide error line (see admin-controls.tsx). */
  applyField: (key: string, patch: Record<string, unknown>, label: string) => Promise<boolean>;
  commitNumber: CommitNumber;
  /** The shell's per-field save status, by stored key (UX audit F2). */
  statusOf: (key: string) => FieldStatus;
  cooldownInput: string;
  setCooldownInput: (v: string) => void;
  /** The module screen's settings card slot (identity editor + Hints link);
   *  absent, the knob renders bare — see components/admin/settings-card.tsx. */
  moduleSettings?: ModuleSettingsSlot;
};

const COOLDOWN_LABEL = "Re-run cooldown (min)";

export default function AdminSecureDevTab({
  settings,
  pending,
  applyField,
  commitNumber,
  statusOf,
  cooldownInput,
  setCooldownInput,
  moduleSettings,
}: AdminSecureDevTabProps) {
  const targets = settings.secureDevTargets ?? DEFAULT_SECURE_DEV_TARGETS;
  const knob = (
    <>
      <AdminTargetList targets={targets} pending={pending} statusOf={statusOf} applyField={applyField} />
      <AdminNumberField
        id="score-cooldown-min"
        label={COOLDOWN_LABEL}
        help={
          <>
            Minimum minutes between SCORED runs on the same PR. Every run hands back a per-challenge pass/fail, so a
            short cooldown lets a contestant iterate a check-gaming patch against the rubric. 0 disables it. Takes
            effect on the next push — each fork&apos;s Action reads this value when it runs.
          </>
        }
        value={cooldownInput}
        placeholder={String(SCORE_COOLDOWN_MIN)}
        max={SCORE_COOLDOWN_MIN_MAX}
        disabled={pending}
        status={statusOf("scoreCooldownMin")}
        onChange={setCooldownInput}
        onBlur={() => commitNumber("scoreCooldownMin", cooldownInput, setCooldownInput, COOLDOWN_LABEL)}
      />
    </>
  );
  return moduleSettings ? (
    <AdminSettingsCard identity={moduleSettings.identity} onHints={moduleSettings.onHints}>
      {knob}
    </AdminSettingsCard>
  ) : (
    knob
  );
}
