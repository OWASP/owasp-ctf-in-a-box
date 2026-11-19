import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

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
  it("matches the shared v1 Redis fingerprint fixture", async () => {
    const url = new URL("../../../../../test/fixtures/v1-fingerprints.json", import.meta.url);
    const { patterns } = JSON.parse(await readFile(url, "utf8"));
    expect(patterns).toEqual(RESET_PREFIXES.map(([, pattern]) => pattern));
  });

  it("is non-empty, so the keep-auth assertion is not vacuous", () => {
    expect(RESET_PREFIXES.length).toBeGreaterThan(0);
  });

  it("preserves the Redis schema marker through a master reset", () => {
    const marker = "ctf:meta:schema-version";

    expect(
      RESET_PREFIXES.some(([, pattern]) => globToRegExp(pattern).test(marker)),
    ).toBe(false);
  });

  it("keeps every auth key through a master reset", () => {
    for (const [, pattern] of RESET_PREFIXES) {
      expect(globToRegExp(pattern).test("ctf:auth:user")).toBe(false);
      expect(globToRegExp(pattern).test("ctf:auth:session:by:token:x")).toBe(false);
    }
  });

  it("keeps every GitHub link key through a master reset", () => {
    for (const [, pattern] of RESET_PREFIXES) {
      expect(globToRegExp(pattern).test("ctf:link:github:x")).toBe(false);
      expect(globToRegExp(pattern).test("ctf:link:user:x")).toBe(false);
      expect(globToRegExp(pattern).test("ctf:link:at")).toBe(false);
      expect(globToRegExp(pattern).test("ctf:link:x")).toBe(false);
    }
  });

  it("never matches the admin roster, grant generations, issued codes or spent bootstrap hashes", () => {
    for (const key of ["ctf:admin:grants", "ctf:admin:grant-gen", "ctf:admin:claim:spent", `ctf:admin:code:${"a".repeat(64)}`]) {
      expect(RESET_PREFIXES.some(([, pattern]) => globToRegExp(pattern).test(key))).toBe(false);
    }
  });

  it("wipes the re-link blocklist, and no link key matches that row's pattern", () => {
    const rows = RESET_PREFIXES.filter(([, pattern]) => globToRegExp(pattern).test("ctf:relink:blocked"));
    expect(rows.map(([label]) => label)).toEqual(["relinkBlock"]);
    for (const [, pattern] of rows) expect(globToRegExp(pattern).test("ctf:link:x")).toBe(false);
  });

  it("wipes held Secure Development scores", () => {
    for (const key of ["ctf:sd:held:by:octocat", "ctf:sd:held:authors"]) {
      expect(RESET_PREFIXES.some(([, pattern]) => globToRegExp(pattern).test(key))).toBe(true);
    }
  });

  it("keeps the score holds through a master reset", () => {
    for (const [, pattern] of RESET_PREFIXES) {
      expect(globToRegExp(pattern).test("ctf:score-hold:x")).toBe(false);
    }
  });

  it("the matcher does match what a pattern names", () => {
    expect(globToRegExp("ctf:team:*").test("ctf:team:abc")).toBe(true);
  });
});
