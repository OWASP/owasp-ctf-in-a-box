// The one string a store may hand `console.error` for a caught value. Three
// stores share it so they cannot drift: the invariant is "never the object",
// and an object's own fields (`command`, `cause`, `body`) are where a client
// puts the request it failed on — which, on a grading path, is the flag.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { errorLabel } from "@/lib/error-label";

describe("errorLabel", () => {
  it("keeps only the error's name and message", () => {
    expect(errorLabel(new TypeError("fetch failed"))).toBe("TypeError: fetch failed");
  });

  it("drops own properties, the cause and the stack — where a driver attaches the request", () => {
    const FLAG = "CTF{do-not-log-me}";
    const decorated = Object.assign(new Error("Upstash EVAL failed: ERR timeout"), {
      command: ["EVAL", "...", FLAG],
      cause: new Error(`while sending ${FLAG}`),
    });
    const label = errorLabel(decorated);
    expect(label).toContain("ERR timeout");
    expect(label).not.toContain(FLAG);
    expect(label).not.toContain("\n"); // no stack frames
  });

  it("caps the message so an interpolated payload cannot ride in on it", () => {
    expect(errorLabel(new Error("x".repeat(1000)))).toHaveLength(200);
  });

  it("never stringifies a non-Error throw — a thrown string could BE the flag", () => {
    expect(errorLabel("CTF{thrown-as-string}")).toBe("non-Error throw");
    expect(errorLabel({ flag: "CTF{obj}" })).toBe("non-Error throw");
    expect(errorLabel(undefined)).toBe("non-Error throw");
  });
});

// #500 (M12): "cannot drift" only holds if there is ONE implementation. Two
// byte-identical copies (`ai-http.ts`'s local `errorLabel`, `admin-store.ts`'s
// `adminErrorLabel`) had grown back next to this one; a fix to the shared
// label — a tighter cap, a new redaction — would silently skip them. Walk the
// app's source and refuse any other body that builds the label by hand.
describe("errorLabel has exactly one implementation", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const BODY = /`\$\{err\.name\}: \$\{err\.message\}`/;

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return e.name === "__tests__" || e.name === "node_modules" ? [] : sources(p);
      return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });
  }

  it("builds the name-and-message label only in lib/error-label.ts", () => {
    const files = sources(SRC);
    // Non-vacuous: the walk must actually reach the one legitimate copy.
    const holders = files.filter((f) => BODY.test(readFileSync(f, "utf8"))).map((f) => relative(SRC, f));
    expect(files.length).toBeGreaterThan(50);
    expect(holders).toEqual([join("lib", "error-label.ts")]);
  });

  it("admin-store's adminErrorLabel IS the shared errorLabel", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    // Both from the same (fresh) module registry, so identity is meaningful.
    const { adminErrorLabel } = await import("@/lib/admin-store");
    const shared = await import("@/lib/error-label");
    expect(adminErrorLabel).toBe(shared.errorLabel);
  });
});
