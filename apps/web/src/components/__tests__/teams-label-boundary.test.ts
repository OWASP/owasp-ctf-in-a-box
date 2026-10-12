// The RSC boundary under the solve-count label.
//
// `challenge-board.tsx` and `story-lanes.tsx` render on the server and call
// `teamsLabel()`. Called from a `"use client"` module, it throws at request
// time ("Attempted to call teamsLabel() from the server"), so /flags and /ai
// stop rendering. Vitest has no RSC boundary, so no behavioural test here can
// fail on it; the classic-only and ai-only bring-ups request those pages
// against a built image. This pins the file relationships instead, the same
// way admin-tab-urls.test.tsx does for the admin tabs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { teamsLabel } from "@/lib/solve-labels";

const src = join(import.meta.dirname, "..", "..");
const read = (f: string) => readFileSync(join(src, f), "utf8");
const USE_CLIENT = /^\s*["']use client["']/m;

describe("teamsLabel", () => {
  it("says one team or several", () => {
    expect(teamsLabel(1)).toBe("1 team");
    expect(teamsLabel(0)).toBe("0 teams");
    expect(teamsLabel(3)).toBe("3 teams");
  });
});

describe("the RSC boundary under teamsLabel", () => {
  it("lives in a module that is not a Client Component and imports nothing", () => {
    const lib = read("lib/solve-labels.ts");
    expect(lib).not.toMatch(USE_CLIENT);
    expect([...lib.matchAll(/^\s*import\s/gm)]).toEqual([]);
  });

  for (const file of ["components/challenge-board.tsx", "components/story-lanes.tsx"]) {
    it(`${file} takes it from lib/solve-labels, not from a client module`, () => {
      const body = read(file);
      expect(body).not.toMatch(USE_CLIENT);
      expect(body).toContain('from "@/lib/solve-labels"');
      expect(body).not.toMatch(/import\s*\{[^}]*\bteamsLabel\b[^}]*\}\s*from\s*["']@\/components\/challenge-detail["']/);
    });
  }
});
