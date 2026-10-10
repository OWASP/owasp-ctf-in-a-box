"use client";

// The Overview screen (admin-redesign.md PR 1): "is scoring on, how many
// teams, is anything stuck" answered in one screen instead of three tabs.
// Replaces the old page-level Status card (folded in here as the sync
// health line) plus the pieces of Event that were really state, not
// settings.
//
// Read-only except the Scoring and Registration switches, which dispatch
// through the exact same `setConfirm` flow admin-event-tab.tsx's rows use —
// same confirmation copy, same settings write — and report the outcome
// beside the row through `applyField`/`statusOf`, under the same status key
// as Event's row for the same setting, so the two screens never disagree.
//
// The team/player/submitted/stuck figures and the activity preview load when
// this becomes the active destination and, while the event phase is live,
// every 15 s after that (use-live-poll.ts — the one loop Activity and
// Insights share), with the stamp on the phase row saying how old the read
// is and whether the loop is running.

import { useCallback, useState } from "react";
import type { AdminSettings, SyncStatus } from "@/lib/admin-store";
import { formatRelativeTime } from "@/lib/relative-time";
import { getRemaining, formatCompact } from "@/lib/countdown";
import type { ModuleSetupContent, ResolvedModule } from "@/lib/modules";
import { phaseBoundaryLabel, phaseFromSettings, PHASE_COLOR } from "@/components/phase";
import { moduleSummary, type ModuleInventory } from "@/components/admin-module-setup";
import AdminSwitch from "@/components/admin-switch";
import type { FieldStatus } from "@/components/admin-number-field";
import { formatWhen, TYPE_LABELS, type ActivityEntry } from "./admin-activity-tab";
import { DEFAULT_EVENT_TIME_ZONE } from "@/lib/event-time";
import { activityZone, UtcToggle, useShowUtc } from "./activity-time-zone";
import AdminLiveStamp from "./admin-live-stamp";
import { FREEZE_HELP, freezeConfirm } from "./freeze-copy";
import { LIVE_POLL_MS, useLivePoll } from "./use-live-poll";
import type { ConfirmState } from "./types";

type Funnel = { onATeam: number; attempted: number; stuck: number };
type MetricsResponse = { funnel: Funnel; teams: unknown[]; error?: string };
type ActivityResponse = { entries?: ActivityEntry[]; total?: number; error?: string };

function Figure({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-md border border-white/[0.06] bg-white/[0.02] p-3">
      <p className={`font-mono text-xl tabular-nums ${warn ? "text-[#d4a017]" : "text-white"}`}>{value}</p>
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
    </div>
  );
}

// "Classic · setup complete · 4 categories · 12 challenges" — the per-module
// line uses the SAME `moduleSummary` the module panel's own status line
// renders from (admin-module-setup.tsx), so the two never disagree about
// what "done" means. Re-exported so the existing tests keep their import.
export { moduleSummary } from "@/components/admin-module-setup";

