// The projector's recent-solves feed (#542) — static render. The section is
// additive (the top ten is untouched), absent when there is nothing to show,
// and prints only the public projection: team, title, points, module.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ refresh: () => {} }) }));

const { default: DisplayBoard } = await import("@/components/display-board");

const rows = [{ key: "a", rank: 1, name: "Byte Me", points: 2108 }];
const solves = [
  {
    team: "Red Team",
    title: "Robots Only",
    module: "classic" as const,
    points: 50,
    at: "2026-08-24T10:00:00.000Z",
  },
  {
    team: "Blue Team",
    title: "Prompt Leak",
    module: "ai" as const,
    points: 100,
    at: "2026-08-24T09:59:00.000Z",
  },
];

function render(recentSolves = solves) {
  return renderToStaticMarkup(
    <DisplayBoard rows={rows} eventName="Fixture CTF" phaseLabel="live" recentSolves={recentSolves} />,
  );
}

describe("DisplayBoard — recent solves", () => {
  it("renders the feed below the top ten, with every public field", () => {
    const html = render();
    expect(html).toContain("Recent solves");
    expect(html.indexOf("Byte Me")).toBeLessThan(html.indexOf("Red Team"));
    expect(html).toContain("Robots Only");
    expect(html).toContain("+50");
    expect(html).toContain("Classic");
    expect(html).toContain("Prompt Leak");
    expect(html).toContain("+100");
    expect(html).toContain("AI");
  });

  it("shows no section when the feed is empty", () => {
    const html = render([]);
    expect(html).not.toContain("Recent solves");
  });
});
