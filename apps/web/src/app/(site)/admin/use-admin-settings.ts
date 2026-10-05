"use client";

// The admin shell's settings state machine: the stored settings, the nine
// numeric draft strings, the panel-wide `pending`/`error`, the single
// `confirm` request, the `resetInfo` line, the per-field status map, and the
// whole write path — `apply`, `applyField`, `commitNumber`, `statusOf` —
// plus the three Danger zone writes. `AdminControls` calls this once and
// threads the results to the tab bodies as props; the tabs stay
// presentational and this is still the shell's single writer of settings
// state across all of them.
//
// Every write goes through POST /api/admin/settings (auth + validation
// enforced server-side — see src/app/api/admin/settings/route.ts) via
// `postSettings` below; a failure lands either on the panel-wide `error`
// line (`apply`) or beside the field that owns the key (`applyField`).
//
// Composes `useAdminRestamp` (use-admin-restamp.ts): every successful write
// re-stamps the schedule readout, so what the Event tab shows as "right now"
// follows the save without waiting for a window boundary.

import { useCallback, useState } from "react";
import type { AdminSettings } from "@/lib/admin-store";
import { DEFAULT_EVENT_IDENTITY } from "@/lib/event-identity";
import { describeFieldError, parseNumberCommit, type FieldStatus } from "@/components/admin-number-field";
import type { CommitNumber, ConfirmState } from "./types";
import { createDangerActions } from "./admin-danger-actions";
import { useAdminRestamp } from "./use-admin-restamp";

