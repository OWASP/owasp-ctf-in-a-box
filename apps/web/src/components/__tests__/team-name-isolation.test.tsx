// #603. A team name saved before names were checked can still hold a
// right-to-left override; rendered bare, it reorders the text around it (the
// points, the next row). Every surface that shows a team name wraps it in
// <bdi>, which isolates its direction from its neighbours.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ refresh: () => {} }) }));

const { default: DisplayBoard } = await import("@/components/display-board");

const HOSTILE = "‮evil team";
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("team names render direction-isolated", () => {
  it("on the projector board", () => {
    const html = renderToStaticMarkup(
      <DisplayBoard rows={[{ key: "t", rank: 1, name: HOSTILE, points: 10 }]} eventName="Fixture CTF" phaseLabel={null} sponsors={[]} />,
    );
    expect(html).toMatch(new RegExp(`<bdi[^>]*>${HOSTILE}</bdi>`));
  });

  // The rest need a session, a team record or a fetched panel to render, so
  // their render sites are pinned in source: each JSX child that prints a
  // team name sits inside a <bdi>.
  it.each([
    ["components/leaderboard-team-row.tsx", "{team.name}"],
    ["components/team-card.tsx", "{team.name}"],
    ["app/page.tsx", "{row.name}"],
    ["app/(site)/join/[code]/page.tsx", "{team.name}</"],
    ["app/(site)/admin/admin-support-tab.tsx", "{detail.team.name}</"],
  ])("in %s", (file, expr) => {
    const lines = readFileSync(join(SRC, file), "utf8")
      .split("\n")
      .filter((l) => l.includes(expr));
    expect(lines.length, `${expr} in ${file}`).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/<bdi\b/);
  });
});
