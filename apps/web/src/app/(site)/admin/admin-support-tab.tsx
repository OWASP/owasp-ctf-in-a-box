"use client";

// Live-event support: act on ONE contestant or ONE team (issue #168).
//
// Before this, the only destructive control in the panel was the master reset,
// so an organizer facing a single stuck contestant chose between doing nothing
// and wiping the event. This tab is the missing middle.
//
// Find first, then act. The organizer searches by name (GET
// /api/admin/players), picks a row, and every action after that carries the
// chosen row's player id, never a typed name. Every destructive control stays
// disabled until that player's lookup has returned, because the whole failure
// mode this tab has to avoid is an organizer resetting the wrong person while
// a room waits. Seeing the score you are about to delete is the guard.
//
// Self-contained state, same reasoning as admin-admins-tab: this talks to its
// own endpoints with their own shapes, and folding it into the shell's shared
// settings `apply` would make that helper mean two different things.

import { useRef, useState } from "react";
import type { ConfirmState } from "./types";
import AdminAdjustments from "./admin-adjustments";
import { adminTime } from "@/lib/event-time";

/** The shape `GET /api/admin/ops/user` answers with — mirrors `UserDetail` in
 *  lib/admin-ops-store.ts (a value import would drag `server-only` into the
 *  client bundle). Exported so the pure builders below can be tested against
 *  a hand-built record. */
export type UserDetail = {
  id: string;
  name: string;
  team: { slug: string; name: string; captain: string | null; isCaptain: boolean; joinedAt: string | null } | null;
  firstTeamAt: string | null;
  quiz: { answered: number; points: number; attempts: number };
  classic: { solved: number; points: number; attempts: number };
  ai: { solved: number; points: number; attempts: number };
  secureDev: { solves: number };
  hints: { bought: number; spent: number };
  known: boolean;
};

/** One search result: what `GET /api/admin/players` answers per player. */
export type PlayerRow = { id: string; name: string; image: string | null };

/** The search request for what the organizer typed. */
export function playerSearchUrl(query: string): string {
  return `/api/admin/players?q=${encodeURIComponent(query.trim())}`;
}

/** The lookup request for a chosen player. */
export function lookupUrl(id: string): string {
  return `/api/admin/ops/user?id=${encodeURIComponent(id)}`;
}

/** The JSON body of every per-player action: the chosen player's id plus the
 *  action's own fields. The id is the only way a player is named to the
 *  server, so a display name can never select the wrong account. */
export function playerActionBody(detail: Pick<UserDetail, "id">, extra: Record<string, unknown>): string {
  return JSON.stringify({ id: detail.id, ...extra });
}

/** The figures the contestant card shows, in reading order — every module
 *  the reset below touches (quiz, classic, ai) plus Secure Development and
 *  hints. Pure, so a test can prove the AI figures are present without a
 *  lookup having returned (UX audit F4: the card had none). Exported for
 *  direct testing. */
export function contestantStats(detail: UserDetail): { label: string; value: number }[] {
  return [
    { label: "Quiz pts", value: detail.quiz.points },
    { label: "Jeopardy pts", value: detail.classic.points },
    { label: "AI pts", value: detail.ai.points },
    { label: "Quiz answered", value: detail.quiz.answered },
    { label: "Jeopardy solved", value: detail.classic.solved },
    { label: "AI solved", value: detail.ai.solved },
    { label: "Secure Development solves", value: detail.secureDev.solves },
    { label: "Attempts", value: detail.quiz.attempts + detail.classic.attempts + detail.ai.attempts },
    { label: "Hints bought", value: detail.hints.bought },
    { label: "Hints spend", value: detail.hints.spent },
  ];
}

/** The reset-progress confirmation, with the total the reset will actually
 *  remove: quiz, classic AND ai points — `resetUserProgress` clears all three
 *  (admin-ops-store.ts). The Secure Development warning is separate because
 *  it is the part the organizer has to act on, and it only applies when there
 *  are such solves. Exported for direct testing. */
