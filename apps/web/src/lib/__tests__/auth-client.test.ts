// The real client. Its action proxy answers any path with a function, so
// `typeof authClient.signIn.username` proves nothing. What the username
// plugin adds at runtime is a session refresh after `/sign-in/username`
// (its atom listener), and that is what this checks.
import { describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => {
  const fn = async () =>
    new Response(JSON.stringify({ token: "t", user: { id: "u" } }), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = fn as typeof fetch;
  return fn;
});

import { authClient } from "@/lib/auth-client";

describe("authClient", () => {
  it("signals a session refresh after a username sign-in", async () => {
    expect(globalThis.fetch).toBe(fetchMock);
    const signal = vi.fn();
    // nanostores' listen: called on changes only, not with the current value.
    const stop = authClient.$store.atoms.$sessionSignal.listen(signal);
    const res = await authClient.signIn.username({ username: "alice", password: "p".repeat(12) });
    expect(res.error).toBeNull();
    // The listener flips the signal on a short timer, not inline.
    await vi.waitFor(() => expect(signal).toHaveBeenCalled(), { timeout: 1000 });
    stop();
  });
});
