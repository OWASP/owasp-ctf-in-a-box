import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
// No next/image mock: nothing under ModuleDetail (AppBreakdown →
// AppChallengeList → OwaspBadge) renders one, so the stub the other
// component tests need would be dead here — and its `<img>` was the file's
// one lint finding.
import ModuleDetail from "@/components/module-detail";
import type { LeaderboardEntry, ModuleProgress } from "@/lib/leaderboard/types";

const entry = (): LeaderboardEntry => ({
  rank: 1, login: "ada", team: null, points: 30, patched: 3, failed: 0, total: 3,
  apps: {}, updatedAt: null,
});

describe("ModuleDetail", () => {
  it("renders the quiz shape from a discriminated detail", () => {
    const progress: ModuleProgress = {
      points: 40, completed: 4, lastActivityAt: null,
      detail: { kind: "quiz", answered: 4, total: 6, points: 40 },
    };
    const html = renderToStaticMarkup(<ModuleDetail moduleId="quiz" progress={progress} entry={entry()} enabledApps={[]} />);
    expect(html).toMatch(/4\s*\/\s*6/);
  });

  it("renders the classic shape from a discriminated detail", () => {
    const progress: ModuleProgress = {
      points: 50, completed: 2, lastActivityAt: null,
      detail: { kind: "classic", solved: 2, total: 5, points: 50, locked: 0 },
    };
    const html = renderToStaticMarkup(<ModuleDetail moduleId="classic" progress={progress} entry={entry()} enabledApps={[]} />);
    expect(html).toMatch(/2\s*\/\s*5/);
    expect(html).toContain("flags");
    // The quiz branch used to be an UNGUARDED fallthrough, so a third variant
    // rendered with quiz's noun. Each `kind` now has its own explicit branch.
    expect(html).not.toContain("answered");
  });

  // The narrow is on `detail.kind`, never on `moduleId` — the compiler can
  // only prove the branch's shape from the discriminant, and a mismatched
  // `moduleId` must not be able to steer the render at the wrong data.
  it("renders from detail.kind rather than the moduleId prop", () => {
    const progress: ModuleProgress = {
      points: 50, completed: 2, lastActivityAt: null,
      detail: { kind: "classic", solved: 2, total: 5, points: 50, locked: 0 },
    };
    const html = renderToStaticMarkup(<ModuleDetail moduleId="quiz" progress={progress} entry={entry()} enabledApps={[]} />);
    expect(html).toContain("flags");
    expect(html).not.toContain("answered");
  });

  it("renders the ai shape from a discriminated detail", () => {
    const progress: ModuleProgress = {
      points: 20, completed: 2, lastActivityAt: null,
      detail: { kind: "ai", solved: 2, total: 3, points: 20 },
    };
    const html = renderToStaticMarkup(<ModuleDetail moduleId="ai" progress={progress} entry={entry()} enabledApps={[]} />);
    expect(html).toMatch(/2\s*\/\s*3/);
    expect(html).toContain("challenges");
    expect(html).not.toContain("answered");
    expect(html).not.toContain("flags");
  });

  it("renders the secure-development shape from a discriminated detail", () => {
    const progress: ModuleProgress = {
      points: 30, completed: 3, lastActivityAt: null,
      detail: { kind: "secure-development", apps: {} },
    };
    const html = renderToStaticMarkup(<ModuleDetail moduleId="secure-development" progress={progress} entry={entry()} enabledApps={[]} />);
    expect(html).toContain("No app breakdown reported yet.");
  });
});
