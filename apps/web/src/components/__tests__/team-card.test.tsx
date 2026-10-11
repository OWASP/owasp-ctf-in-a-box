// @testing-library/react is not a dependency of this repo and must not be
// added just for this test. TeamCard is a "use client" component but has no
// effects that run during a plain render, so renderToStaticMarkup is enough
// to check markup — same pattern as score-time-chart.test.tsx. useRouter is
// mocked since next/navigation's real hook needs a router context.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import TeamCard from "@/components/team-card";

describe("TeamCard", () => {
  it("offers all three ways onto a team when the viewer has none", () => {
    const html = renderToStaticMarkup(
      <TeamCard team={null} writesEnabled maxMembers={4} isCaptain={false} captain={null} joinCode={null} />,
    );
    // Join-by-code field, labeled as a code (not a slug).
    expect(html).toMatch(/join code/i);
    // Create field.
    expect(html).toMatch(/team name/i);
    // One-click team of one (issue #153) — without it the cheapest way to play
    // alone is to invent a team name.
    expect(html).toMatch(/play solo/i);
  });

  it("says a team is REQUIRED, not merely available", () => {
    // A team is now mandatory before anything scores. Copy that reads as an
    // optional extra leaves a contestant wondering later why nothing counted.
    const html = renderToStaticMarkup(
      <TeamCard team={null} writesEnabled maxMembers={4} isCaptain={false} captain={null} joinCode={null} />,
    );
    expect(html).toMatch(/need a team/i);
    expect(html).not.toMatch(/create or join a team to compete/i);
  });

  it("explains a closed registration window instead of rendering forms (issue #217)", () => {
    // The routes are the enforcement; this is so a teamless contestant sent
    // here after registration closed reads why, instead of three forms that
    // refuse them one failed POST at a time.
    const html = renderToStaticMarkup(
      <TeamCard
        team={null}
        writesEnabled
        maxMembers={4}
        isCaptain={false}
        captain={null}
        joinCode={null}
        registrationOpen={false}
      />,
    );
    expect(html).toMatch(/registration is closed/i);
    // The requirement is still stated — closed registration does not read as
    // "teams are optional now".
    expect(html).toMatch(/still required/i);
    expect(html).not.toMatch(/join code/i);
    expect(html).not.toMatch(/play solo/i);
  });

  it("keeps the forms when registration is open, including by default", () => {
    // The prop defaults open, matching the routes' fail-open settings read —
    // a settings blip must not hide the forms from a whole event.
    const html = renderToStaticMarkup(
      <TeamCard team={null} writesEnabled maxMembers={4} isCaptain={false} captain={null} joinCode={null} />,
    );
    expect(html).toMatch(/join code/i);
    expect(html).toMatch(/play solo/i);
    expect(html).not.toMatch(/registration is closed/i);
  });

  it("shows Leave for a non-captain member and hides captain controls", () => {
    const html = renderToStaticMarkup(
      <TeamCard
        team={{ slug: "red-team", name: "Red Team", members: ["alice", "bob"] }}
        writesEnabled
        maxMembers={4}
        isCaptain={false}
        captain="alice"
        joinCode="ab12cd"
      />,
    );
    expect(html).toMatch(/leave team/i);
    expect(html).not.toMatch(/rename/i);
    expect(html).not.toMatch(/transfer/i);
    expect(html).not.toMatch(/regenerate/i);
    expect(html).not.toMatch(/disband/i);
  });

  it("shows rename/remove/transfer/regen/disband controls for the captain", () => {
    const html = renderToStaticMarkup(
      <TeamCard
        team={{ slug: "red-team", name: "Red Team", members: ["alice", "bob", "carol"] }}
        writesEnabled
        maxMembers={4}
        isCaptain
        captain="alice"
        joinCode="ab12cd"
      />,
    );
    expect(html).toMatch(/rename/i);
    expect(html).toMatch(/remove/i);
    expect(html).toMatch(/transfer/i);
    expect(html).toMatch(/regenerate join code/i);
    expect(html).toMatch(/disband team/i);
    // The join code itself is surfaced prominently.
    expect(html).toContain("ab12cd");
  });

  it("gives the input-paired captain buttons a DESIGNED disabled state, not just a fade", () => {
    // The assertion above (`/rename/i` appears in the markup) passed for the
    // entire time this control was unusable. Rename and Transfer are disabled
    // until their field has a value — so disabled is their RESTING state, the
    // one a captain sees on arrival — and they were rendering as
    // `text-zinc-300` at 50% opacity, which stopped reading as a button at
    // all. The bug was reported as "there is no rename option" by someone
    // looking straight at it.
    //
    // Presence is not discoverability. What this pins is that the disabled
    // state is styled deliberately — it keeps a border and a legible text
    // colour — rather than being the enabled style with the contrast taken
    // out of it.
    const html = renderToStaticMarkup(
      <TeamCard
        team={{ slug: "red-team", name: "Red Team", members: ["alice", "bob"] }}
        writesEnabled
        maxMembers={4}
        isCaptain
        captain="alice"
        joinCode="ab12cd"
      />,
    );
    const renameButton = html.slice(0, html.indexOf(">Rename<"));
    const classAttr = renameButton.slice(renameButton.lastIndexOf('class="'));
    expect(classAttr).toMatch(/disabled:border-/);
    expect(classAttr).toMatch(/disabled:text-/);
    expect(classAttr).not.toMatch(/disabled:opacity-50/);
  });
});

// #599: "nothing counts without a team" is false for Secure Development, whose
// PR scores are recorded for their author and count for the team they join.
// The card says so when that module runs, and names no module otherwise.
describe("TeamCard teamless copy follows the modules", () => {
  it("tells a Secure Development event that PRs are kept until the player joins", () => {
    const html = renderToStaticMarkup(
      <TeamCard team={null} writesEnabled maxMembers={4} isCaptain={false} captain={null} joinCode={null} secureDevEnabled />,
    );
    expect(html).toContain("Secure Development PRs are kept and count for the team you join");
    expect(html).not.toContain("before anything you solve counts");
  });

  it("names no module on an event without Secure Development", () => {
    const html = renderToStaticMarkup(
      <TeamCard team={null} writesEnabled maxMembers={4} isCaptain={false} captain={null} joinCode={null} />,
    );
    expect(html).toContain("You need a team before anything you solve counts.");
    expect(html).not.toMatch(/Secure Development/);
  });

  it("keeps the organizer direction when registration is closed, and says PRs are kept", () => {
    const html = renderToStaticMarkup(
      <TeamCard
        team={null}
        writesEnabled
        maxMembers={4}
        isCaptain={false}
        captain={null}
        joinCode={null}
        registrationOpen={false}
        secureDevEnabled
      />,
    );
    expect(html).toMatch(/registration is closed/i);
    expect(html).toContain("find an organizer");
    expect(html).toContain("Secure Development PRs are kept");
    expect(html).not.toContain("before anything you solve counts");
  });

  it("names no module in the closed-registration copy without Secure Development", () => {
    const html = renderToStaticMarkup(
      <TeamCard team={null} writesEnabled maxMembers={4} isCaptain={false} captain={null} joinCode={null} registrationOpen={false} />,
    );
    expect(html).toContain("before anything you solve counts");
    expect(html).not.toMatch(/Secure Development/);
  });
});
