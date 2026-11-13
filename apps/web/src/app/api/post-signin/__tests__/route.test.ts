// Route-level wiring for the first-login team steering (issue #217): session
// and stores mocked, asserting where the 302 actually points. The branch
// matrix itself is pinned in lib/__tests__/post-signin.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const ALICE_ID = "0b9e4f3c-1d2a-4c5b-8e6f-7a8b9c0d1e2f";

const { getSession, hasTeam, isAdminLogin } = vi.hoisted(() => ({
  getSession: vi.fn(),
  hasTeam: vi.fn(),
  isAdminLogin: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/team-store", () => ({ hasTeam }));
vi.mock("@/lib/admin-auth", () => ({ isAdminLogin }));

import { GET } from "@/app/api/post-signin/route";

const req = (next?: string) =>
  new Request(`http://box.test/api/post-signin${next ? `?next=${encodeURIComponent(next)}` : ""}`);

// The Location MUST be a relative same-origin path, never an absolute URL:
// behind a proxy `request.url` is the container-local origin (on Fly literally
// localhost:3000), so an absolute redirect built from it sent sign-in to
// localhost. Assert it's relative here, then resolve against the request
// origin so the pathname/hash/origin checks below stay meaningful.
const location = (res: Response) => {
  const url = res.headers.get("location");
  expect(res.status).toBe(302);
  expect(url).toBeTruthy();
  expect(url as string).toMatch(/^\//); // relative path, not "http(s)://..." or "//host"
  expect(url as string).not.toMatch(/^\/\//); // and not protocol-relative
  return new URL(url as string, "http://box.test");
};

beforeEach(() => {
  getSession.mockReset();
  hasTeam.mockReset();
  isAdminLogin.mockReset();
  getSession.mockResolvedValue({ user: { id: ALICE_ID, login: "alice" } });
  isAdminLogin.mockResolvedValue(false);
  hasTeam.mockResolvedValue(true);
});

describe("GET /api/post-signin", () => {
  it("sends a teamless contestant to the team card, keeping the fragment", async () => {
    hasTeam.mockResolvedValue(false);
    const url = location(await GET(req("/quiz")));
    expect(url.pathname).toBe("/profile");
    expect(url.hash).toBe("#team");
  });

  it("sends a teamed contestant to their original destination", async () => {
    const url = location(await GET(req("/quiz")));
    expect(url.pathname).toBe("/quiz");
  });

  // The team lookup is keyed by the player id; admin-ness is still decided on
  // the GitHub login (ADMIN_LOGINS).
  it("asks the team store about the player id and the admin check about the login", async () => {
    await GET(req("/quiz"));
    expect(hasTeam).toHaveBeenCalledWith(ALICE_ID);
    expect(isAdminLogin).toHaveBeenCalledWith("alice");
  });

  it("lands a session whose user id is not a player id at home", async () => {
    getSession.mockResolvedValue({ user: { id: "alice", login: "alice" } });
    const url = location(await GET(req("/quiz")));
    expect(url.pathname).toBe("/");
    expect(hasTeam).not.toHaveBeenCalled();
  });

  it("lets a teamless admin through — checking content is not playing", async () => {
    hasTeam.mockResolvedValue(false);
    isAdminLogin.mockResolvedValue(true);
    const url = location(await GET(req("/admin")));
    expect(url.pathname).toBe("/admin");
  });

  it("passes a /join invite through for a teamless contestant", async () => {
    hasTeam.mockResolvedValue(false);
    const url = location(await GET(req("/join/ab12cd")));
    expect(url.pathname).toBe("/join/ab12cd");
  });

  it("refuses an absolute next — the parameter rides an OAuth round-trip", async () => {
    const url = location(await GET(req("https://evil.example/")));
    expect(url.origin).toBe("http://box.test");
    expect(url.pathname).toBe("/profile");
  });

  it("refuses URL-parser whitespace that would re-collapse into another origin", async () => {
    // /%09/evil.example decodes to "/\t/evil.example"; the URL parser strips
    // the tab, leaving protocol-relative //evil.example.
    const url = location(await GET(req("/\t/evil.example")));
    expect(url.origin).toBe("http://box.test");
    expect(url.pathname).toBe("/profile");
  });

  it("lands home when there is no session", async () => {
    getSession.mockResolvedValue(null);
    const url = location(await GET(req("/quiz")));
    expect(url.pathname).toBe("/");
    expect(hasTeam).not.toHaveBeenCalled();
  });

  it("defaults to /profile with no next at all", async () => {
    const url = location(await GET(req()));
    expect(url.pathname).toBe("/profile");
  });
});
