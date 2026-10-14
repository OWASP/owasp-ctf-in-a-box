// The profile page's team scoring panel. Same static-render pattern as
// team-card.test.tsx — presentational Server Component, no effects. These
// pins are about VISIBLE properties, not string presence for its own sake:
// every member must get a row (zeros included), the dedupe note must appear
// exactly when member points exceed the team total, and each module's
// contribution must use that module's own noun.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import TeamProgress from "@/components/team-progress";
import type { LeaderboardEntry, TeamStanding } from "@/lib/leaderboard/types";

const standing: TeamStanding = {
  rank: 2,
  slug: "null-terminators",
  name: "Null Terminators",
  captain: "alice",
  points: 120,
  members: ["alice", "bob"],
};

function entry(login: string, points: number, modules?: LeaderboardEntry["modules"]): LeaderboardEntry {
  return {
    rank: 0,
    login,
    team: "null-terminators",
    points,
    patched: 0,
    failed: 0,
    total: 0,
    apps: {},
    updatedAt: null,
    modules,
  };
}

describe("TeamProgress", () => {
  it("renders the team total, rank, and one row per member with their own points", () => {
    const html = renderToStaticMarkup(
      <TeamProgress
        standing={standing}
        memberEntries={[
          { login: "alice", entry: entry("alice", 90) },
          { login: "bob", entry: entry("bob", 60) },
        ]}
        viewerLogin="bob"
      />,
    );
    expect(html).toContain("Team progress");
    expect(html).toContain("#2");
    expect(html).toContain("120 pts");
    expect(html).toContain("alice");
    expect(html).toContain("bob");
    expect(html).toContain("90");
    expect(html).toContain("60");
    // Role markers: the viewer and the captain are both labelled.
    expect(html).toContain("you");
    expect(html).toContain("captain");
  });

  it("says out loud that shared solves count once when member points exceed the team total", () => {
    const html = renderToStaticMarkup(
      <TeamProgress
        standing={standing}
        memberEntries={[
          { login: "alice", entry: entry("alice", 90) },
          { login: "bob", entry: entry("bob", 60) },
        ]}
        viewerLogin="alice"
      />,
    );
    // 90 + 60 = 150 > 120: the union folded shared solves.
    expect(html).toContain("150");
    expect(html).toContain("banks each solve once");
  });

  it("omits the dedupe note when nothing was double-solved", () => {
    const html = renderToStaticMarkup(
      <TeamProgress
        standing={standing}
        memberEntries={[
          { login: "alice", entry: entry("alice", 90) },
          { login: "bob", entry: entry("bob", 30) },
        ]}
        viewerLogin="alice"
      />,
    );
    expect(html).not.toContain("banks each");
  });

  it("still lists a member with no scored activity, at zero", () => {
    const html = renderToStaticMarkup(
      <TeamProgress
        standing={standing}
        memberEntries={[
          { login: "alice", entry: entry("alice", 120) },
          { login: "bob", entry: null },
        ]}
        viewerLogin="alice"
      />,
    );
    expect(html).toContain("bob");
    expect(html).toContain(">0<");
  });

  it("describes each module's contribution in that module's own noun", () => {
    const html = renderToStaticMarkup(
      <TeamProgress
        standing={standing}
        memberEntries={[
          {
            login: "alice",
            entry: entry("alice", 90, {
              "secure-development": {
                points: 40,
                completed: 4,
                lastActivityAt: null,
                detail: { kind: "secure-development", apps: {} },
              },
              quiz: {
                points: 50,
                completed: 5,
                lastActivityAt: null,
                detail: { kind: "quiz", answered: 5, total: 10, points: 50 },
              },
            }),
          },
        ]}
        viewerLogin="alice"
      />,
    );
    expect(html).toContain("4 patched");
    expect(html).toContain("5 answered");
  });
});

// #591: the profile panel shows the team's organizer adjustment beside its
// total, like the hint marker.
describe("TeamProgress adjustment marker (#591)", () => {
  it("shows the signed adjustment", () => {
    const html = renderToStaticMarkup(
      <TeamProgress standing={{ ...standing, adjustment: -25 }} memberEntries={[]} viewerLogin="bob" />,
    );
    expect(html).toContain("−25 adjustment");
  });
});
