// A classic challenge's EXTRA accepted flags and its optional regex patterns
// (#192): the authoring rules and the grade-time matcher.
//
// CLIENT-SAFE and dependency-free apart from classic-keys.ts (itself
// dependency-free), for the same reason classic-io.ts is: the admin form and
// the bundle parser run in the browser and must refuse exactly what the store
// refuses, so all three import these functions rather than keeping copies.
//
// THE REGEX DESIGN, and its limits. Redis Lua has no regex engine, so a
// pattern is matched here, in JS, and the grading script receives only a
// verdict bound to the stored patterns it was computed against (see
// SUBMIT_SCRIPT in classic-store.ts). A pattern is organizer-authored but runs
// on every submission, on the path contestants hit hardest, so it is a
// denial-of-service surface. What bounds it:
//
//   - Anchored: compiled as ^(?:pattern)$, so it matches the WHOLE flag and
//     the engine tries one start position. The pattern is also compiled ALONE
//     first, so an unbalanced `x)|(.*` cannot close the wrapper early.
//   - Small: at most CLASSIC_FLAG_PATTERN_MAX_LEN characters, at most
//     CLASSIC_FLAG_PATTERNS_MAX per challenge.
//   - Short input: a submission longer than CLASSIC_PATTERN_INPUT_MAX (after
//     trim + NFC) is never regex-matched; exact flags still apply to it.
//   - No backreferences and no lookarounds.
//   - No repeated group that contains a repeat or an alternation — the
//     (a+)+ / (a|aa)* shapes whose backtracking is exponential. A group
//     followed by `?` (or {0,1}, {1}) is not a repeat and stays allowed.
//   - A budget on the ways to match: each choice point multiplies the number
//     of backtracking paths (a `?` by 2, an alternation by its branch count, a
//     `*`/`+`/{n,} by the input cap + 1, a {n,m} by its span), and the product
//     must stay within CLASSIC_PATTERN_PATHS_MAX. With nesting refused, that
//     product bounds the backtracking; at the cap a worst-case input costs well
//     under a millisecond per pattern on Node 22.
//
// Anti-vacuous: a pattern that matches the empty flag, or one that accepts
// every probe in VACUOUS_PROBES (`.+` and friends), is refused at authoring.
//
// Case: a pattern follows the challenge's case-sensitive box. Unticked, it is
// compiled with the `i` flag and matched against the trimmed, NFC form — NOT
// the lowercased form exact flags compare, which would make [A-F] unmatchable.
// The `u` flag is always on: strict syntax, Unicode case folding.
//
// Messages name the rule and, from flagListIssues, the position — never the
// submitted text (#500): they reach the admin client verbatim.

import { caseSensitiveFlagForm } from "@/lib/classic-keys";

/** An accepted flag longer than this can never be submitted: the submit
 *  route refuses a body flag over 512 characters. */
export const CLASSIC_FLAG_MAX_LEN = 512;
/** Extra accepted flags per challenge, beyond the primary one. */
export const CLASSIC_ALT_FLAGS_MAX = 20;
/** Regex patterns per challenge. */
export const CLASSIC_FLAG_PATTERNS_MAX = 5;
/** Characters per pattern. */
export const CLASSIC_FLAG_PATTERN_MAX_LEN = 200;
/** A submission longer than this (trimmed, NFC) is never regex-matched. */
export const CLASSIC_PATTERN_INPUT_MAX = 128;
/** The backtracking-path budget per pattern (see the header). */
export const CLASSIC_PATTERN_PATHS_MAX = 100_000;

/** The two list fields a challenge may carry, as named in payloads, bundles
 *  and messages. */
export type FlagListField = "alternateFlags" | "flagPatterns";

/** One problem with a list: `where` is the field or `field[i]`. */
export type FlagListIssue = { where: string; message: string };

/** Distinct inputs a real answer pattern cannot all accept. A pattern that
 *  matches every one of them is a catch-all, not an answer. */
const VACUOUS_PROBES = ["a", "Z", "0", "~", " x ", "ctf{x}", "anything at all", "é"];

/** Path counts saturate here so a product never becomes Infinity or NaN. */
const PATHS_CEILING = 1e15;

type Frame = { alts: number[]; cur: number; last: number | null };

const QUANTIFIER_RE = /^\{(\d+)(,(\d*))?\}/;

/** Scans a pattern that already compiled, for the constructs the header
 *  refuses, and counts its backtracking paths. Returns the rule broken, or
 *  null. Only shapes matter here, so escapes and classes are skipped whole. */
