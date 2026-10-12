// The pure rules for a classic challenge's EXTRA accepted flags and its
// optional regex patterns (#192): what authoring refuses, and how a pattern
// is matched at grade time. Client-safe, so the admin form, the bundle parser
// and the store all run exactly these.

import { describe, expect, it } from "vitest";
import {
  CLASSIC_ALT_FLAGS_MAX,
  CLASSIC_FLAG_MAX_LEN,
  CLASSIC_FLAG_PATTERNS_MAX,
  CLASSIC_FLAG_PATTERN_MAX_LEN,
  CLASSIC_PATTERN_INPUT_MAX,
  flagListIssues,
  canonicalFlagPattern,
  flagPatternProblem,
  matchesFlagPattern,
  splitFlagLines,
} from "@/lib/classic-flags";

describe("flagPatternProblem — what a pattern may be", () => {
  it("accepts the shapes the issue asks for: a fixed-length hex answer, alternatives, a bounded embedded value", () => {
    expect(flagPatternProblem("[0-9a-f]{32}")).toBeNull();
    expect(flagPatternProblem("ctf\\{(md5|sha1)_[0-9a-f]{8}\\}")).toBeNull();
    expect(flagPatternProblem("flag\\{colou?r\\}")).toBeNull();
    expect(flagPatternProblem("ctf\\{\\w{1,16}_\\w{1,16}_\\w{1,16}\\}")).toBeNull();
    expect(flagPatternProblem("(?<word>[a-z]+)-\\d+")).toBeNull();
    // A repeat of a group with no choice inside it is linear.
    expect(flagPatternProblem("(ab)+c")).toBeNull();
    // `?` on a group with a choice inside never repeats it.
    expect(flagPatternProblem("x(a|b)?y")).toBeNull();
  });

  it("refuses a pattern over the length cap", () => {
    expect(flagPatternProblem("a".repeat(CLASSIC_FLAG_PATTERN_MAX_LEN))).toBeNull();
    expect(flagPatternProblem("a".repeat(CLASSIC_FLAG_PATTERN_MAX_LEN + 1))).toMatch(/at most/);
  });

  it("refuses a pattern that is not a valid regular expression", () => {
    expect(flagPatternProblem("ctf{[a-z")).toMatch(/valid regular expression/);
    expect(flagPatternProblem("a{2")).toMatch(/valid regular expression/);
  });

  // The pattern is wrapped as ^(?:p)$ to anchor it. An unbalanced pattern
  // would close that wrapper early and un-anchor the rest — `x)|(.*` would
  // become ^(?:x)|(.*)$ and accept anything.
  it("refuses a pattern that would escape the anchoring wrapper", () => {
    expect(flagPatternProblem("x)|(.*")).not.toBeNull();
    expect(flagPatternProblem("x)|(?:y")).not.toBeNull();
  });

  it("refuses backreferences and lookarounds", () => {
    expect(flagPatternProblem("(a)\\1")).toMatch(/[Bb]ackreference/);
    expect(flagPatternProblem("(?<x>a)\\k<x>")).toMatch(/[Bb]ackreference/);
    expect(flagPatternProblem("a(?=b)b")).toMatch(/[Ll]ookahead|lookbehind/);
    expect(flagPatternProblem("a(?!c)b")).toMatch(/[Ll]ookahead|lookbehind/);
    expect(flagPatternProblem("(?<=a)b")).toMatch(/[Ll]ookahead|lookbehind/);
    expect(flagPatternProblem("(?<!a)b")).toMatch(/[Ll]ookahead|lookbehind/);
  });

  // The catastrophic shapes: a repeat whose body can itself match the same
  // text more than one way.
  it("refuses a repeated group that contains a repeat or an alternation", () => {
    for (const p of ["(a+)+b", "(a*)*b", "(a|aa)+b", "(a|b)*c", "(\\w+\\s?)*x", "(?:a?){5}b", "(a|b){3}"]) {
      expect(flagPatternProblem(p), p).toMatch(/repeated group/);
    }
  });

  it("refuses a pattern with too many ways to match, even without nesting", () => {
    // Three unbounded repeats in a row: ~129^3 backtracking paths on a
    // 128-character input.
    expect(flagPatternProblem("\\w*\\w*\\w*!")).toMatch(/[Tt]oo many ways/);
    // A long run of optional atoms: 2^21.
    expect(flagPatternProblem("a?".repeat(21) + "b")).toMatch(/[Tt]oo many ways/);
    // Alternation multiplies too: (a|a) twenty times is 2^20.
    expect(flagPatternProblem("(a|a)".repeat(20) + "b")).toMatch(/[Tt]oo many ways/);
    // Two unbounded repeats stay allowed.
    expect(flagPatternProblem("ctf\\{\\w+_\\w+\\}")).toBeNull();
  });

  it("refuses a pattern that matches the empty flag", () => {
    for (const p of [".*", "a?", "(abc)?", "|x", "x|"]) expect(flagPatternProblem(p), p).toMatch(/empty/);
  });

  it("refuses a pattern that accepts any input at all", () => {
    for (const p of [".+", "[\\s\\S]+", "[^]+", ".{1,128}"]) expect(flagPatternProblem(p), p).toMatch(/any input/);
  });

  // #500: a message goes back to the admin client verbatim and must name the
  // rule, never the submitted text.
  it("never echoes the pattern in its message", () => {
    const secret = "SECRETPATTERN";
    for (const p of [`${secret}(`, `(${secret}+)+`, `${secret}\\1`, `${secret}|`, `${secret}`.repeat(30)]) {
      const problem = flagPatternProblem(p);
      expect(problem).not.toBeNull();
      expect(problem).not.toContain(secret);
    }
  });
});

