// `listChallenges` and `readChallengeRecords` return HIDDEN Jeopardy
// challenges too (disabled, or not yet released): the store cannot know
// whether its caller is a contestant surface. So every caller has to filter
// through classic-release.ts — or ask `classicVisibility`, which does — and a
// new reader that forgets would put a hidden challenge on some page. This
// test finds every caller in the source tree, not a hand-kept list, and fails
// on one that does not filter.
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

/** Where the readers are defined; their own bodies are the store, not a
 *  contestant surface. */
const DEFINITIONS = new Set(["lib/classic-store.ts"]);

const READ = /\b(listChallenges|readChallengeRecords)\(/;
// By name, not call: `listChallenges().then(visibleNow)` passes the filter
// rather than calling it, and an import left unused fails lint on its own.
const FILTER = /\b(visibleNow|visibleChallenges|isChallengeVisible|classicVisibility)\b/;

/** Code only: a comment line that names a reader is not a read. */
const code = (src: string) =>
  src
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(line))
    .join("\n");

describe("every reader of the Jeopardy challenge list filters hidden challenges", () => {
  const callers = walk(SRC)
    .map((p) => ({ path: relative(SRC, p), src: code(readFileSync(p, "utf8")) }))
    .filter(({ path, src }) => !DEFINITIONS.has(path) && READ.test(src));

  it("finds the readers it is meant to check", () => {
    // Non-vacuous: the board, its page and the leaderboard are all readers.
    expect(callers.map((c) => c.path)).toEqual(
      expect.arrayContaining(["app/(site)/flags/page.tsx", "app/(site)/flags/[id]/page.tsx", "lib/leaderboard/module-contributions.ts"]),
    );
  });

  it("each one filters through classic-release.ts or classicVisibility", () => {
    const unfiltered = callers.filter(({ src }) => !FILTER.test(src)).map((c) => c.path);
    expect(unfiltered).toEqual([]);
  });
});
