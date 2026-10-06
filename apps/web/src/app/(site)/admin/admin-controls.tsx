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
// The settings state machine (`settings`, the draft input strings,
// `pending`, `error`, `confirm`) and the `apply`/`commitNumber` write path
// live in use-admin-settings.ts (`useAdminSettingsDrafts`, called once
// below), the destination list and active-tab state in use-admin-nav.ts, and
// the audit line's clock in admin-changed-at.tsx — this component threads
// them to the tab bodies as props and stays display + dispatch only, the
// tabs presentational. All writes go through POST /api/admin/settings (auth
// + validation enforced server-side — see src/app/api/admin/settings/
// route.ts).
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

import { useCallback, useMemo, useState } from "react";
import type { AdminSettings } from "@/lib/admin-store";
import { phaseFromSettings } from "@/components/phase";
import {
  ALL_MODULE_IDS,
  moduleDefById,
  type ModuleSetupContent,
  type ResolvedModule,
} from "@/lib/modules";
import ConfirmModal from "@/components/confirm-modal";
import type { ModuleInventory } from "@/components/admin-module-setup";
import AdminQuizControls from "@/components/admin-quiz-controls";
import AdminClassicControls from "@/components/admin-classic-controls";
import AdminAiControls from "@/components/admin-ai-controls";
import type { SyncStatus } from "@/lib/admin-store";
import AdminSidebar from "./admin-sidebar";
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
import { ChangedAt } from "./admin-changed-at";
import { useAdminSettingsDrafts } from "./use-admin-settings";
import {
  ACTIVITY_TAB,
  ADMINS_TAB,
  EVENT_TAB,
  HINTS_TAB,
  INSIGHTS_TAB,
  OVERVIEW_TAB,
  SPONSORS_TAB,
  SUPPORT_TAB,
  useAdminNav,
} from "./use-admin-nav";

// Registry defaults (displayName/description) keyed by id, for the identity
// form's placeholders. Not the `modules` prop — a `ResolvedModule`
// deliberately has no `displayName`/`description` (see lib/modules.ts): those
// are what an override REPLACES, and this is the one place the admin panel
// needs the pre-override default alongside it.
//
// Built from the WHOLE registry rather than the baked set: a module enabled at
// runtime is renameable like any other, and keying this off
// event.yaml would leave its identity form with no placeholder to show.
const MODULE_DEFAULTS = new Map(
  ALL_MODULE_IDS.map((id) => {
    const def = moduleDefById(id);
    return [id as string, { title: def?.displayName ?? id, blurb: def?.description ?? "" }];
  }),
);

// The URL⇄tab rules live in admin-tabs.ts, which carries no `"use client"`,
// because the two routes CALL them on the server and a function exported from
// a Client Component is a client reference rather than a callable.
// Re-exported here so this module stays the one import site for its own
// client callers.
export { adminTabHref, resolveAdminTab, tabFromLocation } from "@/app/(site)/admin/admin-tabs";

// …and the rename-after-save decision, which the write path in
// use-admin-settings.ts implements. Re-exported for the same reason: this is
// where its callers (admin-controls.test.tsx today, any future client caller
// tomorrow) import it from, and moving the implementation must not move the
// import site.
export { nextEventNameAfterSave } from "./use-admin-settings";

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
   *  ctf:admin:settings — computed server-side from SCORE_IMAGE,
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
  /** The poller's own heartbeat — page.tsx already fetches this; Overview
   *  folds it into its "Sync" line instead. `null`
   *  when no poller has ever reported in (poll mode not configured, or push
   *  mode, which has no poller at all) — the default for callers (most
   *  tests) that don't care about it. */
  sync?: SyncStatus | null;
  /** The resolved runtime event name: resolved server-side by
   *  getSite(); a client bundle cannot read settings. Threaded through to the
   *  Event tab, which uses it for the master-reset confirmation phrase. */
  eventName: string;
}) {
  // The whole settings state machine in one call: stored settings, the nine
  // numeric drafts, pending/error/confirm/resetInfo, and the write path
  // (use-admin-settings.ts). What this component does with the result is
  // dispatch only — hand each tab the slice it renders.
  const {
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
  } = useAdminSettingsDrafts({ initial, eventName });

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

  // The destination list, the sidebar's groups and the active-tab state (with
  // the pushState/popstate wiring) — use-admin-nav.ts.
  const { tabs, sidebarGroups, active, setActive, selectTab } = useAdminNav({ modules, initialTab });

  // Whether the live views (Overview, Activity, Insights) keep polling — see
  // use-live-poll.ts. Evaluated at `settingsAt`, which the boundary timer in
  // use-admin-restamp.ts re-stamps when a scheduled window opens or closes,
  // so the loop starts and stops with the phase without a page reload.
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
