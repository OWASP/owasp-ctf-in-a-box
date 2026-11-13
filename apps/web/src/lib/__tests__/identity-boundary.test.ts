// Stores are keyed by the kit user id. The GitHub login is an attribute, read
// only where it is the subject: the identity helper, auth wiring, the admin
// check (ADMIN_LOGINS) and the GitHub link. Anywhere else, a read of
// `session.user.login` is a store key built from the wrong identity.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ALLOWED = new Set(["lib/player.ts", "lib/auth.ts", "lib/admin-auth.ts", "lib/github-link.ts"]);

const PATTERNS = [/user as \{[^}]*login/, /\.user\.login/, /user\?\.login/];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...sources(path));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

describe("identity boundary", () => {
  it("scans a real tree", () => {
    expect(sources(SRC).length).toBeGreaterThan(100);
  });

  it("no file outside the identity modules reads the session's GitHub login", () => {
    const offenders = sources(SRC)
      .map((path) => relative(SRC, path))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => {
        const text = readFileSync(join(SRC, rel), "utf8");
        return PATTERNS.some((re) => re.test(text));
      })
      .sort();
    expect(offenders).toEqual([]);
  });
});
