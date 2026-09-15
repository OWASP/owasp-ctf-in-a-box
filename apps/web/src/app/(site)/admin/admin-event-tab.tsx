"use client";

// The Event tab: the control-plane settings that belong to the platform
// itself rather than to any one module — the scoring freeze, team
// registration, the scheduling windows, demo seeding, and the master reset.
// The hint policy used to live here too; admin-redesign.md's Event/Hints/
// Admins split moved it to its own destination (admin-hints-tab.tsx) — see
// that file's header for why it is a destination of its own rather than a
// module's.
//
// Presentational: every piece of state it reads (`settings`, `pending`,
// `resetInfo`) and every mutation it triggers (`applyField`, `setConfirm`,
// `doReset`, `doSeed`) is owned by `admin-controls.tsx` and passed in, so the
// shell stays the single writer of settings state across all tabs. Every
// write here belongs to one row — a switch or a field — so all of them go
// through `applyField` and report beside that row (admin-redesign.md
// § Controls); there is no panel-wide `apply` left on this tab.

import { useEffect, useState } from "react";
import type { AdminSettings } from "@/lib/admin-store";
import { outsideWindow } from "@/lib/schedule-window";
import { TEAM_MAX_MEMBERS, TEAM_MAX_MEMBERS_MAX } from "@/lib/team-limits";
import { DEFAULT_EVENT_IDENTITY, EVENT_IDENTITY_MAX, type EventIdentityKey } from "@/lib/event-identity";
import AdminEventControls from "@/components/admin-event-controls";
import AdminNumberField, { FieldStatusLine, type FieldStatus } from "@/components/admin-number-field";
import AdminSwitch from "@/components/admin-switch";
import { FREEZE_HELP, freezeConfirm } from "./freeze-copy";
import { IdentityField } from "./admin-module-identity";
import { moduleToggleConfirm, moduleToggleState, type ModuleToggleChoice } from "./module-toggle";
import type { CommitNumber, ConfirmState } from "./types";

/** The Identity section's rows, in spec order. Exported for the test that
 *  pins key/label/maxLength against the contract in lib/event-identity.ts. */
export const EVENT_IDENTITY_ROWS: readonly {
  key: EventIdentityKey;
  label: string;
  help: string;
  placeholder: string;
  maxLength: number;
}[] = [
  {
    key: "eventName",
    label: "Event name",
    help: `Page titles, the header, the leaderboard and this panel's reset confirmation. Blank restores “${DEFAULT_EVENT_IDENTITY.eventName}”.`,
    placeholder: DEFAULT_EVENT_IDENTITY.eventName,
    maxLength: EVENT_IDENTITY_MAX.eventName,
  },
  {
    key: "eventTheme",
    label: "Tagline",
    help: "One line under the event name on the landing page. Blank hides it.",
    placeholder: "No tagline",
    maxLength: EVENT_IDENTITY_MAX.eventTheme,
  },
  {
    key: "eventLocation",
    label: "Location",
    help: "Shown beside the dates on the landing page and in the page description. Blank hides it.",
    placeholder: "Not shown",
    maxLength: EVENT_IDENTITY_MAX.eventLocation,
  },
  {
    key: "eventContact",
    label: "Contact e-mail",
    help: "The organizers' inbox; the privacy and terms pages render it as a mailto: link. Blank hides it.",
    placeholder: "Not shown",
    maxLength: EVENT_IDENTITY_MAX.eventContact,
  },
  {
    key: "eventDiscord",
    label: "Discord invite",
    help: "An https:// invite; the header, hero, rules, FAQ and 404 link to it. Blank hides every Discord mention.",
    placeholder: "No Discord link",
    maxLength: EVENT_IDENTITY_MAX.eventDiscord,
  },
];

