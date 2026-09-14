// The gate around BoardItemLists used to be a hand-listed
// `entry.modules?.quiz || entry.modules?.classic || entry.modules?.ai` (now
// derived from `Object.keys(entry.modules ?? {})` so a future module can't
// repeat the omission) — an ai-only row or team once expanded with NO item
// list. TeamRow's completed-count noun is a separate concern: it's the
// chip's VERB slot ("N solved/answered/patched"), deliberately "solved" for
// ai (matching classic's grammar) rather than module-detail.tsx's "challenges"
// (that component's own unit-label noun for ai, a different slot entirely).
// BoardItemLists itself fetches client-side on mount (useEffect), which
// renderToStaticMarkup never runs — its REAL markup is always empty here
// regardless of the gate, so it is mocked to a stable marker: these tests
// pin the GATE, not the fetch.
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
import type { ResolvedModule } from "@/lib/modules";
import type { LeaderboardEntry, TeamStanding } from "@/lib/leaderboard/types";

const CAPS = { apps: true, teams: true, challenges: true } as const;

const AI_MODULE: ResolvedModule = { id: "ai", title: "AI", blurb: "" };
const SD_MODULE: ResolvedModule = { id: "secure-development", title: "Secure Development", blurb: "" };

function aiOnlyEntry(): LeaderboardEntry {
  return {
    rank: 1,
    login: "alice",
    team: null,
    points: 20,
    patched: 0,
    failed: 0,
    total: 0,
    apps: {},
    updatedAt: null,
    modules: {
      ai: { points: 20, completed: 2, lastActivityAt: null, detail: { kind: "ai", solved: 2, total: 3, points: 20 } },
    },
  };
}

function aiOnlyTeam(): TeamStanding {
  return {
    rank: 1,
    slug: "red-team",
    name: "Red Team",
    captain: "alice",
    points: 20,
    members: ["alice"],
    modules: {
      ai: { points: 20, completed: 2, lastActivityAt: null, detail: { kind: "ai", solved: 2, total: 3, points: 20 } },
    },
  };
}

describe("an ai-only entry's expansion", () => {
  it("shows the ai module block and the per-item Show-N list", () => {
    const html = renderToStaticMarkup(
      <EntryRow
        entry={aiOnlyEntry()}
        topPoints={20}
        isOwn={false}
        isOpen
        onToggle={() => {}}
        capabilities={CAPS}
        modules={[AI_MODULE]}
        enabledApps={[]}
      />,
    );
    // ModuleDetail's ai arm — same "solved / total challenges" shape as classic's.
    expect(html).toMatch(/2\s*\/\s*3/);
    expect(html).toContain("challenges");
    // The gate that used to omit ai entirely from BoardItemLists.
    expect(html).toContain('data-testid="board-item-lists"');
    expect(html).toContain(">alice<");
  });
});

describe("an ai-only team's expansion", () => {
  it("shows the per-item Show-N list, and the module row's noun is ai's own 'cleared'", () => {
    const html = renderToStaticMarkup(
      <TeamRow team={aiOnlyTeam()} topPoints={20} isOpen onToggle={() => {}} modules={[AI_MODULE, SD_MODULE]} enabledApps={[]} />,
    );
    expect(html).toContain('data-testid="board-item-lists"');
    // TeamRow had a noun ternary of its own that fell through to "solved"
    // for ai — the same word classic used, so a team that had played both
    // read the same count twice. Every surface reads the shared map now,
    // where ai's word is "cleared".
    expect(html).toMatch(/cleared/);
    expect(html).not.toMatch(/2\s*solved/);
  });
});
