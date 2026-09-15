"use client";

// The organizer admin page's control surface: a tab shell. One "Event" tab
// for the control-plane settings that belong to the platform itself (freeze,
// scoring/registration windows, the hint policy, demo seed, master reset),
// then one tab per entry in the resolved `modules` prop, labelled with the
// organizer's own title for that module. A module's own knobs — the re-run
// cooldown under Secure Development, the retry gate under Quiz — therefore
// exist iff that module is enabled. The hint policy is deliberately NOT one
// of those: three modules sell hints through the same four settings, so it
// sits on Event, where it is reachable whatever the event enables.
//
// This component owns ALL the settings state (`settings`, the draft input
// strings, `pending`, `error`, `confirm`) plus the `apply`/`commitNumber`
// helpers, and hands them to the tab bodies as props; the tabs are
// presentational. All writes go through POST /api/admin/settings (auth +
// validation enforced server-side — see src/app/api/admin/settings/route.ts);
// this component is display + dispatch only.
//
// Every panel is rendered into the DOM and hidden with the `hidden`
// attribute rather than conditionally unmounted. That is deliberate: it keeps
// each tab's own state (a half-typed hint cost, an open question form) alive
// across tab switches, and it is what lets the static-markup tests assert on
// a panel they are not "looking at" — a `{active === id && <Tab/>}` shell
// would render nothing for the other tabs and make those assertions vacuous.
//
// Accessibility: this is a surface an organizer drives during a live event,
// so the tablist implements the full WAI-ARIA tabs pattern — roving
// `tabIndex`, `aria-selected`/`aria-controls`/`aria-labelledby` wiring, and
// ArrowLeft/ArrowRight/Home/End movement with wraparound.

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatRelativeTime } from "@/lib/relative-time";
import type { AdminSettings } from "@/lib/admin-store";
import { nextScheduleBoundary } from "@/lib/schedule-window";
import { DEFAULT_EVENT_IDENTITY } from "@/lib/event-identity";
import { phaseFromSettings } from "@/components/phase";
import {
  ALL_MODULE_IDS,
  moduleDefById,
  type ModuleSetupContent,
  type ResolvedModule,
} from "@/lib/modules";
import ConfirmModal from "@/components/confirm-modal";
import type { ModuleInventory } from "@/components/admin-module-setup";
import { describeFieldError, parseNumberCommit, type FieldStatus } from "@/components/admin-number-field";
import AdminQuizControls from "@/components/admin-quiz-controls";
import AdminClassicControls from "@/components/admin-classic-controls";
import AdminAiControls from "@/components/admin-ai-controls";
import type { SyncStatus } from "@/lib/admin-store";
import AdminSidebar, { type SidebarGroup } from "./admin-sidebar";
import AdminOverviewTab from "./admin-overview-tab";
import AdminAdminsTab from "./admin-admins-tab";
import AdminActivityTab from "./admin-activity-tab";
import AdminInsightsTab from "./admin-insights-tab";
import AdminSupportTab from "./admin-support-tab";
import AdminEventTab from "./admin-event-tab";
import AdminHintsTab from "./admin-hints-tab";
import AdminSponsorsTab from "./admin-sponsors-tab";
import AdminSettingsCard from "@/components/admin/settings-card";
import AdminSecureDevTab from "./admin-secure-dev-tab";
import AdminModulePanel from "./admin-module-panel";
import { moduleChoices } from "./module-toggle";
import type { CommitNumber, ConfirmState } from "./types";
import { adminTabHref, tabFromLocation } from "@/app/(site)/admin/admin-tabs";

// Registry defaults (displayName/description) keyed by id, for the identity
// form's placeholders. Not the `modules` prop — a `ResolvedModule`
// deliberately has no `displayName`/`description` (see lib/modules.ts): those
// are what an override REPLACES, and this is the one place the admin panel
// needs the pre-override default alongside it.
//
// Built from the WHOLE registry rather than the baked set: a module enabled at
// runtime (issue #175) is renameable like any other, and keying this off
// event.yaml would leave its identity form with no placeholder to show.
const MODULE_DEFAULTS = new Map(
  ALL_MODULE_IDS.map((id) => {
    const def = moduleDefById(id);
    return [id as string, { title: def?.displayName ?? id, blurb: def?.description ?? "" }];
  }),
);

