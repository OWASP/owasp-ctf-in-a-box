// `listChallenges` and `readChallengeRecords` return HIDDEN Jeopardy
// challenges too (disabled, or not yet released): the store cannot know
// whether its caller is a contestant surface. So every CALL has to reach a
// filter from classic-release.ts, and a new reader that forgets would put a
// hidden challenge on some page. This test finds every call in the source
// tree (not a hand-kept list) and follows each one on its own: the filter
// must wrap or chain onto the call, or be applied, later in the same block,
// to the variable the call's result was bound to. A file with one filtered
// call and one unfiltered call fails. A call whose result reaches contestants
// only through another gate is listed in EXEMPT with the reason.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return entry === "__tests__" || entry === "node_modules" ? [] : walk(p);
    return /\.(ts|tsx)$/.test(entry) ? [p] : [];
  });
}

/** Calls that are allowed to stay unfiltered, by file, with how many and
 *  why. A count, so a second unfiltered call in the same file still fails. */
const EXEMPT: Record<string, { calls: number; reason: string }> = {
  "app/(site)/flags/[id]/page.tsx": {
    calls: 2,
    reason:
      "looks up the one challenge the URL names, and renders it or its metadata only after classicVisibility (which filters, and opens hidden ones to admins only) has answered visible",
  },
};

/** Code only: a comment line that names a reader is not a read. */
const code = (src: string) =>
  src
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(line))
    .join("\n");

const CALL = /\b(listChallenges|readChallengeRecords)\(/g;
const FILTER = "visibleNow|visibleChallenges|isChallengeVisible";

/** The index of the element containing the end of `elems` in a
 *  comma-separated list, counting only top-level commas. */
function elementIndex(elems: string): number {
  let depth = 0;
  let index = 0;
  for (const ch of elems) {
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    else if (ch === "," && depth === 0) index += 1;
  }
  return index;
}

/** The variable the call at `at` is bound to, in the same statement: `const x
 *  = await call()`, `const x = (await call()).find(...)`, or position `i` of
 *  `const [a, b] = await Promise.all([e0, e1])`. Null when there is none. */
function boundName(src: string, at: number): string | null {
  const head = src.slice(0, at);
  const decl = [...head.matchAll(/\b(?:const|let)\s+(\[[^\]]*\]|\w+)\s*=\s*/g)].pop();
  if (!decl || decl.index === undefined) return null;
  const between = src.slice(decl.index + decl[0].length, at);
  if (between.includes(";")) return null;
  if (!decl[1].startsWith("[")) return decl[1];
  const all = /Promise\.all(?:Settled)?\(\[/.exec(between);
  if (!all) return null;
  const names = decl[1].slice(1, -1).split(",").map((n) => n.trim());
  return names[elementIndex(between.slice(all.index + all[0].length))] || null;
}

/** Where the block enclosing `at` closes: the rest of the function. */
function blockEnd(src: string, at: number): number {
  let depth = 0;
  for (let i = at; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}" && --depth < 0) return i;
  }
  return src.length;
}

function callFiltered(src: string, at: number, name: string): boolean {
  // Wrapped: visibleNow(listChallenges()), visibleNow(await listChallenges()).
  if (/\b(visibleNow|visibleChallenges)\(\s*(await\s+)?$/.test(src.slice(Math.max(0, at - 40), at))) return true;
  // Chained: listChallenges().then(visibleNow), .then((c) => visibleNow(c)...).
  const after = src.slice(at + name.length + 2);
  if (/^\.then\(\s*(visibleNow\b|\(?\w+\)?\s*=>\s*visibleNow\()/.test(after)) return true;
  // Bound, then filtered later in the same block.
  const bound = boundName(src, at);
  if (!bound) return false;
  const rest = src.slice(at, blockEnd(src, at));
  return new RegExp(`\\b(${FILTER})\\(\\s*${bound}\\b|\\b${bound}\\.(filter|find|some)\\([^;]*\\b(${FILTER})\\(`).test(rest);
}

/** Every call in `src` that reaches no filter, by its offset. */
export function unfilteredCalls(source: string): number[] {
  const src = code(source);
  return [...src.matchAll(CALL)]
    .filter((m) => !/function\s+$/.test(src.slice(Math.max(0, (m.index ?? 0) - 20), m.index)))
    .filter((m) => !callFiltered(src, m.index ?? 0, m[1]))
    .map((m) => m.index ?? 0);
}

describe("the scan itself", () => {
  it("fails a file with two calls when only one is filtered", () => {
    const fixture = `
export async function page() {
  const [shown, other] = await Promise.all([listChallenges(), listCategories()]);
  const list = visibleNow(shown);
  const all = await listChallenges();
  return [list, all, other];
}
`;
    expect(unfilteredCalls(fixture)).toHaveLength(1);
    expect(unfilteredCalls(fixture.replace("return [list, all, other];", "return [list, visibleNow(all), other];"))).toEqual([]);
  });

  it("follows each data flow it accepts", () => {
    const ok = [
      "const a = visibleNow(await listChallenges());",
      "x(listChallenges().then(visibleNow));",
      "x(listChallenges().then((c) => visibleNow(c).length));",
      "function f() { const all = await listChallenges(); const k = cond ? all : visibleChallenges(all, now); }",
      "function f() { const records = await readChallengeRecords(); const v = records.filter((c) => isChallengeVisible(c, now)); }",
      "function f() { const record = (await listChallenges()).find((c) => c.id === id); return !isChallengeVisible(record, now); }",
    ];
    for (const src of ok) expect(unfilteredCalls(src), src).toEqual([]);
    // A filter on a DIFFERENT variable, or in another function, does not count.
    expect(unfilteredCalls("function f() { const a = await listChallenges(); visibleNow(b); }")).toHaveLength(1);
    expect(unfilteredCalls("function f() { const a = await listChallenges(); } function g() { visibleNow(a); }")).toHaveLength(1);
  });
});

describe("every call to the Jeopardy challenge list reaches a visibility filter", () => {
  const files = walk(SRC).map((p) => ({ path: relative(SRC, p), src: readFileSync(p, "utf8") }));
  const unfiltered = files
    .map(({ path, src }) => ({ path, calls: unfilteredCalls(src).length }))
    .filter((f) => f.calls > 0);

  it("finds the readers it is meant to check", () => {
    const readers = files.filter(({ src }) => /\b(listChallenges|readChallengeRecords)\(/.test(code(src))).map((f) => f.path);
    // Non-vacuous: the board, the graders and the leaderboard are readers.
    expect(readers).toEqual(
      expect.arrayContaining(["app/(site)/flags/page.tsx", "lib/classic-store.ts", "lib/hint-store.ts", "lib/leaderboard/module-contributions.ts"]),
    );
  });

  it("leaves no call unfiltered beyond the exemptions, each of which gives its reason", () => {
    const exempted = Object.fromEntries(Object.entries(EXEMPT).map(([path, e]) => [path, e.calls]));
    expect(Object.fromEntries(unfiltered.map((f) => [f.path, f.calls]))).toEqual(exempted);
    for (const e of Object.values(EXEMPT)) expect(e.reason.length).toBeGreaterThan(20);
  });
});
