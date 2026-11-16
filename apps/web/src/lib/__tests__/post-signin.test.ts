// Pure decision logic for the first-login team steering (issue #217). The
// route handler's own test covers the wiring; this pins the sanitizer (the
// `next` parameter is attacker-influencable) and the branch matrix.
import { describe, expect, it } from "vitest";

import {
  POST_SIGNIN_PATH,
  TEAM_SETUP_PATH,
  oauthErrorCallbackURL,
  postSigninCallbackURL,
  resolvePostSigninTarget,
  sanitizeNext,
  signInHref,
} from "@/lib/post-signin";

describe("postSigninCallbackURL", () => {
  it("routes through the post-signin path with the intent encoded", () => {
    expect(postSigninCallbackURL("/quiz")).toBe(`${POST_SIGNIN_PATH}?next=%2Fquiz`);
  });

  it("round-trips a path that itself carries a query or fragment", () => {
    const url = postSigninCallbackURL("/profile#team");
    const next = new URL(`http://x${url}`).searchParams.get("next");
    expect(next).toBe("/profile#team");
  });
});

describe("sanitizeNext", () => {
  it("keeps a same-origin path", () => {
    expect(sanitizeNext("/flags")).toBe("/flags");
  });

  it.each([
    [null],
    [undefined],
    [""],
    ["https://evil.example/"],
    ["//evil.example/"],
    ["/\\evil.example/"],
    ["quiz"],
    // The URL parser strips tab/newline/CR BEFORE parsing, so these would
    // re-collapse into protocol-relative //evil.example at resolve time.
    ["/\t/evil.example"],
    ["/\n/evil.example"],
    ["/\r/evil.example"],
    ["/quiz\t"],
  ])("falls back to /profile for %j", (raw) => {
    expect(sanitizeNext(raw as string | null | undefined)).toBe("/profile");
  });
});

describe("oauthErrorCallbackURL", () => {
  it("encodes a valid local destination as ?next= on the landing page", () => {
    expect(oauthErrorCallbackURL("/challenges")).toBe("/?next=%2Fchallenges");
  });

  it("sanitizes the destination the same way the return trip does — never a bare pass-through", () => {
    // Same shape of proof sanitizeNext's own suite runs: a protocol-relative
    // or absolute destination must not survive into the encoded URL.
    expect(oauthErrorCallbackURL("//evil.example")).toBe("/?next=%2Fprofile");
    expect(oauthErrorCallbackURL("https://evil.example")).toBe("/?next=%2Fprofile");
  });
});

describe("resolvePostSigninTarget", () => {
  it("sends a teamless contestant to team setup, not their destination", () => {
    expect(resolvePostSigninTarget({ next: "/quiz", isAdmin: false, teamless: true, needsUsername: false })).toBe(
      TEAM_SETUP_PATH,
    );
  });

  it("lets a teamed contestant through to their destination", () => {
    expect(resolvePostSigninTarget({ next: "/quiz", isAdmin: false, teamless: false, needsUsername: false })).toBe("/quiz");
  });

  it("lets an admin through even when teamless — checking content is not playing", () => {
    expect(resolvePostSigninTarget({ next: "/admin", isAdmin: true, teamless: true, needsUsername: false })).toBe("/admin");
  });

  it("passes a /join/<code> invite through even when teamless — the invite IS the team step", () => {
    expect(resolvePostSigninTarget({ next: "/join/ab12cd", isAdmin: false, teamless: true, needsUsername: false })).toBe(
      "/join/ab12cd",
    );
  });
});

describe("resolvePostSigninTarget with no username yet", () => {
  const base = { isAdmin: false, teamless: false, needsUsername: true };

  it("goes to /welcome first, carrying the destination it would otherwise return", () => {
    expect(resolvePostSigninTarget({ ...base, next: "/quiz" })).toBe("/welcome?next=%2Fquiz");
    expect(resolvePostSigninTarget({ ...base, next: "/quiz", teamless: true })).toBe(
      "/welcome?next=%2Fprofile%23team",
    );
  });

  it("outranks the /join/ and admin exemptions", () => {
    expect(resolvePostSigninTarget({ ...base, next: "/join/abc", teamless: true })).toBe("/welcome?next=%2Fjoin%2Fabc");
    expect(resolvePostSigninTarget({ ...base, next: "/admin", isAdmin: true })).toBe("/welcome?next=%2Fadmin");
  });

  it("changes nothing once a username is set", () => {
    expect(resolvePostSigninTarget({ ...base, needsUsername: false, next: "/quiz" })).toBe("/quiz");
  });
});

describe("signInHref", () => {
  it("sends the destination to the sign-in page, encoded", () => {
    expect(signInHref("/flags")).toBe("/sign-in?next=%2Fflags");
    expect(signInHref("/profile#team")).toBe("/sign-in?next=%2Fprofile%23team");
  });

  it("sanitizes a protocol-relative destination", () => {
    expect(signInHref("//evil")).toBe("/sign-in?next=%2Fprofile");
  });
});