export default function AdminOverviewTab({
  settings,
  pending,
  applyField,
  statusOf,
  setConfirm,
  nowMs,
  sync,
  modules,
  setups,
  inventory,
  onNavigate,
  visible = false,
}: {
  settings: AdminSettings;
  pending: boolean;
  /** A write that belongs to one row, reported into that row's status
   *  (Saving… / Saved / the refusal) rather than the panel-wide error line. */
  applyField: (key: string, patch: Record<string, unknown>, label: string) => Promise<boolean>;
  statusOf: (key: string) => FieldStatus;
  setConfirm: (c: ConfirmState) => void;
  /** Same "as of" stamp the Event tab's schedule readout uses — see
   *  `settingsAt` in admin-controls.tsx. */
  nowMs: number;
  sync: SyncStatus | null;
  modules: readonly ResolvedModule[];
  setups?: Partial<Record<string, ModuleSetupContent>>;
  inventory: Record<string, ModuleInventory>;
  /** Switches to another destination in this same shell — the sidebar's own
   *  `onSelect`, threaded down so "linking to Activity" etc. is a real state
   *  change, not a second navigation mechanism. */
  onNavigate: (id: string) => void;
  /** This is the active destination. Gates the fetches — see use-live-poll.ts.
   *  Optional so a static render (the tests) fetches nothing. */
  visible?: boolean;
}) {
  const resolution = phaseFromSettings(settings, nowMs);
  const [showUtc, setShowUtc] = useShowUtc();
  const activityRowZone = activityZone(resolution.timeZone ?? DEFAULT_EVENT_TIME_ZONE, showUtc);
  const boundary = phaseBoundaryLabel(resolution.phase, resolution.startsAt, resolution.endsAt, resolution.timeZone);
  const boundaryMs =
    resolution.phase === "registration" && resolution.startsAt
      ? Date.parse(resolution.startsAt)
      : resolution.phase === "live" && resolution.endsAt
        ? Date.parse(resolution.endsAt)
        : NaN;
  const remaining = Number.isFinite(boundaryMs) ? getRemaining(boundaryMs, nowMs) : null;

  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);
  // A failed read says so, in place. Swallowing it would leave "Loading…"
  // standing forever and a missing figures row with no explanation — a
  // screen that lies to the organizer about what it knows.
  const [metricsFailed, setMetricsFailed] = useState(false);
  const [activityFailed, setActivityFailed] = useState(false);

  // Both reads, as one load for the poll loop. A read that fails flips its
  // own flag and leaves the other's result standing; a later successful poll
  // clears the flag again, so a blip is not a permanent red line. Resolves
  // true only when BOTH replaced their data — the stamp says "updated" about
  // the whole screen, so half a refresh does not count.
  // An aborted request (the loop withdrew it — see use-live-poll.ts) touches
  // nothing: not the data, not the failure flag.
  const load = useCallback(async (signal: AbortSignal): Promise<boolean> => {
    const [metricsOk, activityOk] = await Promise.all([
      fetch("/api/admin/metrics", { signal })
        .then((res) => {
          if (!res.ok) throw new Error(`metrics ${res.status}`);
          return res.json();
        })
        .then((data: MetricsResponse) => {
          if (signal.aborted) return false;
          if (data.error) throw new Error(data.error);
          setMetrics(data);
          setMetricsFailed(false);
          return true;
        })
        .catch(() => {
          if (!signal.aborted) setMetricsFailed(true);
          return false;
        }),
      fetch("/api/admin/activity?offset=0&limit=5", { signal })
        .then((res) => {
          if (!res.ok) throw new Error(`activity ${res.status}`);
          return res.json();
        })
        .then((data: ActivityResponse) => {
          if (signal.aborted) return false;
          if (!Array.isArray(data.entries)) throw new Error("no entries");
          setActivity(data.entries);
          setActivityFailed(false);
          return true;
        })
        .catch(() => {
          if (!signal.aborted) setActivityFailed(true);
          return false;
        }),
    ]);
    return metricsOk && activityOk;
  }, []);
  // Whether this event serves Secure Development at all — the only module the
  // sync poller exists for. See the Sync section below.
  const secureDevelopmentPresent = modules.some((mod) => mod.id === "secure-development");
  const eventLive = resolution.phase === "live";
  const { updatedAt } = useLivePoll({ visible, live: eventLive, intervalMs: LIVE_POLL_MS, load });

  const figures = metrics
    ? [
        { label: "Teams", value: metrics.teams.length },
        { label: "Players", value: metrics.funnel.onATeam },
        { label: "Submitted", value: metrics.funnel.attempted },
        { label: "Stuck", value: metrics.funnel.stuck, warn: metrics.funnel.stuck > 0 },
      ]
    : [];
  // Stuck is the one that matters live, so it leads when non-zero.
  const orderedFigures =
    metrics && metrics.funnel.stuck > 0 ? [figures[3], ...figures.slice(0, 3)] : figures;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="rounded-sm border px-1.5 py-0.5 font-mono text-xs uppercase tracking-wider"
            style={{
              color: PHASE_COLOR[resolution.phase],
              borderColor: `${PHASE_COLOR[resolution.phase]}80`,
              background: `${PHASE_COLOR[resolution.phase]}1a`,
            }}
          >
            {resolution.phase}
          </span>
          {boundary && <span className="text-sm text-muted">{boundary}</span>}
          {remaining && <span className="text-sm text-muted">({formatCompact(remaining)} left)</span>}
          <span className="ml-auto">
            <AdminLiveStamp updatedAt={updatedAt} live={eventLive} intervalMs={LIVE_POLL_MS} />
          </span>
        </div>

        {/* Status keys are the stored setting keys (`paused`,
            `teamRegistrationOpen`) — the same ones Event's rows report under —
            so a flip made here shows "Saved" on both screens. */}
        <AdminSwitch
          id="overview-scoring"
          label="Scoring"
          help={FREEZE_HELP}
          checked={!settings.paused}
          disabled={pending}
          status={statusOf("paused")}
          onChange={(on) => {
            const next = !on;
            setConfirm({
              ...freezeConfirm(next),
              onConfirm: () => applyField("paused", { paused: next }, "Scoring"),
            });
          }}
        />

        <AdminSwitch
          id="overview-registration"
          label="Registration"
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
              onConfirm: () => applyField("teamRegistrationOpen", { teamRegistrationOpen: next }, "Registration"),
            });
          }}
        />
      </section>

      {metrics && (
        <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {orderedFigures.map((f) => (
            <Figure key={f.label} label={f.label} value={f.value} warn={f.warn} />
          ))}
        </section>
      )}
      {metricsFailed && (
        <p role="alert" className="text-sm text-[#e53e3e]">
          Couldn&rsquo;t load the team and submission figures — the Insights tab&rsquo;s Compute metrics will say why.
        </p>
      )}

      {/* Sync polls contestants' forks for Secure Development score comments.
          An event without that module has no forks and no poller, so the whole
          section is absent rather than reporting "Sync not running." — which,
          on a quiz-only event, was the first line of the admin page and read
          as a broken box forever (audit F27). With the module present, that
          same line is a real warning and still shows. */}
      {secureDevelopmentPresent && (
      <section className="flex flex-col gap-1.5">
        <h3 className="text-sm font-semibold text-white">Sync</h3>
        {sync ? (
          <details>
            {/* The one-line health check; the full breakdown — the whole old
                Status card — sits behind the disclosure. */}
            <summary className="cursor-pointer text-sm text-muted">
              last poll {sync.lastPollAt ? formatRelativeTime(sync.lastPollAt) : "never"} · ingested {sync.ingested} ·{" "}
              <span className={sync.dropped > 0 ? "text-[#d4a017]" : undefined}>dropped {sync.dropped}</span> ·{" "}
              {sync.paused ? "paused" : "running"}
            </summary>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">Last poll</dt>
                <dd className="font-mono text-white">{sync.lastPollAt ? formatRelativeTime(sync.lastPollAt) : "never"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">Ingested</dt>
                <dd className="font-mono tabular-nums text-white">{sync.ingested}</dd>
              </div>
              {/* Beside Ingested on purpose: the pair is the whole health
                  check. Amber only when nonzero — a warning colour on a
                  permanent zero teaches organizers to ignore the colour. */}
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">Dropped</dt>
                <dd className={`font-mono tabular-nums ${sync.dropped > 0 ? "text-[#d4a017]" : "text-white"}`}>
                  {sync.dropped}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">Repos polled</dt>
                <dd className="font-mono tabular-nums text-white">{sync.reposPolled}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">Sync paused</dt>
                <dd className="font-mono text-white">{sync.paused ? "yes" : "no"}</dd>
              </div>
              {sync.lastDrop && (
                <div className="col-span-2 sm:col-span-5">
                  <dt className="text-xs uppercase tracking-wide text-muted">Last drop</dt>
                  <dd className="font-mono text-xs text-[#d4a017]">{sync.lastDrop}</dd>
                </div>
              )}
              {sync.lastError && (
                <div className="col-span-2 sm:col-span-5">
                  <dt className="text-xs uppercase tracking-wide text-muted">Last error</dt>
                  <dd className="font-mono text-xs text-[#e53e3e]">{sync.lastError}</dd>
                </div>
              )}
            </dl>
          </details>
        ) : (
          <p className="text-sm text-muted">
            Sync not running — no poller has reported in, so Secure Development scores are not being ingested.
          </p>
        )}
      </section>
      )}

      <section className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Recent activity</h3>
          <div className="flex items-center gap-4">
            <UtcToggle checked={showUtc} onChange={setShowUtc} />
            <button
              type="button"
              onClick={() => onNavigate("activity")}
              className="text-sm text-zinc-400 transition-colors hover:text-white"
            >
              View all
            </button>
          </div>
        </div>
        {activity && activity.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm text-zinc-300">
            {activity.map((e, i) => (
              <li key={`${e.at}-${e.type}-${e.login}-${i}`} className="flex gap-2">
                <span className="font-mono tabular-nums text-muted">{formatWhen(e.at, activityRowZone)}</span>
                <span>{TYPE_LABELS[e.type] ?? e.type}</span>
                <span className="font-mono text-white">{e.login}</span>
              </li>
            ))}
          </ul>
        ) : activityFailed ? (
          <p role="alert" className="text-sm text-[#e53e3e]">
            Couldn&rsquo;t load the activity log — open Activity and try Load activity.
          </p>
        ) : (
          <p className="text-sm text-muted">{activity ? "Nothing recorded yet." : "Loading…"}</p>
        )}
      </section>

      <section className="flex flex-col gap-1.5">
        <h3 className="text-sm font-semibold text-white">Modules</h3>
        <ul className="flex flex-col gap-1">
          {modules.map((mod) => (
            <li key={mod.id}>
              <button
                type="button"
                onClick={() => onNavigate(mod.id)}
                className="text-sm text-zinc-300 transition-colors hover:text-white"
              >
                {mod.title} · {moduleSummary(setups?.[mod.id], inventory[mod.id])}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