export function resetProgressConfirm(detail: UserDetail): {
  title: string;
  requireType: string;
  confirmLabel: string;
  body: string;
  warning: string | null;
} {
  const total = detail.quiz.points + detail.classic.points + detail.ai.points;
  return {
    title: `Reset ${detail.name}'s progress?`,
    requireType: detail.name,
    confirmLabel: "Reset progress",
    body: `Clears their quiz answers, classic and AI solves, attempts and hints — ${total} points in total. Their account and team stay.`,
    warning:
      detail.secureDev.solves > 0
        ? `Their ${detail.secureDev.solves} Secure Development solves are re-ingested from PR comments and will come back if that PR is scored again.`
        : null,
  };
}

/** The two things the contestant card says about their team, built purely so
 *  they are provable: the card itself sits behind a lookup and never appears
 *  in a static render (see this file's test header).
 *
 *  `joined` states UTC. Every other timestamp on this tab does — the line
 *  directly beneath this one says so — and a bare "2026-09-03 01:45" beside it
 *  invites the reader to assume local (audit F21).
 *
 *  `actionSlug` is the slug the card already holds. The team actions further
 *  down took it hand-typed, so the commonest ticket on this tab ("the captain
 *  vanished") began by retyping a slug from the line above. Null for a
 *  contestant on no team, which is what hides the control. Exported for direct
 *  testing. */
/** The player card's team control: Add for a teamless player, Move for
 *  one already on a team. Works whatever the registration state. */
export function addToTeamLabel(team: { slug: string } | null): "Add to team" | "Move to team" {
  return team ? "Move to team" : "Add to team";
}

/** The notice after an add or move, naming the team they came from. */
export function addToTeamNotice(data: { name: string; from: string | null }, slug: string): string {
  return data.from ? `Moved ${data.name} from ${data.from} to ${slug}.` : `Added ${data.name} to ${slug}.`;
}

export function teamCardSummary(detail: UserDetail): { joined: string | null; actionSlug: string | null } {
  return {
    joined: detail.team?.joinedAt ? `joined ${adminTime(detail.team.joinedAt, "UTC", { year: true })}` : null,
    actionSlug: detail.team?.slug ?? null,
  };
}

const FIELD =
  "w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm text-white placeholder:text-muted focus-visible:border-[#d4a017]/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]";
// Both action styles carry a DESIGNED disabled state, not an opacity fade.
// Every control on this tab is disabled at rest (nothing is actionable until
// a lookup returns or both team fields are filled), so the disabled state is
// the one an organizer sees on arrival — and the old pair sent opposite
// signals for the same gating: a solid-blue "Transfer captaincy" that looked
// live next to a faded "Disband team" that looked dead (issue #200, 3.2).
// Same treatment as team-card.tsx's PAIRED_ACTION_CLASS, the #195 fix.
const BTN =
  "flex-none rounded-md bg-[#2563eb] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#1d4ed8] " +
  "disabled:cursor-not-allowed disabled:border disabled:border-white/10 disabled:bg-transparent disabled:text-zinc-500";
const DANGER =
  "flex-none rounded-md border border-[#e53e3e]/50 px-3 py-1.5 text-sm text-[#e53e3e] transition-colors hover:bg-[#e53e3e]/10 " +
  "disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-transparent disabled:text-zinc-500";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="font-mono text-sm tabular-nums text-white">{value}</p>
    </div>
  );
}

