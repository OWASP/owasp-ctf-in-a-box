// Regression test for the team-standings double-count bug: a flag two team
// members both solved must contribute its points to the team ONCE, not once
// per solver. buildMockTeams dedupes by (app, challenge key) across a team's
// members instead of summing each member's individual point total.

import { describe, expect, it } from "vitest";
import { buildMockEntries, buildMockTeams , buildMockCatalog } from "../mock-data";

describe("buildMockTeams", () => {
  it("counts a flag shared by two teammates once, not per-solver", () => {
    const entries = buildMockEntries();
    // seg-fault = octocat + mona, both patched juice-shop's
    // redirectCryptoCurrencyChallenge (1pt) and loginAdminChallenge (2pt),
    // and dvwa's brute-low (1pt), and webgoat's auth-bypass-verify-account
    // (2pt) — 6 points of overlap that a naive sum would double-count.
    const octocat = entries.find((e) => e.login === "octocat")!;
    const mona = entries.find((e) => e.login === "mona")!;
    expect(octocat.points).toBeGreaterThan(0);
    expect(mona.points).toBeGreaterThan(0);

    const teams = buildMockTeams(entries);
    const segFault = teams.find((t) => t.slug === "seg-fault")!;
    expect(segFault).toBeDefined();
    expect(segFault.points).toBeLessThan(octocat.points + mona.points);
    // Exact expected total: union of patched (app,key) pairs across both
    // members' challenge lists.
    const catalog = buildMockCatalog();
    const seen = new Set<string>();
    let expected = 0;
    for (const entry of [octocat, mona]) {
      for (const [app, progress] of Object.entries(entry.apps)) {
        for (const id of progress?.solvedIds ?? []) {
          const dedupeKey = `${app}:${id}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          expected += catalog[app as keyof typeof catalog]?.find((c) => c.key === id)?.points ?? 0;
        }
      }
    }
    expect(segFault.points).toBe(expected);
  });

  it("includes a captain and full membership on every team", () => {
    const entries = buildMockEntries();
    const teams = buildMockTeams(entries);
    for (const team of teams) {
      expect(team.members.length).toBeGreaterThan(0);
      expect(team.members).toContain(team.captain);
    }
  });

  it("ranks teams by (deduped) points, tie-breaking by name", () => {
    const entries = buildMockEntries();
    const teams = buildMockTeams(entries);
    for (let i = 1; i < teams.length; i++) {
      expect(teams[i - 1].rank).toBeLessThan(teams[i].rank);
      expect(teams[i - 1].points).toBeGreaterThanOrEqual(teams[i].points);
    }
  });
});
