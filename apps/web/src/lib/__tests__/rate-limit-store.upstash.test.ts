// CONSUME_SCRIPT (rate-limit-store.ts) EXECUTED against a live Redis: the
// mocked suite fakes the script's reply, so the window arithmetic itself was
// never run. A run-unique bucket keeps the key throwaway. The window is two
// seconds so the expiry is observed for real, which is what separates "the
// window starts at the first request" from "every request extends it".
// See live-redis.ts for the harness.

import { afterAll, describe, expect, it, vi } from "vitest";
import { RUN, liveConfigured } from "./live-redis";

vi.mock("server-only", () => ({}));

describe.skipIf(!liveConfigured)("CONSUME_SCRIPT against a live Redis", () => {
  const bucket = `ctf-test-${RUN}`;

  afterAll(async () => {
    const { upstashPipeline } = await import("@/lib/upstash");
    await upstashPipeline([["DEL", `ctf:rl:${bucket}:alice`, `ctf:rl:${bucket}:bob`]]);
  });

  it("allows the limit, refuses the next with the window's remaining time, and resets when it ends", async () => {
    const { consumeRateLimit } = await import("@/lib/rate-limit-store");
    const take = () => consumeRateLimit(bucket, "Alice", 3, 2);
    expect(await take()).toEqual({ allowed: true });
    expect(await take()).toEqual({ allowed: true });
    expect(await take()).toEqual({ allowed: true });
    const refused = await take();
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(2);
    }
    // The login is case-folded: another spelling shares the budget.
    expect((await consumeRateLimit(bucket, "alice", 3, 2)).allowed).toBe(false);
    // A different login has its own.
    expect(await consumeRateLimit(bucket, "bob", 3, 2)).toEqual({ allowed: true });
  });

  // Requests keep arriving inside the window. If each one pushed the expiry
  // out, the window would never end while the caller kept trying.
  it("does not extend the window on later requests", async () => {
    const { consumeRateLimit } = await import("@/lib/rate-limit-store");
    const login = `late-${RUN}`;
    const take = () => consumeRateLimit(bucket, login, 1, 2);
    expect(await take()).toEqual({ allowed: true });
    await new Promise((r) => setTimeout(r, 1200));
    expect((await take()).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 1100));
    expect(await take()).toEqual({ allowed: true });
    const { upstashPipeline } = await import("@/lib/upstash");
    await upstashPipeline([["DEL", `ctf:rl:${bucket}:${login}`]]);
  }, 10_000);
});