export default function AdminSupportTab({
  setConfirm,
}: {
  setConfirm: (c: ConfirmState | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlayerRow[] | null>(null);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [teamSlug, setTeamSlug] = useState("");
  /** The team-actions slug field, so the contestant card can hand it the
   *  slug it already knows and put the cursor there (audit F21). */
  const teamSlugRef = useRef<HTMLInputElement>(null);
  const [addSlug, setAddSlug] = useState("");
  const [addOverride, setAddOverride] = useState(false);

  /** Runs a request and folds the outcome into the shared notice/error state.
   *  `after` re-reads the contestant when one is on screen, so the panel never
   *  shows a score that an action on this very tab just deleted. */
  async function run(
    fn: () => Promise<Response>,
    describe: (data: Record<string, unknown>) => string,
    after?: () => Promise<void>,
  ) {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fn();
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Request failed");
        return;
      }
      setNotice(describe(data));
      if (after) await after();
    } catch {
      setError("Request failed");
    } finally {
      setPending(false);
    }
  }

  async function search() {
    if (!query.trim()) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(playerSearchUrl(query));
      const data = (await res.json().catch(() => ({}))) as { players?: PlayerRow[]; error?: string };
      if (!res.ok || !Array.isArray(data.players)) {
        setError(data.error ?? "Search failed");
        setResults(null);
        return;
      }
      setResults(data.players);
    } catch {
      setError("Search failed");
      setResults(null);
    } finally {
      setPending(false);
    }
  }

  async function lookup(id: string) {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(lookupUrl(id));
      const data = (await res.json().catch(() => ({}))) as UserDetail & { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Lookup failed");
        setDetail(null);
        return;
      }
      setDetail(data);
    } catch {
      setError("Lookup failed");
      setDetail(null);
    } finally {
      setPending(false);
    }
  }

  const refresh = async () => {
    if (detail) await lookup(detail.id);
  };

  /** Warnings the server returns (the Secure Development re-ingest caveat)
   *  ride along with the success notice — they are the part an organizer has
   *  to act on, so they must not be swallowed by a cheerful "done". */
  const withWarnings = (base: string, data: Record<string, unknown>) => {
    const warnings = Array.isArray(data.warnings) ? (data.warnings as string[]) : [];
    return warnings.length ? `${base} — ${warnings.join(" ")}` : base;
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white">Find a contestant</h3>
          <p className="text-sm text-muted">
            Search by name, then pick the player. Every control below stays disabled until you have picked one.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            id="support-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void search();
            }}
            placeholder="Name or GitHub login"
            aria-label="Name or GitHub login"
            className={FIELD}
          />
          <button type="button" disabled={pending || !query.trim()} onClick={() => void search()} className={BTN}>
            Search
          </button>
        </div>
        {results && results.length === 0 && <p className="text-sm text-muted">No player matches that name.</p>}
        {results && results.length > 0 && (
          <ul className="flex flex-col gap-1" aria-label="Matching players">
            {results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  disabled={pending}
                  aria-pressed={detail?.id === p.id}
                  onClick={() => void lookup(p.id)}
                  className="flex w-full items-center gap-2 rounded-md border border-white/10 px-2.5 py-1.5 text-left text-sm text-zinc-300 transition-colors hover:border-[#2563eb]/60 hover:text-white aria-pressed:border-[#2563eb]/60 aria-pressed:text-white disabled:opacity-40"
                >
                  {p.image && (
                    // eslint-disable-next-line @next/next/no-img-element -- a GitHub avatar URL, not a local asset to optimize
                    <img src={p.image} alt="" width={20} height={20} className="h-5 w-5 rounded-full" />
                  )}
                  <bdi className="font-mono">{p.name}</bdi>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail && (
        <section className="flex flex-col gap-3 rounded-md border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="flex items-center justify-between gap-2">
            <bdi className="font-mono text-white">{detail.name}</bdi>
            {!detail.known && (
              <span className="rounded border border-[#d4a017]/40 bg-[#d4a017]/10 px-1.5 py-0.5 text-xs uppercase tracking-wide text-[#d4a017]">
                no data yet
              </span>
            )}
          </div>

          <p className="text-sm text-zinc-400">
            {detail.team ? (
              <>
                Team <bdi className="font-mono text-white">{detail.team.name}</bdi>
                <span className="text-muted"> ({detail.team.slug})</span>
                {detail.team.isCaptain && <span className="text-[#d4a017]"> — captain</span>}
              </>
            ) : (
              "On no team."
            )}
            {teamCardSummary(detail).joined && (
              <span className="text-muted"> — {teamCardSummary(detail).joined}</span>
            )}
          </p>

          {/* The card already holds the slug; the team actions below took it
              hand-typed. The common ticket ("the captain vanished") started
              with retyping a slug from the line directly above (audit F21).
              This fills that field and puts the cursor in it, and deliberately
              stops there: Disband and Transfer keep their confirmations where
              they are rather than gaining a second trigger on a card whose
              subject is a person, not a team. */}
          {detail.team && (
            <p>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  const slug = teamCardSummary(detail).actionSlug;
                  if (!slug) return;
                  setTeamSlug(slug);
                  teamSlugRef.current?.focus();
                }}
                className="rounded-md border border-white/10 px-2.5 py-1 text-sm text-zinc-300 transition-colors hover:border-[#2563eb]/60 hover:text-white disabled:opacity-40"
              >
                Team actions for {detail.team.slug}
              </button>
            </p>
          )}

          {detail.firstTeamAt && (
            <p className="text-sm text-muted">
              First on a team {adminTime(detail.firstTeamAt, "UTC", { year: true })}
              {detail.team?.joinedAt && detail.firstTeamAt !== detail.team.joinedAt && " (has switched teams since)"}
            </p>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {contestantStats(detail).map((s) => (
              <Stat key={s.label} label={s.label} value={s.value} />
            ))}
          </div>

          <div className="flex flex-wrap gap-2 border-t border-white/[0.06] pt-3">
            <button
              type="button"
              disabled={pending}
              className={DANGER}
              onClick={() => {
                const c = resetProgressConfirm(detail);
                setConfirm({
                  title: c.title,
                  danger: true,
                  requireType: c.requireType,
                  confirmLabel: c.confirmLabel,
                  body: (
                    <>
                      {c.body}
                      {c.warning && (
                        <>
                          {" "}
                          <strong>{c.warning}</strong> Close the PR or freeze scoring to make this stick.
                        </>
                      )}
                    </>
                  ),
                  onConfirm: () =>
                    run(
                      () =>
                        fetch("/api/admin/ops/user", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: playerActionBody(detail, { action: "reset" }),
                        }),
                      (data) => withWarnings(`Reset ${detail.name}.`, data),
                      refresh,
                    ),
                });
              }}
            >
              Reset progress
            </button>

            <button
              type="button"
              disabled={pending}
              className={DANGER}
              onClick={() =>
                setConfirm({
                  title: `Delete ${detail.name}?`,
                  danger: true,
                  requireType: detail.name,
                  confirmLabel: "Delete contestant",
                  body: (
                    <>
                      Removes their progress, hints, team membership and account record. This cannot be undone.
                      {detail.team?.isCaptain && (
                        <>
                          {" "}
                          <strong>
                            They captain &ldquo;<bdi>{detail.team.name}</bdi>&rdquo; — transfer the captaincy or disband that team first.
                          </strong>
                        </>
                      )}
                    </>
                  ),
                  onConfirm: () =>
                    run(
                      () =>
                        fetch("/api/admin/ops/user", {
                          method: "DELETE",
                          headers: { "Content-Type": "application/json" },
                          body: playerActionBody(detail, {}),
                        }),
                      (data) => withWarnings(`Deleted ${detail.name}.`, data),
                      async () => {
                        setDetail(null);
                        setResults(null);
                      },
                    ),
                })
              }
            >
              Delete contestant
            </button>

            {detail.team && !detail.team.isCaptain && (
              <button
                type="button"
                disabled={pending}
                className={DANGER}
                onClick={() =>
                  setConfirm({
                    title: `Remove ${detail.name} from ${detail.team?.name}?`,
                    danger: true,
                    confirmLabel: "Remove from team",
                    body: <>Their progress is kept — only the membership goes.</>,
                    onConfirm: () =>
                      run(
                        () =>
                          fetch("/api/admin/ops/team", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: playerActionBody(detail, { slug: detail.team?.slug, action: "remove-member" }),
                          }),
                        () => `Removed ${detail.name} from ${detail.team?.slug}.`,
                        refresh,
                      ),
                  })
                }
              >
                Remove from team
              </button>
            )}
          </div>

          {/* The way back for a player who left after registration
              closed (they can't rejoin on their own), and a move between
              teams. Same atomic checks as a join; the cap applies unless
              overridden. */}
          <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3">
            <label htmlFor="support-add-slug" className="text-sm text-zinc-400">
              {addToTeamLabel(detail.team)}
            </label>
            <input
              id="support-add-slug"
              value={addSlug}
              onChange={(e) => setAddSlug(e.target.value)}
              placeholder="team slug"
              className="w-40 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-sm text-white focus-visible:border-[#d4a017]/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
            />
            <label className="flex items-center gap-1.5 text-sm text-zinc-400">
              <input type="checkbox" checked={addOverride} onChange={(e) => setAddOverride(e.target.checked)} />
              over the team-size cap
            </label>
            <button
              type="button"
              disabled={pending || !addSlug.trim()}
              className={BTN}
              onClick={() => {
                const slug = addSlug.trim();
                void run(
                  () =>
                    fetch("/api/admin/ops/team", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: playerActionBody(detail, { slug, action: "add-member", overrideCap: addOverride }),
                    }),
                  (data) =>
                    addToTeamNotice(
                      { name: typeof data.name === "string" ? data.name : detail.name, from: typeof data.from === "string" ? data.from : null },
                      slug,
                    ),
                  async () => {
                    setAddSlug("");
                    setAddOverride(false);
                    await refresh();
                  },
                );
              }}
            >
              {addToTeamLabel(detail.team)}
            </button>
          </div>
        </section>
      )}

      <section className="flex flex-col gap-3 border-t border-white/[0.06] pt-5">
        <div>
          <h3 className="text-sm font-semibold text-white">Team actions</h3>
          <p className="text-sm text-muted">
            The captain-only controls, for when the captain is unreachable — a captainless team
            cannot rename, remove anyone, regenerate its code, or disband on its own. To hand a
            team over, find the new captain above first.
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="support-team-slug"
            ref={teamSlugRef}
            value={teamSlug}
            onChange={(e) => setTeamSlug(e.target.value)}
            placeholder="team-slug"
            aria-label="Team slug"
            className={FIELD}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending || !teamSlug.trim() || !detail}
            className={BTN}
            onClick={() => {
              if (!detail) return;
              setConfirm({
                title: `Make ${detail.name} captain of ${teamSlug.trim()}?`,
                confirmLabel: "Transfer captaincy",
                body: <>They must already be a member of that team.</>,
                onConfirm: () =>
                  run(
                    () =>
                      fetch("/api/admin/ops/team", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: playerActionBody(detail, { slug: teamSlug.trim(), action: "transfer-captain" }),
                      }),
                    () => `${detail.name} now captains ${teamSlug.trim()}.`,
                    refresh,
                  ),
              });
            }}
          >
            {detail ? `Make ${detail.name} captain` : "Transfer captaincy"}
          </button>

          <button
            type="button"
            disabled={pending || !teamSlug.trim()}
            className={DANGER}
            onClick={() =>
              setConfirm({
                title: `Disband ${teamSlug.trim()}?`,
                danger: true,
                requireType: teamSlug.trim(),
                confirmLabel: "Disband team",
                body: (
                  <>
                    Every member is released and the join code stops working. Nobody&rsquo;s points are
                    deleted — solves are per contestant, so the players keep what they earned and can
                    regroup.
                  </>
                ),
                onConfirm: () =>
                  run(
                    () =>
                      fetch("/api/admin/ops/team", {
                        method: "DELETE",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ slug: teamSlug.trim() }),
                      }),
                    (data) => `Disbanded ${teamSlug.trim()} (${String(data.members ?? 0)} released).`,
                    refresh,
                  ),
              })
            }
          >
            Disband team
          </button>
        </div>
      </section>

      <AdminAdjustments />

      {error && <p className="text-sm text-[#e53e3e]">{error}</p>}
      {notice && <p className="text-sm text-[#22c55e]">{notice}</p>}
    </div>
  );
}
