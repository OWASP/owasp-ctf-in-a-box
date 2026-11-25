// SCORING_DEADLINE_GUARD against a real Redis: the scoring close is checked
// with Redis's own TIME inside the membership scripts (#824), so this runs the
// guard's Lua for real rather than trusting a mocked verdict.
//
// Gating comes from live-redis.ts: skipped without the env, a FAILURE when
// CTF_LUA_SUITES_REQUIRED=1 (CI).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { RUN, liveConfigured } from "./live-redis";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));

describe.skipIf(!liveConfigured)("SCORING_DEADLINE_GUARD against a live Redis", () => {
  let guard: string;
  let evalScript: (typeof import("@/lib/upstash"))["upstashEval"];

  beforeAll(async () => {
    ({ SCORING_DEADLINE_GUARD: guard } = await import("@/lib/team-store"));
    ({ upstashEval: evalScript } = await import("@/lib/upstash"));
  });

  // The settings key is the real, shared ctf:admin:settings, so these cases
  // pass the scoringEndsAt it currently holds as "read".
  let current = "";
  beforeAll(async () => {
    const { upstashPipeline } = await import("@/lib/upstash");
    const [reply] = await upstashPipeline([["HGET", "ctf:admin:settings", "scoringEndsAt"]]);
    current = typeof reply.result === "string" ? reply.result : "";
  });
  const run = (deadline: string, readEnds = current) =>
    evalScript(guard + "\nreturn 'wrote'", [`ctf:test:${RUN}:deadline`], ["a", "b", readEnds, deadline]);

  it("refuses once Redis's clock is past the deadline", async () => {
    expect(await run(String(Date.now() - 60_000))).toBe("scoring-closed");
  });

  it("lets the write through before the deadline", async () => {
    expect(await run(String(Date.now() + 60 * 60_000))).toBe("wrote");
  });

  it("lets the write through when there is no deadline", async () => {
    expect(await run("")).toBe("wrote");
  });

  it("skips both checks when the caller could not read the settings (fail open)", async () => {
    expect(await run("", "*")).toBe("wrote");
  });

  it("refuses when the close changed since the caller read it", async () => {
    expect(await run("", `${current}-moved`)).toBe("scoring-changed");
  });
});
