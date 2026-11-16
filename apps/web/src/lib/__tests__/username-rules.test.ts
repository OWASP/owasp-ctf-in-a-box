import { describe, expect, it } from "vitest";
import { USERNAME_MAX, USERNAME_MIN, USERNAME_RE, normalizeUsername, usernameProblem } from "@/lib/username-rules";
import { isPlaceholderEmail, placeholderEmail } from "@/lib/placeholder-email";

describe("username rules", () => {
  it("pins the bounds and the character set", () => {
    expect(USERNAME_MIN).toBe(3);
    expect(USERNAME_MAX).toBe(30);
    expect(USERNAME_RE.source).toBe("^[A-Za-z0-9_.]+$");
  });

  it("normalizes by trimming and lowercasing", () => {
    expect(normalizeUsername("  Alice.B_1 ")).toBe("alice.b_1");
  });

  it.each([
    ["abc", null],
    ["a".repeat(30), null],
    ["Alice_99.x", null],
    [" alice ", null],
    ["ab", "too_short"],
    ["  ab  ", "too_short"],
    ["", "too_short"],
    ["a".repeat(31), "too_long"],
    ["al ice", "invalid"],
    ["alice!", "invalid"],
    ["álice", "invalid"],
    ["al-ice", "invalid"],
  ] as const)("usernameProblem(%j) is %s", (raw, problem) => {
    expect(usernameProblem(raw)).toBe(problem);
  });
});

describe("placeholder email", () => {
  it("is a fresh uuid on the reserved .invalid domain", () => {
    const a = placeholderEmail();
    const b = placeholderEmail();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@accounts\.invalid$/);
    expect(a).not.toBe(b);
    expect(isPlaceholderEmail(a)).toBe(true);
  });

  it.each(["octo@github.example.test", "alice@accounts.invalid.example.com", "x@accounts.invalid", "octo@demo.invalid", ""])(
    "does not take %j for a placeholder",
    (email) => {
      expect(isPlaceholderEmail(email)).toBe(false);
    },
  );
});
