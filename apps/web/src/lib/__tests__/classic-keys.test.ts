import { describe, expect, it } from "vitest";
import {
  CLASSIC_ID_RE,
  challengeCurrentValue,
  dynamicPoints,
  generateChallengeId,
  hasDynamicScoring,
  normalizeFlag,
} from "@/lib/classic-keys";

describe("normalizeFlag", () => {
  it("trims and lowercases", () => {
    expect(normalizeFlag("  CTF{Hello_World}  ")).toBe("ctf{hello_world}");
  });

  it("is idempotent", () => {
    const once = normalizeFlag(" CTF{X} ");
    expect(normalizeFlag(once)).toBe(once);
  });

  // The reason normalization is forbidden in Lua: string.lower is ASCII-only,
  // so a Lua-side normalization of this flag would not equal the JS-side one
  // and the challenge would be permanently unsolvable.
  it("handles non-ASCII without corrupting it", () => {
    expect(normalizeFlag("CTF{ÜBER}")).toBe("ctf{über}");
  });

  it("unifies Unicode composition so visually identical flags match", () => {
    const composed = "CTF{\u00e9}";     // e-acute as ONE code point
    const decomposed = "CTF{e\u0301}";   // e + combining acute
    // Guard against vacuity: if these ever become the same literal, the
    // assertion below passes trivially and proves nothing.
    expect(composed).not.toBe(decomposed);
    expect(normalizeFlag(composed)).toBe(normalizeFlag(decomposed));
  });
});

describe("generateChallengeId", () => {
  it("builds a slug plus suffix that satisfies the store's own pattern", () => {
    expect(generateChallengeId("SQL Injection 101", "abc123")).toBe("sql-injection-101-abc123");
    expect(CLASSIC_ID_RE.test(generateChallengeId("SQL Injection 101", "abc123"))).toBe(true);
  });

  it("never emits an id the store would reject, even from a hostile suffix", () => {
    expect(CLASSIC_ID_RE.test(generateChallengeId("x", "../../etc/passwd"))).toBe(true);
  });

  it("falls back to a valid id for an untransliterable title", () => {
    expect(CLASSIC_ID_RE.test(generateChallengeId("日本語", "abc123"))).toBe(true);
  });

  it("gives two identically-titled challenges different ids", () => {
    expect(generateChallengeId("Same", "aaaaaa")).not.toBe(generateChallengeId("Same", "bbbbbb"));
  });
});

describe("dynamicPoints", () => {
  const max = 500;
  const min = 100;
  const decay = 10;

  it("yields maxPoints at 0 solves (nobody yet) and negative counts", () => {
    expect(dynamicPoints(max, min, decay, 0)).toBe(500);
    expect(dynamicPoints(max, min, decay, -1)).toBe(500);
  });

  it("yields minPoints at exactly decay solves", () => {
    expect(dynamicPoints(max, min, decay, decay)).toBe(100);
  });

  it("remains clamped to minPoints beyond decay solves", () => {
    expect(dynamicPoints(max, min, decay, decay + 1)).toBe(100);
    expect(dynamicPoints(max, min, decay, 100)).toBe(100);
  });

  it("computes ceil(max + ((min - max) / decay^2) * n^2) correctly", () => {
    // max=500, min=100, decay=10:
    // (min - max) / decay^2 = -400 / 100 = -4
    // n=1: 500 - 4*(1) = 496
    expect(dynamicPoints(max, min, decay, 1)).toBe(496);
    // n=2: 500 - 4*(4) = 484
    expect(dynamicPoints(max, min, decay, 2)).toBe(484);
    // n=5: 500 - 4*(25) = 400
    expect(dynamicPoints(max, min, decay, 5)).toBe(400);
  });

  it("is integer-valued through Math.ceil", () => {
    // When formula produces non-integers, Math.ceil rounds up
    // max=500, min=100, decay=30:
    // (min - max) / decay^2 = -400 / 900 = -4/9 = -0.4444...
    // n=1: 500 - 0.4444 = 499.555 -> ceil is 500
    // n=2: 500 - 4*(4/9) = 500 - 1.777... = 498.222 -> ceil is 499
    expect(dynamicPoints(500, 100, 30, 1)).toBe(500);
    expect(dynamicPoints(500, 100, 30, 2)).toBe(499);
    for (let n = 0; n <= 35; n++) {
      const val = dynamicPoints(500, 100, 30, n);
      expect(Number.isInteger(val)).toBe(true);
    }
  });

  it("is monotonically non-increasing across the decay range", () => {
    let prev = dynamicPoints(max, min, decay, 0);
    for (let n = 1; n <= decay + 5; n++) {
      const curr = dynamicPoints(max, min, decay, n);
      expect(curr).toBeLessThanOrEqual(prev);
      expect(curr).toBeGreaterThanOrEqual(min);
      prev = curr;
    }
  });

  it("handles min equal to max by staying constant", () => {
    expect(dynamicPoints(100, 100, 10, 0)).toBe(100);
    expect(dynamicPoints(100, 100, 10, 5)).toBe(100);
    expect(dynamicPoints(100, 100, 10, 10)).toBe(100);
    expect(dynamicPoints(100, 100, 10, 20)).toBe(100);
  });
});

describe("hasDynamicScoring", () => {
  it("returns true only when all three dynamic fields are numbers", () => {
    expect(hasDynamicScoring({ maxPoints: 500, minPoints: 100, decay: 10 })).toBe(true);
  });

  it("returns false when any field is missing or not a number", () => {
    expect(hasDynamicScoring({})).toBe(false);
    expect(hasDynamicScoring({ maxPoints: 500 })).toBe(false);
    expect(hasDynamicScoring({ maxPoints: 500, minPoints: 100 })).toBe(false);
    expect(hasDynamicScoring({ maxPoints: 500, minPoints: 100, decay: undefined })).toBe(false);
  });
});

describe("challengeCurrentValue", () => {
  it("returns static challenge points regardless of solve count", () => {
    const staticChal = { points: 50 };
    expect(challengeCurrentValue(staticChal, 0)).toBe(50);
    expect(challengeCurrentValue(staticChal, 5)).toBe(50);
    expect(challengeCurrentValue(staticChal, 100)).toBe(50);
  });

  it("returns decayed value for dynamic challenge based on solve count", () => {
    const dynamicChal = { points: 500, maxPoints: 500, minPoints: 100, decay: 10 };
    expect(challengeCurrentValue(dynamicChal, 0)).toBe(500);
    expect(challengeCurrentValue(dynamicChal, 1)).toBe(496);
    expect(challengeCurrentValue(dynamicChal, 2)).toBe(484);
    expect(challengeCurrentValue(dynamicChal, 10)).toBe(100);
    expect(challengeCurrentValue(dynamicChal, 20)).toBe(100);
  });
});