describe("matchesFlagPattern — how a submission is matched", () => {
  it("matches the WHOLE submission, never a substring", () => {
    expect(matchesFlagPattern(["[0-9a-f]{4}"], "beef", false)).toBe(true);
    expect(matchesFlagPattern(["[0-9a-f]{4}"], "xbeefx", false)).toBe(false);
    expect(matchesFlagPattern(["ctf|flag"], "ctf", false)).toBe(true);
    // Alternation is inside the anchors, not split by them.
    expect(matchesFlagPattern(["ctf|flag"], "ctfx", false)).toBe(false);
    expect(matchesFlagPattern(["ctf|flag"], "xflag", false)).toBe(false);
  });

  it("trims and NFC-normalizes the submission first, like every flag", () => {
    expect(matchesFlagPattern(["café"], "  café  ", false)).toBe(true);
  });

  // The normalisation trap from the issue: `normalizeFlag` lowercases, so a
  // pattern compared against that form could never match [A-F]. Patterns
  // follow the challenge's case mode instead.
  it("ignores case when the challenge is not case-sensitive, in both directions", () => {
    expect(matchesFlagPattern(["[A-F]{2}"], "ab", false)).toBe(true);
    expect(matchesFlagPattern(["[a-f]{2}"], "AB", false)).toBe(true);
  });

  it("respects case when the challenge is case-sensitive", () => {
    expect(matchesFlagPattern(["[A-F]{2}"], "AB", true)).toBe(true);
    expect(matchesFlagPattern(["[A-F]{2}"], "ab", true)).toBe(false);
  });

  // The input is NFC; a pattern holding a decomposed accent (e + U+0301)
  // would otherwise never match it.
  it("matches a pattern written with a decomposed accent against either spelling of the input", () => {
    const decomposed = "cafe\u0301-[0-9]{2}";
    expect(decomposed).not.toBe(decomposed.normalize("NFC"));
    expect(matchesFlagPattern([decomposed], "caf\u00e9-12", false)).toBe(true);
    expect(matchesFlagPattern([decomposed], "cafe\u0301-12", false)).toBe(true);
  });

  it("accepts a match against any of several patterns", () => {
    expect(matchesFlagPattern(["x{3}", "y{3}"], "yyy", false)).toBe(true);
    expect(matchesFlagPattern(["x{3}", "y{3}"], "zzz", false)).toBe(false);
  });

  it("never regex-matches a submission over the input cap", () => {
    const long = "a".repeat(CLASSIC_PATTERN_INPUT_MAX + 1);
    expect(matchesFlagPattern(["a+"], long, false)).toBe(false);
    expect(matchesFlagPattern(["a+"], "a".repeat(CLASSIC_PATTERN_INPUT_MAX), false)).toBe(true);
  });

  // Defence in depth: a stored pattern that would fail authoring today (a
  // hand-edited Redis value, a rule tightened later) is skipped, never run.
  it("skips a stored pattern that fails the authoring rules instead of running it", () => {
    expect(matchesFlagPattern(["(a+)+b", "ok"], "ok", false)).toBe(true);
    expect(matchesFlagPattern(["(a+)+b"], "aaab", false)).toBe(false);
    expect(matchesFlagPattern([".*"], "anything", false)).toBe(false);
  });

  it("matches nothing with no patterns", () => {
    expect(matchesFlagPattern([], "x", false)).toBe(false);
  });
});

