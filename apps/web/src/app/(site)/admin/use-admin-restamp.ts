"use client";

// The Event tab's schedule readout clock: the "now" the readout is
// evaluated at (epoch ms). Stamped at mount, re-stamped by `restampNow` in
// the settings write path (every successful save re-evaluates the readout),
// and — below — by a timer at the next instant a scoring/registration
// window opens or closes, so an organizer parked on the tab across a
// boundary sees the flip without touching anything. Never read from the
// clock in render: that is the impure read the compiler lint rejects.
//
// Lives one level below the shell: `useAdminSettingsDrafts`
// (use-admin-settings.ts) composes it, because its writes are what call
// `restampNow` — the shell itself only reads `settingsAt`.

import { useEffect, useState } from "react";
import type { AdminSettings } from "@/lib/admin-store";
import { restampPlan, type ReadoutStamp } from "@/lib/schedule-window";

export function useAdminRestamp(settings: AdminSettings): {
  /** Epoch ms the schedule readouts render at — the same floored "now"
   *  `phaseFromSettings` and the Launch block are given. */
  settingsAt: number;
  /** Re-stamp immediately: the settings just changed, so the readout must
   *  reflect them rather than the stamp taken at mount or last boundary. */
  restampNow: () => void;
} {
  const [stamp, setStamp] = useState<ReadoutStamp>(() => {
    const now = Date.now();
    return { at: now, client: now };
  });
  const settingsAt = stamp.at;
  const restampNow = () => {
    const now = Date.now();
    setStamp({ at: now, client: now });
  };
  useEffect(() => {
    // The same floored "now" the readouts use (serverFloorNow), so a client
    // clock behind the server re-stamps at the boundary the READOUT crosses.
    const plan = restampPlan(
      stamp,
      settings.updatedAt,
      [
        { startsAt: settings.scoringStartsAt, endsAt: settings.scoringEndsAt },
        { startsAt: settings.registrationStartsAt, endsAt: settings.registrationEndsAt },
      ],
      Date.now(),
    );
    if (plan === null) return;
    // setState in a timer callback, not in the effect body: the clock is the
    // external system this effect subscribes to. Re-stamping re-runs the
    // effect, which arms the timer for the following boundary, if any. The
    // stamp is the boundary itself, never a client clock that may trail it.
    const id = setTimeout(() => setStamp({ at: plan.stampAt, client: Date.now() }), plan.delayMs);
    return () => clearTimeout(id);
  }, [
    stamp,
    settings.updatedAt,
    settings.scoringStartsAt,
    settings.scoringEndsAt,
    settings.registrationStartsAt,
    settings.registrationEndsAt,
  ]);

  return { settingsAt, restampNow };
}
