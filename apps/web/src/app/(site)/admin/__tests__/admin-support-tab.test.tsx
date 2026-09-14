// @testing-library/react is not a dependency of this repo and must not be
// added just for this test. The contestant card and the confirm modals on
// this tab sit behind `useState` (a lookup has to return first), so a static
// render of the tab shows only the search form. What the card SAYS about a
// contestant — and what the reset confirm claims it will wipe — is therefore
// proven through the exported pure builders the component renders from,
// mirroring how `questionDeleteConfirm`/`challengeDeleteConfirm` are proven
// on the module panels.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AdminSupportTab, {
  contestantStats,
  resetProgressConfirm,
  teamCardSummary,
  type UserDetail,
} from "@/app/(site)/admin/admin-support-tab";

const detail: UserDetail = {
  login: "octocat",
  team: { slug: "e2e-crew", name: "E2E Crew", captain: "octocat", isCaptain: true, joinedAt: "2026-09-03T01:45:00.000Z" },
  firstTeamAt: "2026-08-22T19:09:00.000Z",
  quiz: { answered: 3, points: 200, attempts: 5 },
  classic: { solved: 3, points: 70, attempts: 7 },
  ai: { solved: 2, points: 550, attempts: 4 },
  secureDev: { solves: 6 },
  hints: { bought: 2, spent: 20 },
  known: true,
};

describe("AdminSupportTab", () => {
  it("renders the lookup form with every action disabled at rest", () => {
    const html = renderToStaticMarkup(<AdminSupportTab setConfirm={() => {}} />);
    expect(html).toContain("Find a contestant");
    expect(html).toContain("Team actions");
    // Look up, Transfer captaincy, Disband team — nothing is live before a
    // lookup or a filled slug.
    expect(html.match(/<button[^>]*disabled=""/g)?.length).toBe(3);
  });
});

// UX audit F4: the card and the reset confirm had quiz, classic and
// secure-development figures and no AI at all, while the reset does clear AI
// solves and attempts — so an organizer confirmed a smaller wipe than the one
// that happened, and could not see a contestant's AI progress before deleting
// it.
describe("contestantStats", () => {
  it("shows AI points and solves alongside the other modules", () => {
    const labels = contestantStats(detail).map((s) => s.label);
    expect(labels).toContain("AI pts");
    expect(labels).toContain("AI solved");
    expect(labels).toContain("Quiz pts");
    expect(labels).toContain("Jeopardy pts");
  });

  it("counts AI attempts in the attempts total", () => {
    const attempts = contestantStats(detail).find((s) => s.label === "Attempts");
    expect(attempts?.value).toBe(5 + 7 + 4);
  });

  it("spells Secure Development out rather than abbreviating it", () => {
    const labels = contestantStats(detail).map((s) => s.label);
    expect(labels).toContain("Secure Development solves");
    expect(labels.join(" ")).not.toMatch(/Sec-dev/);
  });
});

describe("resetProgressConfirm", () => {
  it("names every module the reset clears and sums their points", () => {
    const c = resetProgressConfirm(detail);
    expect(c.title).toBe("Reset octocat's progress?");
    expect(c.requireType).toBe("octocat");
    expect(c.body).toMatch(/quiz answers, classic and AI solves, attempts and hints/);
    expect(c.body).toContain(`${200 + 70 + 550} points in total`);
  });

  it("warns about Secure Development re-ingestion only when there are such solves", () => {
    expect(resetProgressConfirm(detail).warning).toMatch(/6 Secure Development solves/);
    expect(resetProgressConfirm({ ...detail, secureDev: { solves: 0 } }).warning).toBeNull();
  });
});

// UX audit F21: the team actions took a hand-typed slug while the contestant
// card directly above already held it, so the commonest ticket on this tab
// began with retyping — and the card's `joined` stamp carried no timezone
// while the line beneath it said UTC.
describe("teamCardSummary", () => {
  it("stamps the join time UTC, like every other timestamp on the tab", () => {
    expect(teamCardSummary(detail).joined).toBe("joined 2026-09-03 01:45 UTC");
  });

  it("offers the slug the card already knows, so nothing is retyped", () => {
    expect(teamCardSummary(detail).actionSlug).toBe("e2e-crew");
  });

  it("offers nothing for a contestant on no team", () => {
    const teamless: UserDetail = { ...detail, team: null };
    expect(teamCardSummary(teamless)).toEqual({ joined: null, actionSlug: null });
  });

  it("has no join stamp for a membership that predates the joinedAt field", () => {
    const noJoinedAt: UserDetail = { ...detail, team: { ...detail.team!, joinedAt: null } };
    const summary = teamCardSummary(noJoinedAt);
    expect(summary.joined).toBeNull();
    // The slug is still offered — the two are independent.
    expect(summary.actionSlug).toBe("e2e-crew");
  });
});
