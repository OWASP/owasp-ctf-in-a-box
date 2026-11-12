import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: vi.fn(), upstashEval: vi.fn() }));
vi.mock("@/lib/leaderboard/fold-cache", () => ({
  beginScoreLowering: vi.fn(),
  endScoreLowering: vi.fn(),
}));

import { RESET_PREFIXES } from "@/lib/admin-store";

/** Redis glob `*` as `.*`; every other character literal. */
function globToRegExp(glob: string): RegExp {
  const body = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

describe("RESET_PREFIXES", () => {
  it("is non-empty, so the keep-auth assertion is not vacuous", () => {
    expect(RESET_PREFIXES.length).toBeGreaterThan(0);
  });

  it("keeps every auth key through a master reset", () => {
    for (const [, pattern] of RESET_PREFIXES) {
      expect(globToRegExp(pattern).test("ctf:auth:user")).toBe(false);
      expect(globToRegExp(pattern).test("ctf:auth:session:by:token:x")).toBe(false);
    }
  });

  it("the matcher does match what a pattern names", () => {
    expect(globToRegExp("ctf:team:*").test("ctf:team:abc")).toBe(true);
  });
});
