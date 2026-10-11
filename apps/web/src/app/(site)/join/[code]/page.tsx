// Shareable team-join link (issue #45).
//
// A captain sends `/join/<code>` instead of dictating six characters over a
// noisy room. The page RESOLVES the code and shows which team it belongs to;
// the join itself is a POST from the button, never a side effect of the GET.
// A link preview or a prefetch must never put someone on a team.
//
// The code lives in the PATH rather than a query string so it survives the
// GitHub sign-in round-trip as the callback URL, with nothing to stash and
// nothing to lose.

import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import JoinTeamInvite from "@/components/join-team-invite";
import PageHeader from "@/components/page-header";
import { getViewerTeam, lookupJoinCode, TEAM_WRITES_ENABLED } from "@/lib/team-store";
import { getAdminSettings, effectiveRegistrationOpen } from "@/lib/admin-store";

export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  const login = (session?.user as { login?: string } | undefined)?.login;

  const [team, settings] = await Promise.all([
    // A failed lookup is "unreadable", not "expired" (#499): the code may be
    // perfectly good, and asking the captain for another would fail the same way.
    lookupJoinCode(code).catch(() => "unreadable" as const),
    getAdminSettings().catch(() => null),
  ]);

  // Teams are a live-store feature; with writes disabled there is nothing a
  // code can resolve to and the honest answer is "not available here".
  if (!TEAM_WRITES_ENABLED) {
    return (
      <Shell title="Team invite">
        <p className="text-sm text-zinc-400">Team joining is not enabled for this event.</p>
      </Shell>
    );
  }

  if (team === "unreadable") {
    return (
      <Shell title="Team invite">
        <p className="text-sm text-zinc-400">
          We could not check this invite just now. Reload the page in a moment — the link itself may be fine.
        </p>
      </Shell>
    );
  }

  if (!team) {
    return (
      <Shell title="Invite not found">
        <p className="text-sm text-zinc-400">
          That join link is invalid or has expired. Ask your captain for a fresh one — regenerating the
          code invalidates the old link.
        </p>
      </Shell>
    );
  }

  // Checked here as well as in the API. The route is the enforcement; this is
  // so a contestant arriving after registration closed reads why, instead of
  // clicking a button that refuses them.
  const registrationOpen = settings === null ? true : effectiveRegistrationOpen(settings);
  if (!registrationOpen) {
    return (
      <Shell title={`Join ${team.name}`}>
        <p className="text-sm text-zinc-400">Team registration is closed for this event.</p>
      </Shell>
    );
  }

  const viewerTeam = login ? await getViewerTeam(login).catch(() => null) : null;

  return (
    <Shell title={`Join ${team.name}`}>
      <p className="text-sm text-zinc-400">
        You have been invited to join <bdi className="font-mono text-white">{team.name}</bdi>
        {team.memberCount > 0 && (
          <>
            {" "}
            — currently {team.memberCount} {team.memberCount === 1 ? "player" : "players"}
          </>
        )}
        .
      </p>
      <JoinTeamInvite
        code={code}
        teamName={team.name}
        signedIn={Boolean(login)}
        alreadyOnTeam={viewerTeam !== null}
      />
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader eyebrow="Teams" title={title} description="Join a team with a shared link." />
      <div className="ds-card flex flex-col gap-4 rounded-lg border border-white/[0.06] bg-[#16162a] p-5">
        {children}
      </div>
    </div>
  );
}