function scanPattern(p: string): string | null {
  const stack: Frame[] = [{ alts: [], cur: 1, last: null }];
  const top = () => stack[stack.length - 1];
  const atom = (paths: number) => {
    const f = top();
    f.cur = Math.min(f.cur * paths, PATHS_CEILING);
    f.last = paths;
  };

  let i = 0;
  while (i < p.length) {
    const ch = p[i];
    if (ch === "\\") {
      const next = p[i + 1] ?? "";
      if (/[1-9]/.test(next) || next === "k") return "Backreferences (\\1, \\k<name>) are not allowed in a flag pattern";
      if ((next === "p" || next === "P" || next === "u") && p[i + 2] === "{") {
        const close = p.indexOf("}", i + 3);
        i = close === -1 ? p.length : close + 1;
      } else {
        i += 2;
      }
      atom(1);
      continue;
    }
    if (ch === "[") {
      let j = i + 1;
      while (j < p.length && p[j] !== "]") j += p[j] === "\\" ? 2 : 1;
      i = j + 1;
      atom(1);
      continue;
    }
    if (ch === "(") {
      if (p[i + 1] === "?") {
        const kind = p[i + 2];
        if (kind === "=" || kind === "!" || (kind === "<" && (p[i + 3] === "=" || p[i + 3] === "!"))) {
          return "Lookahead and lookbehind ((?=, (?!, (?<=, (?<!) are not allowed in a flag pattern";
        }
        if (kind === ":") i += 3;
        else if (kind === "<") {
          const close = p.indexOf(">", i + 3);
          i = close === -1 ? p.length : close + 1;
        } else return "Only plain (…), (?:…) and named (?<name>…) groups are allowed in a flag pattern";
      } else {
        i += 1;
      }
      stack.push({ alts: [], cur: 1, last: null });
      continue;
    }
    if (ch === ")") {
      const f = stack.pop();
      if (!f || stack.length === 0) return "Not a valid regular expression";
      const paths = Math.min([...f.alts, f.cur].reduce((a, b) => a + b, 0), PATHS_CEILING);
      i += 1;
      atom(paths);
      continue;
    }
    if (ch === "|") {
      const f = top();
      f.alts.push(f.cur);
      f.cur = 1;
      f.last = null;
      i += 1;
      continue;
    }
    let min: number | null = null;
    let max = 0; // Infinity for unbounded
    let len = 1;
    if (ch === "*") [min, max] = [0, Infinity];
    else if (ch === "+") [min, max] = [1, Infinity];
    else if (ch === "?") [min, max] = [0, 1];
    else if (ch === "{") {
      const m = QUANTIFIER_RE.exec(p.slice(i));
      if (m) {
        min = Number(m[1]);
        max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
        len = m[0].length;
      }
    }
    if (min !== null) {
      const f = top();
      const p0 = f.last ?? 1;
      let paths: number;
      if (max <= 1) {
        // Not a repeat: `?`, {0,1}, {1}, {1,1}. Optional adds one path.
        paths = min === 0 ? p0 + 1 : p0;
      } else {
        if (p0 > 1) {
          return "A repeated group cannot contain a repeat or an alternation (like (a+)+ or (a|b)*) — it can backtrack catastrophically; use a character class such as [ab]* instead";
        }
        const cap = CLASSIC_PATTERN_INPUT_MAX;
        paths = max === Infinity ? cap + 1 : Math.max(1, Math.min(max, cap) - Math.min(min, cap) + 1);
      }
      f.cur = Math.min((f.cur / p0) * paths, PATHS_CEILING);
      f.last = null;
      i += len;
      if (p[i] === "?") i += 1; // lazy: the same paths, tried in another order
      continue;
    }
    // `^`, `$` and every plain character or `.`: one path.
    i += 1;
    atom(1);
  }

  if (stack.length !== 1) return "Not a valid regular expression";
  const root = stack[0];
  const total = [...root.alts, root.cur].reduce((a, b) => a + b, 0);
  if (total > CLASSIC_PATTERN_PATHS_MAX) {
    return "Too many ways to match: bound the repeats (like {1,32} instead of + or *) or use fewer of them";
  }
  return null;
}

/** Compiles a pattern exactly as grading runs it: anchored, `u`, plus `i`
 *  unless the challenge is case-sensitive. Throws on invalid syntax; callers
 *  check `flagPatternProblem` first. */