// datetime-local <-> ISO. The <input type="datetime-local"> value is a naive
// local wall-clock string; JS parses it as local time, and we store the
// absolute instant as ISO. Empty input clears the bound (null).
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(s: string): string | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function ScheduleField({
  label,
  value,
  disabled,
  status,
  onCommit,
}: {
  label: string;
  value: string | null;
  disabled: boolean;
  /** The shell's save status for this field (UX audit F2), shown under it. */
  status: FieldStatus;
  /** Resolves to whether the server accepted the value. On refusal the draft
   *  snaps back to the stored value — the sync effect below only fires when
   *  the STORED value changes, which a rejection never does. */
  onCommit: (iso: string | null) => Promise<boolean>;
}) {
  // The datetime-local value is the VIEWER's wall clock, which the server
  // cannot know: seeding the input from toLocalInput() during render made the
  // server (UTC on the box) and the browser (viewer tz) disagree and threw a
  // hydration error (#418) on every /admin load. So SSR renders the field
  // empty and the real value lands after mount — the same
  // render-nothing-until-mounted contract event-countdown uses. The effect
  // also re-syncs when the applied value changes (another field's POST
  // returning fresh settings), which the old one-shot useState never did.
  const [input, setInput] = useState("");
  useEffect(() => {
    // Deferred so this reads as subscribing to the applied value rather than
    // a render-time computation — satisfies react-hooks/set-state-in-effect.
    const timeout = setTimeout(() => setInput(toLocalInput(value)), 0);
    return () => clearTimeout(timeout);
  }, [value]);
  const canonical = toLocalInput(value);
  const rejected = status.state === "rejected";
  const line =
    status.state === "pending" ? "Saving…" : status.state === "saved" ? "Saved" : status.state === "rejected" ? status.message : null;
  const statusId = `schedule-${label.toLowerCase().replace(/\s+/g, "-")}-status`;
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted">{label}</span>
        <input
          type="datetime-local"
          value={input}
          disabled={disabled}
          aria-invalid={rejected ? true : undefined}
          aria-describedby={line ? statusId : undefined}
          onChange={(e) => setInput(e.target.value)}
          onBlur={() => {
            if (input === canonical) return;
            void onCommit(fromLocalInput(input)).then((ok) => {
              if (!ok) setInput(canonical);
            });
          }}
          className="flex-none rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-sm text-white focus-visible:border-[#d4a017]/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
        />
      </label>
      {line && (
        <p
          id={statusId}
          role={rejected ? "alert" : undefined}
          className={`text-right text-sm ${rejected ? "text-[#e53e3e]" : status.state === "saved" ? "text-[#22c55e]" : "text-muted"}`}
        >
          {line}
        </p>
      )}
    </div>
  );
}

export type AdminEventTabProps = {
  settings: AdminSettings;
  pending: boolean;
  resetInfo: string | null;
  /** The resolved runtime name — what the reset modal asks the organizer to
   *  type. Resolved server-side by getSite(); a client bundle cannot read
   *  settings. */
  eventName: string;
  /** A write that belongs to one field or switch: reported into that row's
   *  status rather than the panel-wide error line (UX audit F2). */
  applyField: (key: string, patch: Record<string, unknown>, label: string) => Promise<boolean>;
  statusOf: (key: string) => FieldStatus;
  setConfirm: (c: ConfirmState) => void;
  doReset: (confirmValue: string) => Promise<void>;
  doSeed: () => Promise<void>;
  doClearDemo: () => Promise<void>;
  teamMaxMembersInput: string;
  setTeamMaxMembersInput: (v: string) => void;
  commitNumber: CommitNumber;
  /** Every module the registry knows about, with the name an organizer would
   *  recognise and whether this event may toggle it (issue #175). Includes the
   *  DISABLED ones — a switch you cannot see is not a switch. */
  moduleChoices: readonly ModuleChoice[];
  /** The ids live right now: the runtime set, or the baked one when no
   *  override is stored. */
  liveModuleIds: readonly string[];
  /** The schedule readout's "now", in epoch ms. Stamped by the shell when the
   *  page mounted and again each time it applies a settings change — an
   *  event-time read, not a render-time one (see `settingsAt` in
   *  admin-controls.tsx). */
  nowMs: number;
};

/** The registry row a module switch renders from — see module-toggle.ts,
 *  which the module panels' own header switches share with this tab. */
export type ModuleChoice = ModuleToggleChoice;