async function postSettings(patch: Record<string, unknown>): Promise<{ settings?: AdminSettings; error?: string }> {
  const res = await fetch("/api/admin/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = (await res.json().catch(() => ({}))) as { settings?: AdminSettings; error?: string };
  if (!res.ok) return { error: data.error ?? "Request failed" };
  return { settings: data.settings };
}

/** After a settings write: the name the Event tab's master-reset
 *  confirmation should ask for. Unchanged unless the just-saved patch
 *  touched `eventName` — in which case this reads the STORED value back off
 *  the server's own response (never the raw patch value: a patch of
 *  `{ eventName: "" }` is stored as "restore the default", not literally
 *  ""), falling back to the spec default the same way `resolveSite` does.
 *  Pulled out as a pure function — like `parseNumberCommit`/
 *  `describeFieldError` elsewhere in this file's orbit — so
 *  admin-controls.test.tsx can pin the derivation directly: this repo has no
 *  jsdom/testing-library, so a live re-render of a stateful component can't
 *  be observed from a test (see that file's header comment), but this
 *  decision itself is pure and needs none. Re-exported from
 *  admin-controls.tsx, the module its callers import it from. */
export function nextEventNameAfterSave(
  key: string,
  current: string,
  saved: Pick<AdminSettings, "eventIdentity">,
): string {
  if (key !== "eventName") return current;
  return saved.eventIdentity.eventName ?? DEFAULT_EVENT_IDENTITY.eventName;
}

export function useAdminSettingsDrafts({
  initial,
  eventName,
}: {
  /** The settings as the server handed them down — the seed for the stored
   *  state and for every numeric draft string below. */
  initial: AdminSettings;
  /** The resolved runtime event name — resolved server-side by
   *  getSite(); a client bundle cannot read settings. Seeded into
   *  `currentEventName` and re-derived from each save's response — see the
   *  comment on that state below. */
  eventName: string;
}) {
  const [settings, setSettings] = useState(initial);
  const { settingsAt, restampNow } = useAdminRestamp(settings);
  // The name the Event tab's master-reset confirmation asks for. Seeded from
  // the server-resolved `eventName` prop, then re-derived (below, in
  // `applyField`) from the POST response whenever the saved patch renamed the
  // event — otherwise a rename left this stale at the pre-rename name, so a
  // reset typed against the NEW name (shown everywhere else on this very
  // panel) failed `getSite()`'s server-side check with "confirmation does not
  // match the event name".
  const [currentEventName, setCurrentEventName] = useState(eventName);
  const [hintCostInput, setHintCostInput] = useState(initial.hintCost === null ? "" : String(initial.hintCost));
  const [minSolvesInput, setMinSolvesInput] = useState(
    initial.hintsMinSolves === null ? "" : String(initial.hintsMinSolves),
  );
  const [unlockAfterInput, setUnlockAfterInput] = useState(
    initial.hintsUnlockAfterMin === null ? "" : String(initial.hintsUnlockAfterMin),
  );
  const [quizMaxAttemptsInput, setQuizMaxAttemptsInput] = useState(
    initial.quizMaxAttempts === null ? "" : String(initial.quizMaxAttempts),
  );
  const [quizRetryAfterInput, setQuizRetryAfterInput] = useState(
    initial.quizRetryAfterMin === null ? "" : String(initial.quizRetryAfterMin),
  );
  const [classicCooldownSecInput, setClassicCooldownSecInput] = useState(
    initial.classicCooldownSec === null ? "" : String(initial.classicCooldownSec),
  );
  const [aiCooldownSecInput, setAiCooldownSecInput] = useState(
    initial.aiCooldownSec === null ? "" : String(initial.aiCooldownSec),
  );
  const [cooldownInput, setCooldownInput] = useState(
    initial.scoreCooldownMin === null ? "" : String(initial.scoreCooldownMin),
  );
  const [teamMaxMembersInput, setTeamMaxMembersInput] = useState(
    initial.teamMaxMembers === null ? "" : String(initial.teamMaxMembers),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [resetInfo, setResetInfo] = useState<string | null>(null);

  // Per-field save status (UX audit F2). Keyed by the stored setting key —
  // the same key the patch carries — and read by the field that owns it, so
  // an organizer sees "Saving…", "Saved" or the reason for a refusal beside
  // the box they typed in, never only on a line under the whole panel.
  // "Saved" is transient: it clears itself after a moment unless a newer
  // status has replaced it.
  const [fieldStatus, setFieldStatus] = useState<Record<string, FieldStatus>>({});
  const setStatus = useCallback((key: string, status: FieldStatus) => {
    setFieldStatus((prev) => ({ ...prev, [key]: status }));
  }, []);
  const flashSaved = useCallback(
    (key: string) => {
      setStatus(key, { state: "saved" });
      setTimeout(() => {
        setFieldStatus((prev) => (prev[key]?.state === "saved" ? { ...prev, [key]: { state: "idle" } } : prev));
      }, 2500);
    },
    [setStatus],
  );

  const runConfirm = async () => {
    if (!confirm) return;
    setPending(true);
    try {
      await confirm.onConfirm();
    } finally {
      setPending(false);
      setConfirm(null);
    }
  };

  // The three Danger zone writes — seed/clear carry no DEMO_MODE gate
  // (ADR 58); each reports through `error`/`resetInfo` here rather than
  // beside a field. See admin-danger-actions.ts for the fetches themselves.
  const { doReset, doSeed, doClearDemo } = createDangerActions({
    setError,
    setResetInfo,
    setSettings,
    restampNow,
  });

  /** Re-seeds every numeric draft string from the settings the server just
   *  confirmed, so what the fields show is what is stored. */
  const syncInputs = (s: AdminSettings) => {
    setSettings(s);
    restampNow();
    setHintCostInput(s.hintCost === null ? "" : String(s.hintCost));
    setMinSolvesInput(s.hintsMinSolves === null ? "" : String(s.hintsMinSolves));
    setUnlockAfterInput(s.hintsUnlockAfterMin === null ? "" : String(s.hintsUnlockAfterMin));
    setQuizMaxAttemptsInput(s.quizMaxAttempts === null ? "" : String(s.quizMaxAttempts));
    setQuizRetryAfterInput(s.quizRetryAfterMin === null ? "" : String(s.quizRetryAfterMin));
    setClassicCooldownSecInput(s.classicCooldownSec === null ? "" : String(s.classicCooldownSec));
    setAiCooldownSecInput(s.aiCooldownSec === null ? "" : String(s.aiCooldownSec));
    setTeamMaxMembersInput(s.teamMaxMembers === null ? "" : String(s.teamMaxMembers));
    setCooldownInput(s.scoreCooldownMin === null ? "" : String(s.scoreCooldownMin));
  };

  /** Returns whether the patch was accepted, so a caller with its own local
   *  draft state (AdminModuleIdentity) can snap back on rejection instead of
   *  leaving rejected text sitting in the field. Every tab's `apply` prop
   *  type was widened to `Promise<boolean>` to match (a `Promise<T>` is not
   *  assignable to `Promise<void>` just because `T` goes unused — that's
   *  only true for a bare `void`-returning function type, not one nested
   *  inside a generic); callers that only need fire-and-forget keep calling
   *  it exactly the same way (`void apply(...)`), just ignoring the result.
   *
   *  This is the path for writes that have no field of their own to report
   *  into — the toggles, the module switches — so a failure lands on the
   *  panel-wide error line. A write that belongs to one field goes through
   *  `applyField` below, which reports beside that field instead. */
  const apply = async (patch: Record<string, unknown>): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      const result = await postSettings(patch);
      if (result.error) {
        setError(result.error);
        return false;
      }
      if (result.settings) syncInputs(result.settings);
      return true;
    } catch {
      // A network-level failure (fetch itself rejected) must not leave the
      // whole panel disabled behind a `pending` that never clears.
      setError("Couldn't reach the server — try again.");
      return false;
    } finally {
      setPending(false);
    }
  };

  /** A write that belongs to ONE field. Same POST as `apply`, but the outcome
   *  is reported into `fieldStatus[key]` — pending, then saved or rejected
   *  with the server's message rewritten through `label` — and never onto the
   *  panel-wide error line. Returns whether it was accepted, like `apply`, so
   *  a caller can snap its draft back. */
  const applyField = async (key: string, patch: Record<string, unknown>, label: string): Promise<boolean> => {
    setPending(true);
    setStatus(key, { state: "pending" });
    try {
      const result = await postSettings(patch);
      if (result.error) {
        setStatus(key, { state: "rejected", message: describeFieldError(label, result.error) });
        return false;
      }
      const saved = result.settings;
      if (saved) {
        syncInputs(saved);
        // The reset modal's confirmation phrase must follow a rename
        // immediately — the server's own name is the only source of truth
        // for it (`getSite()` on the reset route).
        setCurrentEventName((prev) => nextEventNameAfterSave(key, prev, saved));
      }
      flashSaved(key);
      return true;
    } catch {
      // Same as `apply`: a fetch that rejects outright must still release
      // `pending` and tell the field why nothing saved.
      setStatus(key, { state: "rejected", message: `${label} could not be saved: couldn't reach the server — try again.` });
      return false;
    } finally {
      setPending(false);
    }
  };

  /** Shared commit for the numeric knobs: a no-op when unchanged; junk, a
   *  fraction, a negative or a blanked field snaps back to the stored value
   *  WITH the reason shown beside the field; otherwise the value is posted
   *  through `applyField`, which re-validates server-side (admin-store) and
   *  snaps the draft back if that refuses. The decision itself is the pure
   *  `parseNumberCommit`, so it is tested without a DOM. */
  // Typed as the shared `CommitNumber` rather than repeating its key union
  // here. The inline copy had already drifted once by the time a seventh key
  // was added, and a mismatch shows up as a type error at the call site rather
  // than anywhere near the cause.
  const commitNumber: CommitNumber = (key, raw, reset, label) => {
    const current = settings[key];
    const decision = parseNumberCommit(raw, current);
    if (decision.kind === "noop") return;
    if (decision.kind === "snapback") {
      reset(current === null ? "" : String(current));
      setStatus(key, { state: "rejected", message: decision.message });
      return;
    }
    void applyField(key, { [key]: decision.value }, label).then((ok) => {
      if (!ok) reset(current === null ? "" : String(current));
    });
  };
  const statusOf = (key: string): FieldStatus => fieldStatus[key] ?? { state: "idle" };

  return {
    settings,
    settingsAt,
    currentEventName,
    pending,
    error,
    confirm,
    setConfirm,
    resetInfo,
    runConfirm,
    doReset,
    doSeed,
    doClearDemo,
    apply,
    applyField,
    commitNumber,
    statusOf,
    hintCostInput,
    setHintCostInput,
    minSolvesInput,
    setMinSolvesInput,
    unlockAfterInput,
    setUnlockAfterInput,
    quizMaxAttemptsInput,
    setQuizMaxAttemptsInput,
    quizRetryAfterInput,
    setQuizRetryAfterInput,
    classicCooldownSecInput,
    setClassicCooldownSecInput,
    aiCooldownSecInput,
    setAiCooldownSecInput,
    cooldownInput,
    setCooldownInput,
    teamMaxMembersInput,
    setTeamMaxMembersInput,
  };
}
