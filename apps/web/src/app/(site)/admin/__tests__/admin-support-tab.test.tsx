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
  addToTeamLabel,
  addToTeamNotice,
  canSearch,
  contestantStats,
  deleteContestantConfirm,
  latestOnly,
  lookupUrl,
  PlayerIdentity,
  PlayerResultLabel,
  playerActionBody,
  playerSearchUrl,
  removeFromTeamConfirm,
  requestSequence,
  resetProgressConfirm,
  teamCardSummary,
  type UserDetail,
} from "@/app/(site)/admin/admin-support-tab";

const OCTO = "0c7aca70-0000-4000-8000-00000000000a";
const detail: UserDetail = {
  id: OCTO,
  name: "octocat",
  team: { slug: "e2e-crew", name: "E2E Crew", captain: OCTO, isCaptain: true, joinedAt: "2026-09-03T01:45:00.000Z" },
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
    // Searched by name: the box asks for a name, not a GitHub login.
    expect(html).toContain('placeholder="Name or GitHub login"');
    expect(html).toContain("Team actions");
    // Look up, Transfer captaincy, Disband team, Add adjustment: nothing is
    // live before a lookup, a filled slug, or a complete adjustment.
    expect(html.match(/<button[^>]*disabled=""/g)?.length).toBe(4);
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
  it("stamps the join time UTC to the second, to match against logs", () => {
    expect(teamCardSummary(detail).joined).toBe("joined 2026-09-03 01:45:00 UTC");
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

// #597: the organizer's way back for a player stranded after registration
// closed. One control on the player's card: Add for a teamless player, Move
// for one already on a team; the notice names where they came from.
describe("add or move to a team (#597)", () => {
  it("offers Add for a teamless player and Move for one on a team", () => {
    expect(addToTeamLabel(null)).toBe("Add to team");
    expect(addToTeamLabel({ slug: "red" })).toBe("Move to team");
  });

  it("says where the player went, and from where", () => {
    expect(addToTeamNotice({ name: "ChrisZoc", from: null }, "red")).toBe("Added ChrisZoc to red.");
    expect(addToTeamNotice({ name: "bob", from: "blue" }, "red")).toBe("Moved bob from blue to red.");
  });
});

// #742: the tab finds a player by name and then acts on the chosen row's id.
// Nothing it sends names a GitHub login.
describe("search by name, act by id (#742)", () => {
  it("searches the players endpoint with the typed name", () => {
    expect(playerSearchUrl("  Octo Cat ")).toBe("/api/admin/players?q=Octo%20Cat");
  });

  it("looks the chosen row up by its id", () => {
    expect(lookupUrl(OCTO)).toBe(`/api/admin/ops/user?id=${OCTO}`);
  });

  it("acts on the chosen row's id, never a login", () => {
    const body = JSON.parse(playerActionBody(detail, { action: "reset" })) as Record<string, unknown>;
    expect(body).toEqual({ id: OCTO, action: "reset" });
    const team = JSON.parse(playerActionBody(detail, { slug: "red", action: "add-member", overrideCap: false })) as Record<string, unknown>;
    expect(team).toEqual({ id: OCTO, slug: "red", action: "add-member", overrideCap: false });
    expect(team).not.toHaveProperty("login");
  });

  it("names the player in the confirmations, and has the organizer type that name", () => {
    const c = resetProgressConfirm(detail);
    expect(c.title).toBe("Reset octocat's progress?");
    expect(c.requireType).toBe("octocat");
  });
});

describe("search and lookup races", () => {
  it("refuses a search while a request is in flight, Enter included", () => {
    expect(canSearch("octo", false)).toBe(true);
    expect(canSearch("octo", true)).toBe(false);
    expect(canSearch("   ", false)).toBe(false);
  });

  // Picking A then B: if A's answer lands after B's, it must not replace B
  // on the card.
  it("drops an older lookup's answer that lands after a newer one", async () => {
    const seq = requestSequence();
    let resolveA!: (v: string) => void;
    let resolveB!: (v: string) => void;
    const a = latestOnly(seq, () => new Promise<string>((r) => (resolveA = r)));
    const b = latestOnly(seq, () => new Promise<string>((r) => (resolveB = r)));
    resolveB("B");
    resolveA("A");
    expect(await b).toEqual({ current: true, ok: true, value: "B" });
    expect(await a).toEqual({ current: false });
  });

  it("drops an older lookup's failure too, and reports the newest one's", async () => {
    const seq = requestSequence();
    let rejectA!: (e: Error) => void;
    const a = latestOnly(seq, () => new Promise<string>((_, r) => (rejectA = r)));
    const b = latestOnly(seq, () => Promise.reject(new Error("down")));
    rejectA(new Error("old"));
    expect(await a).toEqual({ current: false });
    expect(await b).toEqual({ current: true, ok: false });
  });
});

// Display names are not unique: two accounts can both be "octocat" with no
// avatar. The player id is the one thing that tells them apart, so it shows
// on every result row, on the card, and in every destructive confirmation.
describe("the player id tells same-named players apart", () => {
  const OTHER = "0c7aca70-0000-4000-8000-00000000000b";

  it("shows each result's full id beside its name", () => {
    const html = renderToStaticMarkup(<PlayerResultLabel player={{ id: OCTO, name: "octocat", image: null }} />);
    expect(html).toContain("octocat");
    expect(html).toContain(OCTO);
  });

  it("renders two same-named results differently", () => {
    const a = renderToStaticMarkup(<PlayerResultLabel player={{ id: OCTO, name: "octocat", image: null }} />);
    const b = renderToStaticMarkup(<PlayerResultLabel player={{ id: OTHER, name: "octocat", image: null }} />);
    expect(a).not.toBe(b);
    expect(b).toContain(OTHER);
  });

  it("shows the selected player's full id on the card, under the name", () => {
    const html = renderToStaticMarkup(<PlayerIdentity detail={detail} />);
    expect(html.indexOf("octocat")).toBeGreaterThan(-1);
    expect(html.indexOf(OCTO)).toBeGreaterThan(html.indexOf("octocat"));
  });

  it("names the id in the reset, delete and team-removal confirmations", () => {
    expect(resetProgressConfirm(detail).body).toContain(OCTO);
    expect(deleteContestantConfirm(detail).idLine).toContain(OCTO);
    const member: UserDetail = { ...detail, team: { ...detail.team!, isCaptain: false } };
    const remove = removeFromTeamConfirm(member);
    expect(remove.idLine).toContain(OCTO);
    expect(remove.title).toBe("Remove octocat from E2E Crew?");
  });
});