// The URL⇄tab rules live in admin-tabs.ts, which carries no `"use client"`,
// because the two routes CALL them on the server and a function exported from
// a Client Component is a client reference rather than a callable (issue #312).
// Re-exported here so this module stays the one import site for its own
// client callers.
export { adminTabHref, resolveAdminTab, tabFromLocation } from "@/app/(site)/admin/admin-tabs";

// The landing destination (admin-redesign.md PR 1): "is scoring on, how many
// teams, is anything stuck" answered in one screen rather than three tabs.
// Also the fallback for a deep link this shell doesn't recognise — a stale
// bookmark or a typo lands an organizer somewhere real, not on nothing.
const OVERVIEW_TAB = "overview";
/** The always-present control-plane tab. Module tabs follow it, in the order
 *  the event config lists them. */
const EVENT_TAB = "event";
// The hint policy's own destination (admin-redesign.md's Event/Hints/Admins
// split) — see admin-hints-tab.tsx for why it isn't a module's or Event's.
const HINTS_TAB = "hints";
/** Runtime admin management (issue #147). Sits beside Event rather than
 *  inside it: it manages WHO may use the panel, not what the event does. */
const ADMINS_TAB = "admins";
// Sponsor recognition (issue #405) — a platform feature, not a module, so it
// sits beside Event/Hints/Admins rather than in the module tab row.
const SPONSORS_TAB = "sponsors";
// Live-event support (issue #168). Sits after Admins and before the module
// tabs: it is control-plane, not module-specific, and an organizer reaching
// for it is mid-incident rather than mid-configuration.
const SUPPORT_TAB = "support";
// Engagement metrics (issue #169). Control-plane like Event/Admins/Support,
// and last of the four because it is read-only — an organizer reaches for it
// after the event more often than during it.
const INSIGHTS_TAB = "insights";
// The activity log (issue #212). Read-only like Insights but LIVE — an
// organizer reaches for it mid-event ("did anyone sign in yet?", "who just
// solved that?"), so it sits between Support and Insights.
const ACTIVITY_TAB = "activity";

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

/** The audit line's timestamp, as "4m ago" rather than a raw ISO instant.
 *
 *  Renders nothing until mounted, for the same reason the countdowns do: this
 *  is a Client Component that still server-renders, and relative time read
 *  from a live clock during render disagrees with the server's render. So the
 *  server paints "last changed by alice" and the time appears on hydration.
 *
 *  The exact instant stays available on hover via `title` — an organizer
 *  reconciling an audit trail wants the precise value, just not in their face. */
function ChangedAt({ iso }: { iso: string }) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => setLabel(formatRelativeTime(iso));
    const timeout = setTimeout(tick, 0);
    // 30s, not 1s: this line ages in minutes and nobody is watching it count.
    const interval = setInterval(tick, 30_000);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [iso]);

  if (!label) return null;
  return <time dateTime={iso} title={iso}>{label}</time>;
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
 *  decision itself is pure and needs none. */
export function nextEventNameAfterSave(
  key: string,
  current: string,
  saved: Pick<AdminSettings, "eventIdentity">,
): string {
  if (key !== "eventName") return current;
  return saved.eventIdentity.eventName ?? DEFAULT_EVENT_IDENTITY.eventName;
}