describe("flagListIssues — the lists as a whole", () => {
  it("accepts absent-equivalent empty lists", () => {
    expect(flagListIssues("alternateFlags", [])).toEqual([]);
    expect(flagListIssues("flagPatterns", [])).toEqual([]);
  });

  it("refuses a non-array and a non-string entry, naming the position", () => {
    expect(flagListIssues("alternateFlags", "CTF{x}")).toEqual([
      { where: "alternateFlags", message: expect.stringMatching(/array/) },
    ]);
    expect(flagListIssues("flagPatterns", ["ok", 3])).toEqual([
      { where: "flagPatterns[1]", message: expect.stringMatching(/string/) },
    ]);
  });

  // Anti-vacuous (#192): an empty accepted flag or an empty pattern would be
  // an answer nobody authored.
  it("refuses an empty or whitespace-only entry", () => {
    expect(flagListIssues("alternateFlags", ["CTF{a}", "  "])).toEqual([
      { where: "alternateFlags[1]", message: expect.stringMatching(/empty/) },
    ]);
    expect(flagListIssues("flagPatterns", [""])).toEqual([
      { where: "flagPatterns[0]", message: expect.stringMatching(/empty/) },
    ]);
  });

  it("caps the number of entries", () => {
    const flags = Array.from({ length: CLASSIC_ALT_FLAGS_MAX + 1 }, (_, i) => `CTF{${i}}`);
    expect(flagListIssues("alternateFlags", flags.slice(0, -1))).toEqual([]);
    expect(flagListIssues("alternateFlags", flags)).toContainEqual({
      where: "alternateFlags",
      message: expect.stringMatching(new RegExp(`At most ${CLASSIC_ALT_FLAGS_MAX}`)),
    });
    const patterns = Array.from({ length: CLASSIC_FLAG_PATTERNS_MAX + 1 }, (_, i) => `x{${i + 1}}`);
    expect(flagListIssues("flagPatterns", patterns)).toContainEqual({
      where: "flagPatterns",
      message: expect.stringMatching(new RegExp(`At most ${CLASSIC_FLAG_PATTERNS_MAX}`)),
    });
  });

  it("refuses an accepted flag longer than a submission can ever be", () => {
    expect(flagListIssues("alternateFlags", ["a".repeat(CLASSIC_FLAG_MAX_LEN)])).toEqual([]);
    expect(flagListIssues("alternateFlags", ["a".repeat(CLASSIC_FLAG_MAX_LEN + 1)])).toEqual([
      { where: "alternateFlags[0]", message: expect.stringMatching(/at most/) },
    ]);
  });

  it("runs every pattern through the authoring rules, naming its position", () => {
    expect(flagListIssues("flagPatterns", ["ok{2}", "(a+)+"])).toEqual([
      { where: "flagPatterns[1]", message: expect.stringMatching(/repeated group/) },
    ]);
  });

  it("never echoes an entry in a message", () => {
    const issues = [
      ...flagListIssues("alternateFlags", ["SECRET".repeat(200)]),
      ...flagListIssues("flagPatterns", ["SECRET(", "(SECRET+)+"]),
    ];
    expect(issues.length).toBe(3);
    expect(JSON.stringify(issues)).not.toContain("SECRET");
  });
});

describe("splitFlagLines — the admin form's one-per-line text", () => {
  it("trims each line and drops blank ones", () => {
    expect(splitFlagLines("  CTF{a}  \n\n CTF{b}\r\n   \n")).toEqual(["CTF{a}", "CTF{b}"]);
    expect(splitFlagLines("")).toEqual([]);
  });
});

describe("canonicalFlagPattern", () => {
  it("trims and NFC-normalizes, the form a pattern is stored and matched in", () => {
    expect(canonicalFlagPattern("  cafe\u0301{2}  ")).toBe("caf\u00e9{2}");
  });
});
