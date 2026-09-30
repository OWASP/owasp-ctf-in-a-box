import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { errorLabel } from "@/lib/error-label";
import { getAdminSettings, getSyncStatus } from "@/lib/admin-store";
import { getLeaderboardSource } from "@/lib/leaderboard/source";
import { withModuleContributions } from "@/lib/leaderboard/module-contributions";

type LeaderboardFreshness = { players: number; lastUpdatedAt: string | null } | null;

// Best-effort only: a leaderboard-read failure must degrade this field to
// `null`, not fail the whole status route — settings/sync are the core
// payload the admin panel needs to render.
//
// Reads the board through `withModuleContributions`, NOT the raw source: a
// module-only contestant has no row in the scoring source and only gets one
// when that overlay runs (it unions the source's logins with the ones holding
// module points). Off the raw source this panel reported `players: 0` forever
// on a populated quiz-only board — the same class of bug as rendering a
// module-blind page. `/leaderboard` runs the same overlay; this is what keeps
// the organizer's count agreeing with the board they are looking at.
async function readLeaderboardFreshness(): Promise<LeaderboardFreshness> {
  try {
    const source = await getLeaderboardSource();
    const { entries } = await source
      .getLeaderboard()
      .then(withModuleContributions);
    let lastUpdatedAt: string | null = null;
    for (const entry of entries) {
      if (entry.updatedAt && (lastUpdatedAt === null || entry.updatedAt > lastUpdatedAt)) {
        lastUpdatedAt = entry.updatedAt;
      }
    }
    return { players: entries.length, lastUpdatedAt };
  } catch (err) {
    console.error("[admin/status] leaderboard freshness read failed", errorLabel(err));
    return null;
  }
}

export async function GET(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });
  const [settings, sync, leaderboard] = await Promise.all([
    getAdminSettings(),
    getSyncStatus(),
    readLeaderboardFreshness(),
  ]);
  return NextResponse.json({ settings, sync, leaderboard });
}
