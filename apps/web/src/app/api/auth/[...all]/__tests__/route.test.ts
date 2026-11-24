import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The handler reports the fence slot it runs in: a profile link callback's
// database hook can only fence its GitHub account write when the route
// opened one (refuseSecondGithubLinkOnCallback).
const { setWriteFence } = await import("@/lib/auth-store/write-fence");
const handler = vi.hoisted(() => vi.fn<(request: Request) => Promise<Response>>());
vi.mock("@/lib/auth", () => ({ auth: { handler } }));

const { GET, POST } = await import("../route");

describe("auth route", () => {
  it.each([
    ["GET", GET],
    ["POST", POST],
  ])("runs every %s in a write fence slot", async (_method, route) => {
    handler.mockImplementation(async () => Response.json({ slot: setWriteFence(null) }));
    const res = await route(new Request("http://localhost/api/auth/callback/github"));
    expect(await res.json()).toEqual({ slot: true });
    expect(setWriteFence(null)).toBe(false);
  });
});
