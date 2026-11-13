// Single-module regression gate. This has its own file (rather than living
// alongside leaderboard.test.tsx) so its one-module `modules` fixture can't
// be confused with that file's two-module one.
//
// What this pins: for an event with exactly one enabled module — every event
// shipped so far — an expanded leaderboard row must render the way it did
// before the multi-module branch: the "App breakdown" label straight above the
// per-target grid, with no redundant "SECURE DEVELOPMENT <n> pts" heading
// wedged between them restating the points already shown in the row header.
// The heading is suppressed off the LENGTH of the `modules` prop (supplied by
// the server page from the resolved module registry), not a mocked registry.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @next/next/no-img-element
    return <img {...props} alt={(props.alt as string) ?? ""} />;
  },
}));

import { EntryRow } from "@/components/leaderboard";
import type { ResolvedModule } from "@/lib/modules";
import { apps } from "@/lib/apps";
import type { LeaderboardEntry } from "@/lib/leaderboard/types";

const MODULES: readonly ResolvedModule[] = [
  { id: "secure-development", title: "Secure Development", blurb: "" },
];

const CAPS = { apps: true, teams: false, challenges: true } as const;

const entry: LeaderboardEntry = {
  rank: 1,
  playerId: "alice", name: "alice", image: null,
  team: null,
  points: 100,
  patched: 3,
  failed: 0,
  total: 3,
  apps: { dvwa: { app: "dvwa", points: 100, maxPoints: 200, patched: 3, total: 6 } },
  updatedAt: null,
  modules: {
    "secure-development": {
      points: 100,
      completed: 3,
      lastActivityAt: null,
      detail: { kind: "secure-development", apps: { dvwa: { app: "dvwa", points: 100, maxPoints: 200, patched: 3, total: 6 } } },
    },
  },
};

describe("expanded row with a single enabled module", () => {
  const html = renderToStaticMarkup(
    <EntryRow entry={entry} topPoints={200} isOwn={false} isOpen onToggle={() => {}} capabilities={CAPS} modules={MODULES} enabledApps={apps} />,
  );

  it("suppresses the per-module heading", () => {
    expect(html).not.toContain("Secure Development");
  });

  it("still renders the app breakdown under its own label", () => {
    expect(html).toContain("App breakdown");
    expect(html).toContain("DVWA");
  });
});