export default function AdminEventTab({
  settings,
  pending,
  resetInfo,
  eventName,
  applyField,
  statusOf,
  setConfirm,
  doReset,
  doSeed,
  doClearDemo,
  teamMaxMembersInput,
  setTeamMaxMembersInput,
  commitNumber,
  moduleChoices,
  liveModuleIds,
  nowMs,
}: AdminEventTabProps) {
  const live = new Set(liveModuleIds);
  // Effective state for the schedule section's readout — the same
  // toggle-AND-window rule effectivePaused / effectiveRegistrationOpen apply
  // server-side, built on the shared outsideWindow. `nowMs` is the shell's
  // stamp of when these settings were applied (or the page mounted), which
  // is an acceptable "now": the readout re-computes on every settings
  // change, and an organizer parked on the tab across a boundary sees it on
  // their next change. Not `Date.now()` here — reading the clock during
  // render is the impure read react-hooks/purity rejects, and the value it
  // would give is the same one the stamp already holds.
  const scoringLiveNow = !settings.paused && !outsideWindow(nowMs, settings.scoringStartsAt, settings.scoringEndsAt);
  const registrationOpenNow =
    settings.teamRegistrationOpen && !outsideWindow(nowMs, settings.registrationStartsAt, settings.registrationEndsAt);
  // No "Event" heading inside the panel: the old flat layout needed an <h3> to
  // separate this group from the module sections below it, but the tab strip is
  // that heading now (the panel is labelled by its own tab via
  // aria-labelledby, and module panels carry no equivalent heading either), so
  // repeating it would just duplicate the tab's own label.
  return (
    <section className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 border-b border-white/[0.06] pb-4">
        <div>
          <h3 className="text-white">Identity</h3>
          <p className="text-sm text-muted">How the event names itself. Changes show on the next page load; blank restores the default.</p>
        </div>
        {EVENT_IDENTITY_ROWS.map((row) => {
          const stored = settings.eventIdentity[row.key] ?? "";
          const status = statusOf(row.key);
          const hasLine = status.state !== "idle";
          const statusId = `identity-${row.key}-status`;
          const helpId = `identity-${row.key}-help`;
          // The help paragraph is always in the description — it's static
          // copy explaining the field, not a transient result — and the
          // status line joins in only while one is showing, same pattern
          // AdminSwitch/AdminNumberField use for their own status lines.
          const describedBy = hasLine ? `${helpId} ${statusId}` : helpId;
          return (
            <div key={row.key} className="flex flex-col gap-1">
              <label htmlFor={`identity-${row.key}`} className="text-sm text-white">{row.label}</label>
              <IdentityField
                key={`${row.key}-${stored}`}
                id={`identity-${row.key}`}
                patchKey={row.key}
                stored={stored}
                placeholder={row.placeholder}
                maxLength={row.maxLength}
                disabled={pending}
                multiline={false}
                apply={(patch) => applyField(row.key, patch, row.label)}
                ariaDescribedBy={describedBy}
                ariaInvalid={status.state === "rejected"}
              />
              <p id={helpId} className="text-xs text-muted">{row.help}</p>
              <FieldStatusLine id={statusId} status={status} />
            </div>
          );
        })}
      </section>

      <section className="flex flex-col gap-2 border-b border-white/[0.06] pb-4">
        <div>
          <h3 className="text-white">Modules</h3>
          <p className="text-sm text-muted">
            What this event serves. Switching one off hides its board and its nav link straight away —
            it deletes nothing, so switching it back on restores the same answers, solves and points.
          </p>
        </div>
        {moduleChoices.map((mod) => {
          const toggle = moduleToggleState(mod, live);
          // One status key per module row, not one for the whole
          // `enabledModules` write: "Saved" belongs beside the switch that
          // was flipped, not beside every module at once. The same key the
          // module's own panel header reports under.
          return (
            <AdminSwitch
              key={mod.id}
              id={`module-${mod.id}`}
              label={mod.label}
              help={toggle.help}
              checked={toggle.on}
              disabled={pending || toggle.disabled}
              status={statusOf(`module:${mod.id}`)}
              onChange={(next) => {
                const c = moduleToggleConfirm(mod, next, live);
                setConfirm({
                  title: c.title,
                  body: c.body,
                  confirmLabel: c.confirmLabel,
                  onConfirm: () => applyField(`module:${mod.id}`, { enabledModules: c.ids }, mod.label),
                });
              }}
            />
          );
        })}
      </section>

      {/* Status keys are the stored setting keys, shared with Overview's
          Scoring and Registration switches (admin-overview-tab.tsx), so a
          flip made on either screen reports on both. */}
      <AdminSwitch
        id="event-paused"
        label="Freeze scoring"
        help={FREEZE_HELP}
        checked={settings.paused}
        disabled={pending}
        status={statusOf("paused")}
        onChange={(next) => {
          setConfirm({
            ...freezeConfirm(next),
            onConfirm: () => applyField("paused", { paused: next }, "Freeze scoring"),
          });
        }}
      />

      <AdminSwitch
        id="event-registration"
        label="Team registration open"
        help="Allow players to create or join teams."
        checked={settings.teamRegistrationOpen}
        disabled={pending}
        status={statusOf("teamRegistrationOpen")}
        onChange={(next) => {
          setConfirm({
            title: next ? "Open team registration?" : "Close team registration?",
            body: next
              ? "Players will be able to create and join teams."
              : "Players will no longer be able to create or join teams.",
            confirmLabel: next ? "Open" : "Close",
            onConfirm: () => applyField("teamRegistrationOpen", { teamRegistrationOpen: next }, "Team registration"),
          });
        }}
      />

      <AdminNumberField
        id="team-max-members"
        label="Players per team"
        help={
          <>
            Enforced when someone joins. Lowering it never removes anyone from a team that is already larger — those
            teams keep their players and simply cannot take another. Blank uses the default ({TEAM_MAX_MEMBERS}).
          </>
        }
        value={teamMaxMembersInput}
        placeholder={String(TEAM_MAX_MEMBERS)}
        min={1}
        max={TEAM_MAX_MEMBERS_MAX}
        disabled={pending}
        status={statusOf("teamMaxMembers")}
        onChange={setTeamMaxMembersInput}
        onBlur={() => commitNumber("teamMaxMembers", teamMaxMembersInput, setTeamMaxMembersInput, "Players per team")}
      />

      <div className="flex flex-col gap-3 border-t border-white/[0.06] pt-4">
        <div>
          <span className="text-white">Schedule (auto dates)</span>
          <span className="block text-sm text-muted">
            Optional. Times are your local time; leave blank for no bound. Scoring
            auto-freezes outside its window; registration auto-closes outside its
            window — on top of the manual toggles above.
          </span>
        </div>
        {/* The EFFECTIVE state, computed from the same fields this section
            edits — manual toggle AND window, via the shared outsideWindow
            (the app's copy of the three-reader contract). Without it the
            organizer does that boolean in their head from four datetime
            fields plus two toggles, mid-event (issue #200, 3.3). Client
            render time is the "now"; it refreshes with every edit. */}
        <p className="text-sm leading-relaxed">
          <span className="uppercase tracking-wider text-muted">Right now: </span>
          <span className={scoringLiveNow ? "text-[#22c55e]" : "text-[#d4a017]"}>
            scoring {scoringLiveNow ? "is live" : settings.paused ? "is frozen (manual)" : "is frozen (outside its window)"}
          </span>
          <span className="text-muted"> · </span>
          <span className={registrationOpenNow ? "text-[#22c55e]" : "text-[#d4a017]"}>
            registration {registrationOpenNow ? "is open" : settings.teamRegistrationOpen ? "is closed (outside its window)" : "is closed (manual)"}
          </span>
        </p>
        <ScheduleField
          key={`ss-${settings.scoringStartsAt ?? ""}`}
          label="Scoring opens"
          value={settings.scoringStartsAt}
          disabled={pending}
          status={statusOf("scoringStartsAt")}
          onCommit={(iso) => applyField("scoringStartsAt", { scoringStartsAt: iso }, "Scoring opens")}
        />
        <ScheduleField
          key={`se-${settings.scoringEndsAt ?? ""}`}
          label="Scoring closes"
          value={settings.scoringEndsAt}
          disabled={pending}
          status={statusOf("scoringEndsAt")}
          onCommit={(iso) => applyField("scoringEndsAt", { scoringEndsAt: iso }, "Scoring closes")}
        />
        <ScheduleField
          key={`rs-${settings.registrationStartsAt ?? ""}`}
          label="Registration opens"
          value={settings.registrationStartsAt}
          disabled={pending}
          status={statusOf("registrationStartsAt")}
          onCommit={(iso) => applyField("registrationStartsAt", { registrationStartsAt: iso }, "Registration opens")}
        />
        <ScheduleField
          key={`re-${settings.registrationEndsAt ?? ""}`}
          label="Registration closes"
          value={settings.registrationEndsAt}
          disabled={pending}
          status={statusOf("registrationEndsAt")}
          onCommit={(iso) => applyField("registrationEndsAt", { registrationEndsAt: iso }, "Registration closes")}
        />
      </div>

      {/* The archive is NOT in the danger zone below, and that is the point
          (audit F13). Half of it — Export — is the safest control on this
          screen: it reads, writes nothing, and is what an organizer runs
          BEFORE anything risky. Painting it the same red as a wipe taught the
          opposite. Import is the dangerous half, and it carries its own
          staged confirmations inside AdminEventControls, which is where that
          warning belongs. */}
      <details className="group flex flex-col gap-3 rounded-md border border-white/10 bg-white/[0.02] p-4">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-white marker:content-none">
          <span className="text-muted transition-transform group-open:rotate-90" aria-hidden="true">
            ›
          </span>
          Event archive — export / import
        </summary>
        <p className="mt-2 text-sm text-muted">
          Export the whole event — Jeopardy, Quiz and AI content plus event policy settings — as one JSON file. Export
          changes nothing; it is worth running before any of the actions below. Import replaces the event wholesale
          from a previously exported file, which runs the same wipe as the master reset, and asks twice before it does.
        </p>
        <div className="mt-3">
          <AdminEventControls showHeading={false} />
        </div>
      </details>

      {/* One section for every control that writes to or wipes the live
          event: the demo seed/clear pair and the master reset. Demo data used
          to sit in a card of its own ABOVE this one, which read as ordinary
          setup — it is not: Seed writes fake contestants, teams and solves
          into the running event, and Clear deletes rows again. The archive
          above stays out of here on purpose (see its own note). */}
      <div className="flex flex-col gap-4 rounded-md border border-[#e53e3e]/30 bg-[#e53e3e]/[0.04] p-4">
        <span className="text-[#e53e3e]">Danger zone</span>

        <div className="flex flex-col gap-3 border-b border-[#e53e3e]/20 pb-4">
          <div>
            <span className="text-white">Demo data</span>
            <span className="block text-sm text-muted">
              Populate the leaderboard with fake contestants, teams, and solves
              to preview the app. Injects real-challenge-id scores so points
              render. It writes to the live event like any other control here,
              which is why it sits in this section — Clear removes the rows it
              added, but the demo questions, challenges and categories Seed
              also wrote stay behind as authored content.
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                setConfirm({
                  title: "Seed demo data?",
                  confirmLabel: "Seed",
                  requireType: "SEED",
                  // Names the authored content it touches, not just the
                  // leaderboard rows: the seed also writes demo questions and
                  // challenges and ADDS to the category lists, which the old
                  // copy left unsaid while a replace was quietly deleting them
                  // (#344). "Adds to" is now literally true — the lists are
                  // unioned — and a master reset genuinely cannot undo it,
                  // since it preserves authored categories on purpose.
                  body:
                    "Adds fake contestants, teams, and solves to the leaderboard, plus demo questions and " +
                    "challenges in the enabled modules. Demo categories are added to your category lists and " +
                    "stay there after a master reset — remove those by hand.",
                  onConfirm: doSeed,
                })
              }
              className="self-start rounded-md border border-[#e53e3e]/40 px-3 py-1.5 text-sm font-medium text-[#e53e3e] hover:bg-[#e53e3e]/10 disabled:opacity-50"
            >
              Seed demo data
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                setConfirm({
                  title: "Clear demo data?",
                  confirmLabel: "Clear",
                  requireType: "CLEAR DEMO DATA",
                  // Sets expectations the same way the Seed body above does:
                  // names exactly what this removes (the fake progress) and
                  // what it deliberately doesn't (the demo questions/
                  // challenges/categories Seed also wrote — those are authored
                  // content now, same as a master reset leaves them).
                  body:
                    "Removes the fake contestants, teams, solves, and sponsors Seed added. Demo questions, " +
                    "challenges, and categories are left in place — remove those by hand from their own admin tab " +
                    "if you don't want them.",
                  onConfirm: doClearDemo,
                })
              }
              className="self-start rounded-md border border-[#e53e3e]/40 px-3 py-1.5 text-sm font-medium text-[#e53e3e] hover:bg-[#e53e3e]/10 disabled:opacity-50"
            >
              Clear demo data
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div>
            <span className="text-white">Master reset</span>
            <span className="block text-sm text-muted">
              Wipes every contestant&apos;s <strong>progress</strong> — teams,
              points, solves, attempts and hint spend — freezes scoring, and
              cannot be undone. It <strong>keeps</strong> everything you
              authored: quiz questions and their answer key, Jeopardy and AI
              challenges with their flags, hints and categories, and every
              setting on this screen. It does rotate the AI launch key, so an
              external challenge site has to re-fetch it. Export the archive
              above first if you want a way back.
            </span>
            <span className="block text-sm text-muted">
              Scores already ingested are gone, but their source is not: a
              scored PR comment stays on GitHub, and the poller reads those
              comments again — so close or clear the source PRs too, or the
              points come back when you unfreeze.
            </span>
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              setConfirm({
                title: "Reset all event data?",
                danger: true,
                confirmLabel: "Wipe everything",
                requireType: eventName,
                body: (
                  <>
                    This permanently deletes every team, score, player record, and
                    hint purchase, and freezes scoring. Your authored content —
                    questions, challenges, flags, hints, categories — and every
                    setting are kept. The AI launch key is rotated, so an external
                    challenge site must re-fetch it. This cannot be undone.
                  </>
                ),
                onConfirm: () => doReset(eventName),
              })
            }
            className="self-start rounded-md border border-[#e53e3e]/40 px-3 py-1.5 text-sm font-medium text-[#e53e3e] hover:bg-[#e53e3e]/10 disabled:opacity-50"
          >
            Reset event data…
          </button>
          {resetInfo && <p className="text-sm text-[#22c55e]">{resetInfo}</p>}
        </div>
      </div>
    </section>
  );
}
