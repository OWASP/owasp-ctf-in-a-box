// Every enabled module is on an expanded row from the start, at 0 / N. Two
// things the zero blocks must NOT do, pinned here at the component:
//   - push the Secure Development target breakdown off a team row (the row
//     falls back to it only when there are no module rows at all, so the
//     data layer stamps Secure Development at zero beside the others);
//   - start the per-item list fetch on a row that has completed nothing
//     outside Secure Development (BoardItemLists is mocked to a marker for
//     the same reason as in leaderboard-ai-only.test.tsx: its real markup is
//     always empty under a static render, so the GATE is what is pinned).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @next/next/no-img-element
    return <img {...props} alt={(props.alt as string) ?? ""} />;
  },
}));

vi.mock("@/components/board-item-lists", () => ({
  default: ({ logins }: { logins: string[] }) => <div data-testid="board-item-lists">{logins.join(",")}</div>,
}));

import { EntryRow, TeamRow } from "@/components/leaderboard";
import { apps } from "@/lib/apps";
import type { ResolvedModule } from "@/lib/modules";
import type { LeaderboardEntry, ModuleProgress, TeamStanding } from "@/lib/leaderboard/types";

const MODULES: readonly ResolvedModule[] = [
  { id: "secure-development", title: "Secure Development", blurb: "" },
  { id: "classic", title: "Jeopardy", blurb: "" },
];

const sdApps = { dvwa: { app: "dvwa" as const, points: 0, maxPoints: 30, patched: 0, total: 3 } };

const zeroClassic: ModuleProgress = {
  points: 0,
  completed: 0,
  lastActivityAt: null,
  detail: { kind: "classic", solved: 0, total: 4, points: 0, locked: 0 },
};
const zeroSd: ModuleProgress = {
  points: 0,
  completed: 0,
  lastActivityAt: null,
  detail: { kind: "secure-development", apps: sdApps },
};

function team(modules: TeamStanding["modules"]): TeamStanding {
  return { rank: 1, slug: "red", name: "Red", captain: "ada", points: 0, members: ["ada"], apps: sdApps, modules };
}

function entry(overrides: Partial<LeaderboardEntry>): LeaderboardEntry {
  return {
    rank: 1, login: "ada", team: null, points: 0, patched: 0, failed: 0, total: 0, apps: {}, updatedAt: null,
    ...overrides,
  };
}

describe("a team row before its first solve (#585)", () => {
  const html = renderToStaticMarkup(
    <TeamRow
      team={team({ "secure-development": zeroSd, classic: zeroClassic })}
      topPoints={0}
      isOpen
      onToggle={() => {}}
      modules={MODULES}
      enabledApps={apps}
    />,
  );

  it("shows Jeopardy at 0 / N alongside Secure Development", () => {
    expect(html).toContain("Jeopardy");
    expect(html).toContain("Secure Development");
    expect(html).toMatch(/>0<\/span><span[^>]*> \/ 4 [a-z]+<\/span>/);
  });

  it("keeps the Secure Development target breakdown", () => {
    expect(html).toContain("DVWA");
  });

  it("does not fetch item lists for a row with nothing completed", () => {
    expect(html).not.toContain('data-testid="board-item-lists"');
  });

  it("still fetches them once a non-SD module has a solve", () => {
    const solved = renderToStaticMarkup(
      <TeamRow
        team={team({ "secure-development": zeroSd, classic: { ...zeroClassic, completed: 1, points: 10, detail: { kind: "classic", solved: 1, total: 4, points: 10, locked: 0 } } })}
        topPoints={10}
        isOpen
        onToggle={() => {}}
        modules={MODULES}
        enabledApps={apps}
      />,
    );
    expect(solved).toContain('data-testid="board-item-lists"');
  });
});

describe("a contestant row before its first solve (#585)", () => {
  it("shows Jeopardy at 0 / N with no item-list fetch", () => {
    const html = renderToStaticMarkup(
      <EntryRow
        entry={entry({ apps: sdApps, modules: { "secure-development": zeroSd, classic: zeroClassic } })}
        topPoints={0}
        isOwn={false}
        isOpen
        onToggle={() => {}}
        capabilities={{ apps: true, teams: false, challenges: false }}
        modules={MODULES}
        enabledApps={apps}
      />,
    );
    expect(html).toContain("Jeopardy");
    expect(html).toMatch(/0 \/ 4/);
    expect(html).not.toContain('data-testid="board-item-lists"');
  });

  // An upstash-shaped row never gets a Secure Development block, so a row
  // with nothing completed falls back to the patched/attempted summary. A
  // zero block must not take that summary away.
  it("keeps the patched summary on a row with only zero blocks", () => {
    const html = renderToStaticMarkup(
      <EntryRow
        entry={entry({ patched: 5, total: 7, points: 50, modules: { classic: zeroClassic } })}
        topPoints={50}
        isOwn={false}
        isOpen
        onToggle={() => {}}
        capabilities={{ apps: false, teams: false, challenges: false }}
        modules={MODULES}
        enabledApps={apps}
      />,
    );
    expect(html).toContain("5 patched / 7 attempted");
    expect(html).toMatch(/0 \/ 4/);
  });
});
