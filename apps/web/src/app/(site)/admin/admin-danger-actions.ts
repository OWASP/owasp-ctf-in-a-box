// The Event tab's Danger zone writes: master reset, demo seed and demo
// clear. Three fetches that report through the shell's `error`/`resetInfo`
// state rather than the per-field write path — they have no field to report
// beside.
//
// A plain factory, not a hook: each action closes over the setters the caller
// (`useAdminSettingsDrafts` in use-admin-settings.ts) owns, so nothing here
// holds state of its own, and it returns fresh on every call with no
// memoization.

import type { Dispatch, SetStateAction } from "react";
import type { AdminSettings } from "@/lib/admin-store";

export function createDangerActions({
  setError,
  setResetInfo,
  setSettings,
  restampNow,
}: {
  setError: Dispatch<SetStateAction<string | null>>;
  setResetInfo: Dispatch<SetStateAction<string | null>>;
  setSettings: Dispatch<SetStateAction<AdminSettings>>;
  /** Re-stamps the schedule readout after a write (use-admin-restamp.ts). */
  restampNow: () => void;
}): {
  doReset: (confirmValue: string) => Promise<void>;
  doSeed: () => Promise<void>;
  doClearDemo: () => Promise<void>;
} {
  // Master reset: wipes all event data. Type-to-confirm gated in the modal;
  // the server re-checks the phrase and requires admin. On success the box is
  // frozen (the reset freezes scoring), so reflect that + show the counts.
  const doReset = async (confirmValue: string): Promise<void> => {
    setError(null);
    setResetInfo(null);
    const res = await fetch("/api/admin/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: confirmValue }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      cleared?: Record<string, number>;
      error?: string;
    };
    if (!res.ok) {
      setError(data.error ?? "Reset failed");
      return;
    }
    // The server reset freezes AND relocks (it clears the scoring start),
    // so local state follows — or the Launch block would still say "Live".
    setSettings((s) => ({ ...s, paused: true, scoringStartsAt: null }));
    restampNow();
    const total = Object.values(data.cleared ?? {}).reduce((a, b) => a + b, 0);
    setResetInfo(`Wiped ${total} keys — the event is frozen and not launched. Launch and unfreeze when you're ready.`);
  };

  // No DEMO_MODE gate (ADR 58): populate a demo leaderboard
  // (fake contestants + teams). Type-to-confirm gated in the modal; the
  // server re-checks the phrase and requires admin, same pattern as reset.
  const doSeed = async (): Promise<void> => {
    setError(null);
    setResetInfo(null);
    const res = await fetch("/api/admin/seed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "SEED" }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      contestants?: number;
      teams?: number;
      solves?: number;
      error?: string;
    };
    if (!res.ok) {
      setError(data.error ?? "Seed failed");
      return;
    }
    setResetInfo(
      `Seeded ${data.contestants} contestants, ${data.teams} teams, ${data.solves} solves. The board revalidates within ~30s.`,
    );
  };

  // The inverse: removes exactly the rows doSeed above wrote.
  // Same type-to-confirm + admin gate; see clearDemoData's own doc comment
  // for what it deliberately leaves behind (authored demo challenges).
  const doClearDemo = async (): Promise<void> => {
    setError(null);
    setResetInfo(null);
    const res = await fetch("/api/admin/seed", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "CLEAR DEMO DATA" }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      contestants?: number;
      teams?: number;
      sponsors?: number;
      error?: string;
    };
    if (!res.ok) {
      setError(data.error ?? "Clear failed");
      return;
    }
    setResetInfo(
      `Cleared demo rows for ${data.contestants} contestants, ${data.teams} teams, ${data.sponsors} sponsors. Demo questions/challenges/categories are left as authored content — remove those by hand if you don't want them.`,
    );
  };

  return { doReset, doSeed, doClearDemo };
}
