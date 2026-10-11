"use client";

// Team join/create/leave control on the profile page. All writes go through
// the /api/team route handlers, which authenticate the session and enforce
// the team-size cap server-side (see src/lib/team-store.ts) — this component
// is display + dispatch only.

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { TeamInfo } from "@/lib/team-store";

type TeamActionResponse = { error?: string; code?: string };

async function postTeam(path: string, body?: Record<string, string>): Promise<TeamActionResponse> {
  const res = await fetch(`/api/team${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json().catch(() => ({}))) as TeamActionResponse;
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

/** The two captain buttons that sit BESIDE an input — Rename and Transfer.
 *
 *  They are disabled until their field has a value, which means **disabled is
 *  their resting state**: an organizer opening the team card sees them before
 *  they see the input. Sharing the generic button style meant they arrived at
 *  50% opacity on top of an already-dim `text-zinc-300`, and stopped reading
 *  as controls at all — the reported symptom was "there is no rename option",
 *  from someone looking straight at it.
 *
 *  So a disabled state here keeps its border and stays legible: dimmer than
 *  live, still obviously a button, with a cursor that says why it will not
 *  respond. The neighbouring buttons (Regenerate, Disband) are only disabled
 *  while a request is in flight, so they never spend their idle life looking
 *  like this and are deliberately left alone.
 *
 *  Same family of bug as the OWASP badges in #156: a control that is only
 *  discoverable once you already know it is there is not discoverable. */
const PAIRED_ACTION_CLASS =
  "flex-none rounded-md border border-white/20 bg-white/[0.04] px-3 py-1.5 text-xs text-zinc-200 " +
  "transition-colors hover:border-[#2563eb]/60 hover:bg-white/[0.06] hover:text-white " +
  "disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-transparent disabled:text-zinc-500";

export default function TeamCard({
  team,
  writesEnabled,
  maxMembers,
  isCaptain,
  captain,
  joinCode,
  registrationOpen = true,
}: {
  team: TeamInfo | null;
  writesEnabled: boolean;
  maxMembers: number;
  /** True when the signed-in viewer is this team's captain. Always false
   *  outside live mode — there's no captain concept for the mock cookie. */
  isCaptain: boolean;
  /** The team's captain login, when known (live mode only). Used to keep the
   *  captain out of "remove"/"transfer to" target lists. */
  captain: string | null;
  /** The team's current join code, when known (live mode only). Shown so any
   *  member — captain included — can share it to recruit teammates. */
  joinCode: string | null;
  /** Resolved on the server (effectiveRegistrationOpen). When closed, the
   *  teamless branch explains instead of rendering forms the routes would
   *  refuse — the same read-and-explain the /join/<code> page does. Defaults
   *  open, matching the routes' own fail-open settings read. */
  registrationOpen?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joinValue, setJoinValue] = useState("");
  const [createValue, setCreateValue] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [transferTarget, setTransferTarget] = useState("");
  const [confirmingDisband, setConfirmingDisband] = useState(false);
  const [latestCode, setLatestCode] = useState<string | null>(null);

  const run = async (fn: () => Promise<TeamActionResponse>) => {
    setPending(true);
    setError(null);
    try {
      const result = await fn();
      if (result.code) setLatestCode(result.code);
      setJoinValue("");
      setCreateValue("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setPending(false);
    }
  };

  const displayCode = latestCode ?? joinCode;
  const [copied, setCopied] = useState(false);
  const otherMembers = (team?.members ?? []).filter((member) => member !== captain);

  return (
    <div className="ds-card rounded-lg border border-white/[0.06] bg-[#16162a] p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Team</h2>
        {!writesEnabled && (
          <span className="rounded border border-[#d4a017]/40 bg-[#d4a017]/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[#d4a017]">
            mock mode
          </span>
        )}
      </div>

      {team ? (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="truncate font-mono text-white"><bdi>{team.name}</bdi></p>
              {team.slug !== team.name && (
                <p className="truncate text-xs text-muted">slug: {team.slug}</p>
              )}
            </div>
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => postTeam("/leave"))}
              className="flex-none rounded-md border border-white/10 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-[#e53e3e]/50 hover:text-white disabled:opacity-50"
            >
              Leave team
            </button>
          </div>

          {displayCode && (
            <div className="flex flex-col gap-2 rounded-md border border-[#2563eb]/30 bg-white/[0.06] px-3 py-2">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted">Share this join code</p>
                <p className="font-mono text-lg tracking-widest text-white">{displayCode}</p>
              </div>
              {/* The same code as a link (issue #45), so a captain can paste
                  one thing into chat instead of spelling six characters across
                  a noisy room. Built from window.location.origin rather than a
                  configured URL: whatever host the captain is actually using
                  is the host their teammates can reach. */}
              <button
                type="button"
                onClick={() => {
                  const url = `${window.location.origin}/join/${encodeURIComponent(displayCode)}`;
                  void navigator.clipboard?.writeText(url).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  );
                }}
                className="self-start rounded border border-white/10 px-2 py-1 font-mono text-[11px] text-zinc-300 transition-colors hover:border-[#2563eb]/60 hover:text-white"
              >
                {copied ? "Link copied" : "Copy invite link"}
              </button>
            </div>
          )}

          {team.members.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {team.members.map((member) => (
                  <span
                    key={member}
                    className="flex items-center gap-1.5 rounded-full border border-white/10 bg-[#12121e] px-2.5 py-1 font-mono text-xs text-zinc-300"
                  >
                    {member}
                    {member === captain && <span className="text-[10px] uppercase text-[#d4a017]">captain</span>}
                    {isCaptain && member !== captain && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => run(() => postTeam("/remove", { slug: team.slug, member }))}
                        className="text-[#e53e3e] hover:text-white disabled:opacity-50"
                        aria-label={`Remove ${member}`}
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
                <span className="text-xs text-muted">
                  {team.members.length} / {maxMembers} players
                </span>
              </div>
            </div>
          )}

          {isCaptain && (
            <div className="flex flex-col gap-3 rounded-md border border-white/10 bg-white/[0.02] p-3">
              <p className="text-[10px] uppercase tracking-wide text-muted">Captain controls</p>

              <div className="flex gap-2">
                <input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  placeholder="New team name"
                  className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm text-white placeholder:text-muted focus-visible:border-[#d4a017]/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
                />
                <button
                  type="button"
                  disabled={pending || !renameValue.trim()}
                  onClick={() => run(() => postTeam("/rename", { slug: team.slug, name: renameValue }))}
                  className={PAIRED_ACTION_CLASS}
                >
                  Rename
                </button>
              </div>

              {otherMembers.length > 0 && (
                <div className="flex gap-2">
                  <select
                    value={transferTarget}
                    onChange={(e) => setTransferTarget(e.target.value)}
                    className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm text-white focus-visible:border-[#d4a017]/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
                  >
                    <option value="">Transfer captain to…</option>
                    {otherMembers.map((member) => (
                      <option key={member} value={member}>
                        {member}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={pending || !transferTarget}
                    onClick={() => run(() => postTeam("/transfer", { slug: team.slug, to: transferTarget }))}
                    className={PAIRED_ACTION_CLASS}
                  >
                    Transfer
                  </button>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => postTeam("/regen-code", { slug: team.slug }))}
                  className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:border-[#2563eb]/60 hover:text-white disabled:opacity-50"
                >
                  Regenerate join code
                </button>

                {confirmingDisband ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-300">Disband this team?</span>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => run(() => postTeam("/disband", { slug: team.slug }))}
                      className="rounded-md border border-[#e53e3e]/50 px-3 py-1.5 text-xs text-[#e53e3e] hover:bg-[#e53e3e]/10 disabled:opacity-50"
                    >
                      Confirm disband
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => setConfirmingDisband(false)}
                      className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:text-white disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => setConfirmingDisband(true)}
                    className="rounded-md border border-[#e53e3e]/50 px-3 py-1.5 text-xs text-[#e53e3e] hover:bg-[#e53e3e]/10 disabled:opacity-50"
                  >
                    Disband team
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      ) : !registrationOpen ? (
        // Registration closed and the viewer has no team: forms would only
        // collect a refusal from the routes, so explain instead (issue #217).
        // The team requirement still holds — say both halves plainly.
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-sm text-zinc-400">Team registration is closed for this event.</p>
          <p className="text-xs text-muted">
            A team is still required before anything you solve counts — find an organizer if you
            arrived after registration closed.
          </p>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {/* Not "create or join a team to compete" any more: a team is now
              required before anything scores (issue #153), and the copy has to
              say so or a contestant reads this as an optional extra and
              wonders later why nothing counted. */}
          <p className="text-sm text-zinc-400">
            You need a team before anything you solve counts. Join one, create one, or play solo.
          </p>

          <div className="flex flex-col gap-1">
            <label htmlFor="team-join-code" className="text-[10px] uppercase tracking-wide text-muted">
              Join code
            </label>
            <div className="flex gap-2">
              <input
                id="team-join-code"
                value={joinValue}
                onChange={(e) => setJoinValue(e.target.value)}
                placeholder="Join code"
                className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm text-white placeholder:text-muted focus-visible:border-[#d4a017]/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
              />
              <button
                type="button"
                disabled={pending || !joinValue.trim()}
                onClick={() => run(() => postTeam("/join", { code: joinValue }))}
                className="flex-none rounded-md bg-[#2563eb] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#1d4ed8] disabled:opacity-50"
              >
                Join
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="team-create-name" className="text-[10px] uppercase tracking-wide text-muted">
              Team name
            </label>
            <div className="flex gap-2">
              <input
                id="team-create-name"
                value={createValue}
                onChange={(e) => setCreateValue(e.target.value)}
                placeholder="Team name"
                className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm text-white placeholder:text-muted focus-visible:border-[#d4a017]/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
              />
              <button
                type="button"
                disabled={pending || !createValue.trim()}
                onClick={() => run(() => postTeam("", { name: createValue }))}
                className="flex-none rounded-md bg-[#2563eb] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#1d4ed8] disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </div>

          {/* A solo player is a team of one — the kit has always said so, and
              now that a team is mandatory, saying it is not enough: without
              this the cheapest way to play alone is to invent a team name,
              which is a naming decision imposed on the one person who has
              explicitly opted out of having teammates. The server derives the
              name from their login; there is nothing to type. */}
          <div className="flex flex-col gap-1 border-t border-white/[0.06] pt-3">
            <p className="text-xs text-muted">Playing on your own?</p>
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => postTeam("/solo"))}
              className="w-fit rounded-md border border-white/10 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-[#2563eb]/60 hover:text-white disabled:opacity-50"
            >
              Play solo
            </button>
          </div>
        </div>
      )}

      {/* role="alert" so a rejected create/join/leave is announced. This is
          the only feedback the action produces — the form does not move focus
          — so without it the button click was silent for a screen reader and
          the team simply never appeared. Matches join-team-invite.tsx, which
          already announces its own. */}
      {error && (
        <p role="alert" className="mt-2 text-xs text-[#e53e3e]">
          {error}
        </p>
      )}
    </div>
  );
}
