// Sign-out landing rules. Signing out used to router.refresh() in place
// unconditionally, so doing it from /admin re-rendered the "Forbidden" wall
// and from /profile the sign-in prompt — an error-shaped screen for a
// perfectly normal action. signOutDestination decides: home from a
// session-gated page, stay put (null = refresh) from a public one.
//
// Tested as the exported pure function: the click handler is client state a
// static render cannot drive (no testing-library in this repo, by choice).

import { describe, expect, it } from "vitest";
import { showAdminLink, signOutDestination } from "@/components/auth-nav";

// Config v2: there is no client-side admin allowlist any more (ADMIN_LOGINS
// is server-only), so the Admin menu item exists only once the /api/me/admin
// round-trip resolves for the CURRENT user. Proven as a pure function for
// the same reason signOutDestination is: no @testing-library/jsdom-act in
// this repo to observe a live re-render.
describe("showAdminLink", () => {
  it("is false before the round-trip resolves", () => {
    expect(showAdminLink("alice", null)).toBe(false);
  });

  it("is true once the round-trip grants the current user", () => {
    expect(showAdminLink("alice", { userId: "alice", admin: true })).toBe(true);
  });

  it("is false when the round-trip refused the current user", () => {
    expect(showAdminLink("alice", { userId: "alice", admin: false })).toBe(false);
  });

  it("is false when the resolved answer is for a stale/different user", () => {
    // Switching accounts must not carry the previous viewer's answer over.
    expect(showAdminLink("bob", { userId: "alice", admin: true })).toBe(false);
  });

  it("is false with no signed-in user at all", () => {
    expect(showAdminLink(undefined, { userId: "alice", admin: true })).toBe(false);
  });
});

describe("signOutDestination", () => {
  it("sends session-gated pages home, including their subpaths", () => {
    expect(signOutDestination("/admin")).toBe("/");
    expect(signOutDestination("/profile")).toBe("/");
    expect(signOutDestination("/admin/anything")).toBe("/");
  });

  it("stays put on public pages — a refresh just re-renders them signed out", () => {
    expect(signOutDestination("/")).toBeNull();
    expect(signOutDestination("/flags")).toBeNull();
    expect(signOutDestination("/flags/crypto-1")).toBeNull();
    expect(signOutDestination("/leaderboard")).toBeNull();
    expect(signOutDestination("/quiz")).toBeNull();
  });

  it("matches whole path segments, not raw prefixes", () => {
    // A hypothetical public /profiles or /administrivia must not redirect.
    expect(signOutDestination("/profiles")).toBeNull();
    expect(signOutDestination("/administrivia")).toBeNull();
  });
});