export default function AdminControls({
  initial,
  defaultModuleIds,
  secureDevAvailable,
  modules,
  setups,
  initialTab,
  viewerLogin,
  sync = null,
  eventName,
}: {
  initial: AdminSettings;
  /** The module set this deployment starts with, when nothing is stored in
   *  ctf:admin:settings — computed server-side from SCORE_IMAGE (issue #386),
   *  since a client bundle has no access to that env var. */
  defaultModuleIds: readonly string[];
  /** Whether this deployment has a scorer image, computed server-side from
   *  SCORE_IMAGE. The only reason Secure Development's switch locks — see
   *  module-toggle.ts. */
  secureDevAvailable: boolean;
  /** Modules with the organizer's naming already applied (see
   *  lib/resolved-modules.ts). Render `title` — a `ResolvedModule` has no
   *  `displayName`, by design. */
  modules: readonly ResolvedModule[];
  /** Each module's setup checklist, keyed by module id — the registry's
   *  `setup` block already CALLED server-side (page.tsx), so only plain data
   *  crosses into this Client Component. A module with no block is simply
   *  absent and renders no setup panel. */
  setups?: Partial<Record<string, ModuleSetupContent>>;
  /** Which tab to open on arrival, from `/admin?tab=<module id>`. Anything
   *  this shell doesn't recognise — a typo, or a module this event didn't
   *  enable — falls back to Overview rather than opening nothing. Resolved
   *  on the server (see page.tsx) so the first render already has the right
   *  panel open; the organizer never sees it flip. */
  initialTab?: string;
  /** The signed-in organizer's GitHub login, from the same `requireAdmin`
   *  gate that rendered this page. The Admins tab uses it to warn before
   *  someone revokes their own access. */
  viewerLogin: string;
  /** The poller's own heartbeat — page.tsx already fetches this for the old
   *  Status card; Overview folds it into its "Sync" line instead. `null`
   *  when no poller has ever reported in (poll mode not configured, or push
   *  mode, which has no poller at all) — the default for callers (most
   *  tests) that don't care about it. */
  sync?: SyncStatus | null;
  /** The resolved runtime event name (issue #386): resolved server-side by
   *  getSite(); a client bundle cannot read settings. Threaded through to the
   *  Event tab, which uses it for the master-reset confirmation phrase. */
  eventName: string;
}) {
  const [settings, setSettings] = useState(initial);
  // The name the Event tab's master-reset confirmation asks for. Seeded from
  // the server-resolved `eventName` prop, then re-derived (below, in
  // `applyField`) from the POST response whenever the saved patch renamed the
  // event — otherwise a rename left this stale at the pre-rename name, so a
  // reset typed against the NEW name (shown everywhere else on this very
  // panel) failed `getSite()`'s server-side check with "confirmation does not
  // match the event name" (CodeRabbit round 1, #389).
  const [currentEventName, setCurrentEventName] = useState(eventName);
  // The "now" the Event tab's schedule readout is evaluated at (epoch ms).
  // Stamped at mount, in the handlers that change settings, and — below — by
  // a timer at the next instant a scoring/registration window opens or
  // closes, so an organizer parked on the tab across a boundary sees the
  // flip without touching anything. Never read from the clock in render:
  // that is the impure read the compiler lint rejects.
  const [settingsAt, setSettingsAt] = useState(() => Date.now());
  useEffect(() => {
    const at = nextScheduleBoundary(settingsAt, [
      { startsAt: settings.scoringStartsAt, endsAt: settings.scoringEndsAt },
      { startsAt: settings.registrationStartsAt, endsAt: settings.registrationEndsAt },
    ]);
    if (at === null) return;
    // setState in a timer callback, not in the effect body: the clock is the
    // external system this effect subscribes to. Re-stamping re-runs the
    // effect, which arms the timer for the following boundary, if any.
    const id = setTimeout(() => setSettingsAt(Date.now()), Math.max(0, at - Date.now()));
    return () => clearTimeout(id);
  }, [settingsAt, settings.scoringStartsAt, settings.scoringEndsAt, settings.registrationStartsAt, settings.registrationEndsAt]);
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

  // What each module's list panel has reported about its own content (how
  // many questions/challenges/categories exist), so the setup checklist above
  // it can show "3 questions" instead of asking the organizer to remember.
  // The panels are the source of truth — they hold the live lists — and they
  // report AFTER their mount-time fetch settles, so a module absent from this
  // map is "not yet known", never "empty". Equal reports bail out without a
  // state change: a panel re-reports on every list change, and a fresh object
  // for the same numbers would otherwise re-render the whole shell for
  // nothing.
  const [inventory, setInventory] = useState<Record<string, ModuleInventory>>({});
  const reportInventory = useCallback((id: string, next: ModuleInventory) => {
    setInventory((prev) => {
      const cur = prev[id];
      if (cur && cur.items === next.items && cur.categories === next.categories) return prev;
      return { ...prev, [id]: next };
    });
  }, []);
  // One stable callback per module, so a panel's report effect (keyed on the
  // callback) does not re-fire on every shell render.
  const inventoryReporters = useMemo(
    () =>
      Object.fromEntries(modules.map((mod) => [mod.id, (next: ModuleInventory) => reportInventory(mod.id, next)])) as Record<
        string,
        (next: ModuleInventory) => void
      >,
    [modules, reportInventory],
  );

  const tabs = [
    { id: OVERVIEW_TAB, label: "Overview" },
    { id: EVENT_TAB, label: "Event" },
    { id: HINTS_TAB, label: "Hints" },
    { id: ADMINS_TAB, label: "Admins" },
    { id: SPONSORS_TAB, label: "Sponsors" },
    { id: SUPPORT_TAB, label: "Support" },
    { id: ACTIVITY_TAB, label: "Activity" },
    { id: INSIGHTS_TAB, label: "Insights" },
    ...modules.map((mod) => ({ id: mod.id as string, label: mod.title })),
  ];
  const [active, setActive] = useState<string>(
    tabs.some((t) => t.id === initialTab) ? (initialTab as string) : OVERVIEW_TAB,
  );

  // Switching tabs is client-side state (instant, no server round-trip), so
  // the address bar has to be told about it — otherwise the panel shows
  // Activity while the URL still reads /admin/overview, and an organizer
  // pasting "the link I'm looking at" sends the wrong screen. pushState keeps
  // the two in step and leaves a real history entry, so Back walks the tabs.
  const selectTab = useCallback((id: string) => {
    setActive(id);
    window.history.pushState(null, "", adminTabHref(id));
  }, []);

  // …and Back/Forward has to move the panel, not just the URL.
  const tabIds = tabs.map((t) => t.id).join(",");
  useEffect(() => {
    const onPop = () => {
      const id = tabFromLocation(window.location.pathname, window.location.search);
      setActive(tabIds.split(",").includes(id) ? id : OVERVIEW_TAB);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [tabIds]);

  // The sidebar's three groups (admin-redesign.md). CONTENT is every enabled
  // module, in the order `modules` lists them — the same order the flat tab
  // row used.
  const sidebarGroups: readonly SidebarGroup[] = [
    {
      heading: "Run",
      items: [
        { id: OVERVIEW_TAB, label: "Overview" },
        { id: ACTIVITY_TAB, label: "Activity" },
        { id: INSIGHTS_TAB, label: "Insights" },
        { id: SUPPORT_TAB, label: "Support" },
      ],
    },
    {
      heading: "Content",
      items: modules.map((mod) => ({ id: mod.id as string, label: mod.title })),
    },
    {
      heading: "Setup",
      items: [
        { id: EVENT_TAB, label: "Event" },
        { id: HINTS_TAB, label: "Hints" },
        { id: ADMINS_TAB, label: "Admins" },
        { id: SPONSORS_TAB, label: "Sponsors" },
      ],
    },
  ];

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

  // Master reset: wipes all event data. Type-to-confirm gated in the modal;
  // the server re-checks the phrase and requires admin. On success the box is
  // frozen (the reset freezes scoring), so reflect that + show the counts.
  const doReset = async (confirmValue: string) => {
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
    setSettings((s) => ({ ...s, paused: true }));
    setSettingsAt(Date.now());
    const total = Object.values(data.cleared ?? {}).reduce((a, b) => a + b, 0);
    setResetInfo(`Wiped ${total} keys — scoring is now frozen. Unfreeze when you're ready.`);
  };

  // No DEMO_MODE gate any more (issue #419): populate a demo leaderboard
  // (fake contestants + teams). Type-to-confirm gated in the modal; the
  // server re-checks the phrase and requires admin, same pattern as reset.
  const doSeed = async () => {
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

  // The inverse: removes exactly the rows doSeed above wrote (issue #419).
  // Same type-to-confirm + admin gate; see clearDemoData's own doc comment
  // for what it deliberately leaves behind (authored demo challenges).
  const doClearDemo = async () => {
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

  /** Re-seeds every numeric draft string from the settings the server just
   *  confirmed, so what the fields show is what is stored. */
  const syncInputs = (s: AdminSettings) => {
    setSettings(s);
    setSettingsAt(Date.now());
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

  // Whether the live views (Overview, Activity, Insights) keep polling — see
  // use-live-poll.ts. Evaluated at `settingsAt`, which the boundary timer
  // above re-stamps when a scheduled window opens or closes, so the loop
  // starts and stops with the phase without a page reload.
  const eventLive = phaseFromSettings(settings, settingsAt).phase === "live";

  // The row set for the module switches (Event's rows and each module
  // panel's header switch) — locked only for secure-development without a
  // scorer image (module-toggle.ts). `useMemo` because this is a client
  // component: a fresh array/object identity on every render would defeat
  // the tabs below that key off it.
  const moduleChoicesList = useMemo(() => moduleChoices(secureDevAvailable), [secureDevAvailable]);
  // The enabled set as the module switches see it (Event's rows and each
  // module panel's header): the runtime set, or the default one when no
  // override is stored.
  const liveModuleIds: readonly string[] = settings.enabledModuleIds ?? defaultModuleIds;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-6 lg:flex-row">
        <AdminSidebar groups={sidebarGroups} active={active} onSelect={selectTab} />

        <div className="min-w-0 flex-1">
          {tabs.map((tab) => (
            <div key={tab.id} role="region" id={`panel-${tab.id}`} aria-label={tab.label} hidden={active !== tab.id}>
              {tab.id === OVERVIEW_TAB ? (
                <AdminOverviewTab
                  settings={settings}
                  pending={pending}
                  applyField={applyField}
                  statusOf={statusOf}
                  setConfirm={setConfirm}
                  nowMs={settingsAt}
                  sync={sync}
                  modules={modules}
                  setups={setups}
                  inventory={inventory}
                  onNavigate={setActive}
                  visible={active === OVERVIEW_TAB}
                />
              ) : tab.id === EVENT_TAB ? (
                <AdminEventTab
                  settings={settings}
                  pending={pending}
                  resetInfo={resetInfo}
                  eventName={currentEventName}
                  applyField={applyField}
                  statusOf={statusOf}
                  setConfirm={setConfirm}
                  doReset={doReset}
                  doSeed={doSeed}
                  doClearDemo={doClearDemo}
                  teamMaxMembersInput={teamMaxMembersInput}
                  setTeamMaxMembersInput={setTeamMaxMembersInput}
                  commitNumber={commitNumber}
                  moduleChoices={moduleChoicesList}
                  liveModuleIds={liveModuleIds}
                  nowMs={settingsAt}
                />
              ) : tab.id === HINTS_TAB ? (
                <AdminHintsTab
                  settings={settings}
                  pending={pending}
                  applyField={applyField}
                  statusOf={statusOf}
                  commitNumber={commitNumber}
                  hintCostInput={hintCostInput}
                  setHintCostInput={setHintCostInput}
                  minSolvesInput={minSolvesInput}
                  setMinSolvesInput={setMinSolvesInput}
                  unlockAfterInput={unlockAfterInput}
                  setUnlockAfterInput={setUnlockAfterInput}
                />
              ) : tab.id === ADMINS_TAB ? (
                <AdminAdminsTab viewerLogin={viewerLogin} />
              ) : tab.id === SPONSORS_TAB ? (
                <AdminSponsorsTab
                  settings={settings}
                  settingsPending={pending}
                  applyField={applyField}
                  statusOf={statusOf}
                />
              ) : tab.id === SUPPORT_TAB ? (
                <AdminSupportTab setConfirm={setConfirm} />
              ) : tab.id === ACTIVITY_TAB ? (
                <AdminActivityTab visible={active === ACTIVITY_TAB} live={eventLive} />
              ) : tab.id === INSIGHTS_TAB ? (
                <AdminInsightsTab visible={active === INSIGHTS_TAB} live={eventLive} />
              ) : (
                // The module's Content screen: header + switch, setup status,
                // identity, then the module's own knobs and lists (below). The
                // panel is driven by the `setups` map and the modules list —
                // no per-module branch, so a fifth module gets its screen for
                // free; only the controls inside it are module-specific.
                <AdminModulePanel
                  mod={modules.find((m) => m.id === tab.id)!}
                  choice={moduleChoicesList.find((c) => c.id === tab.id) ?? { id: tab.id, label: tab.label, toggleable: true }}
                  liveModuleIds={liveModuleIds}
                  setup={setups?.[tab.id]}
                  inventory={inventory[tab.id]}
                  defaults={MODULE_DEFAULTS.get(tab.id) ?? { title: tab.label, blurb: "" }}
                  settings={settings}
                  pending={pending}
                  apply={apply}
                  applyField={applyField}
                  statusOf={statusOf}
                  setConfirm={setConfirm}
                  sellsHints={tab.id !== "quiz"}
                  onNavigateHints={() => setActive(HINTS_TAB)}
                >
                  {(moduleSettings) =>
                    tab.id === "secure-development" ? (
                      <AdminSecureDevTab
                        settings={settings}
                        pending={pending}
                        apply={apply}
                        applyField={applyField}
                        commitNumber={commitNumber}
                        statusOf={statusOf}
                        cooldownInput={cooldownInput}
                        setCooldownInput={setCooldownInput}
                        moduleSettings={moduleSettings}
                      />
                    ) : tab.id === "quiz" ? (
                      <AdminQuizControls
                        pending={pending}
                        quizMaxAttemptsInput={quizMaxAttemptsInput}
                        setQuizMaxAttemptsInput={setQuizMaxAttemptsInput}
                        quizRetryAfterInput={quizRetryAfterInput}
                        setQuizRetryAfterInput={setQuizRetryAfterInput}
                        commitNumber={commitNumber}
                        statusOf={statusOf}
                        onInventory={inventoryReporters[tab.id]}
                        moduleSettings={moduleSettings}
                      />
                    ) : tab.id === "classic" ? (
                      <AdminClassicControls
                        pending={pending}
                        classicCooldownSecInput={classicCooldownSecInput}
                        setClassicCooldownSecInput={setClassicCooldownSecInput}
                        commitNumber={commitNumber}
                        statusOf={statusOf}
                        onInventory={inventoryReporters[tab.id]}
                        moduleSettings={moduleSettings}
                      />
                    ) : tab.id === "ai" ? (
                      <AdminAiControls
                        pending={pending}
                        aiCooldownSecInput={aiCooldownSecInput}
                        setAiCooldownSecInput={setAiCooldownSecInput}
                        commitNumber={commitNumber}
                        statusOf={statusOf}
                        onInventory={inventoryReporters[tab.id]}
                        moduleSettings={moduleSettings}
                      />
                    ) : (
                      <>
                        <AdminSettingsCard identity={moduleSettings.identity} onHints={moduleSettings.onHints} />
                        <p className="text-sm text-muted">No settings for this module yet.</p>
                      </>
                    )
                  }
                </AdminModulePanel>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* The settings audit line. Not under Activity or Insights: neither
          changes a setting, so "last changed by" under a table of solves reads
          as a claim about the table (admin-redesign.md § Activity, Insights). */}
      {settings.updatedBy && settings.updatedAt && active !== ACTIVITY_TAB && active !== INSIGHTS_TAB && (
        <p className="text-sm text-muted">
          last changed by {settings.updatedBy} <ChangedAt iso={settings.updatedAt} />
        </p>
      )}
      {error && <p className="text-sm text-[#e53e3e]">{error}</p>}

      {confirm && (
        <ConfirmModal
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          requireType={confirm.requireType}
          danger={confirm.danger}
          pending={pending}
          onConfirm={() => void runConfirm()}
          onCancel={() => !pending && setConfirm(null)}
        />
      )}
    </div>
  );
}