export function compileFlagPattern(pattern: string, caseSensitive: boolean): RegExp {
  return new RegExp(`^(?:${pattern})$`, caseSensitive ? "u" : "iu");
}

/** Whether `pattern` may be stored, as the rule it breaks or null. Expects the
 *  TRIMMED pattern (the store trims before it calls this). */
export function flagPatternProblem(pattern: string): string | null {
  if (pattern.length > CLASSIC_FLAG_PATTERN_MAX_LEN) {
    return `A flag pattern must be at most ${CLASSIC_FLAG_PATTERN_MAX_LEN} characters`;
  }
  // Compiled ALONE first: balanced on its own, so the anchoring wrapper below
  // cannot be closed early by the pattern's own parentheses. The SyntaxError's
  // message quotes the pattern, so it is never passed on.
  try {
    new RegExp(pattern, "u");
    compileFlagPattern(pattern, true);
  } catch {
    return "Not a valid regular expression";
  }
  const shape = scanPattern(pattern);
  if (shape) return shape;
  // Safe to run now: the scan bounded what these probes can cost.
  const re = compileFlagPattern(pattern, false);
  if (re.test("")) return "A flag pattern must not match an empty flag";
  if (VACUOUS_PROBES.every((probe) => re.test(caseSensitiveFlagForm(probe)))) {
    return "A flag pattern must not accept any input — make it describe the answer";
  }
  return null;
}

/** The form a pattern is stored and matched in: trimmed and NFC-normalized,
 *  the same normalization every submission gets — a pattern holding a
 *  decomposed accent (e + U+0301) could otherwise never match an NFC input.
 *  Normalizing the source can only merge sequences no NFC input contains. */
export function canonicalFlagPattern(pattern: string): string {
  return pattern.trim().normalize("NFC");
}

/** Whether `submission` matches any of `patterns`, as grading decides it: the
 *  submission trimmed and NFC-normalized, never regex-matched past
 *  CLASSIC_PATTERN_INPUT_MAX, and a stored pattern that fails today's
 *  authoring rules skipped rather than run. */
export function matchesFlagPattern(patterns: readonly string[], submission: string, caseSensitive: boolean): boolean {
  const input = caseSensitiveFlagForm(submission);
  if (input.length === 0 || input.length > CLASSIC_PATTERN_INPUT_MAX) return false;
  for (const raw of patterns) {
    if (typeof raw !== "string") continue;
    const pattern = canonicalFlagPattern(raw);
    if (!pattern || flagPatternProblem(pattern) !== null) continue;
    if (compileFlagPattern(pattern, caseSensitive).test(input)) return true;
  }
  return false;
}

/** Every problem with one list field, positions named, values never echoed.
 *  Entries are judged in the form the store keeps: trimmed, and a pattern
 *  also NFC-normalized (`canonicalFlagPattern`). */
export function flagListIssues(field: FlagListField, raw: unknown): FlagListIssue[] {
  if (!Array.isArray(raw)) return [{ where: field, message: `${field} must be an array of strings` }];
  const issues: FlagListIssue[] = [];
  const max = field === "alternateFlags" ? CLASSIC_ALT_FLAGS_MAX : CLASSIC_FLAG_PATTERNS_MAX;
  if (raw.length > max) {
    issues.push({
      where: field,
      message: field === "alternateFlags" ? `At most ${max} other accepted flags` : `At most ${max} flag patterns`,
    });
  }
  raw.forEach((entry, i) => {
    const where = `${field}[${i}]`;
    if (typeof entry !== "string") return void issues.push({ where, message: "Each entry must be a string" });
    const trimmed = entry.trim();
    if (!trimmed) {
      return void issues.push({
        where,
        message: field === "alternateFlags" ? "An accepted flag cannot be empty" : "A flag pattern cannot be empty",
      });
    }
    if (field === "alternateFlags") {
      if (trimmed.length > CLASSIC_FLAG_MAX_LEN) {
        issues.push({ where, message: `An accepted flag must be at most ${CLASSIC_FLAG_MAX_LEN} characters — a longer one can never be submitted` });
      }
      return;
    }
    const problem = flagPatternProblem(canonicalFlagPattern(trimmed));
    if (problem) issues.push({ where, message: problem });
  });
  return issues;
}

/** The admin form's one-entry-per-line text as a list: each line trimmed,
 *  blank lines dropped (a blank line is spacing, not an empty flag). */
export function splitFlagLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
