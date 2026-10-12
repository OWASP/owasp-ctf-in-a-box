// Bundle version 4 carries a challenge's visibility. A file stamped older that
// carries the field is refused: a box built before it would import the
// challenge live, publishing something its organizer meant to keep hidden.
import { describe, expect, it } from "vitest";
import { CLASSIC_BUNDLE_VERSION, bundleVersionFor, parseBundle } from "@/lib/classic-io";

const base = (version: number, extra: Record<string, unknown> = {}) => ({
  version,
  categories: ["Web"],
  challenges: [
    { id: "a-1", title: "One", category: "Web", description: "", points: 10, order: 0, flag: "CTF{secret-one}", ...extra },
  ],
});

describe("bundleVersionFor", () => {
  it("stamps 4 whenever a challenge carries visibility, 3 for files alone, 2 otherwise", () => {
    expect(CLASSIC_BUNDLE_VERSION).toBe(4);
    expect(bundleVersionFor(false)).toBe(2);
    expect(bundleVersionFor(true)).toBe(3);
    expect(bundleVersionFor(false, true)).toBe(4);
    expect(bundleVersionFor(true, true)).toBe(4);
  });
});

describe("parseBundle and enabled", () => {
  it("accepts enabled:false on a version 4 bundle and keeps it", () => {
    const res = parseBundle(JSON.stringify(base(4, { enabled: false })));
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.bundle.challenges[0].enabled).toBe(false);
  });

  it("imports versions 1 to 3 without the field exactly as before", () => {
    for (const v of [1, 2, 3]) {
      const res = parseBundle(JSON.stringify(base(v)));
      if (!res.ok) throw new Error(JSON.stringify(res.errors));
      expect("enabled" in res.bundle.challenges[0]).toBe(false);
    }
  });

  it("refuses the field on an older version, naming the position and the rule, never a value", () => {
    for (const v of [1, 2, 3]) {
      const res = parseBundle(JSON.stringify(base(v, { enabled: false })));
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.errors).toContainEqual({ where: "challenges[0].enabled", message: '"enabled" needs bundle version 4' });
      expect(JSON.stringify(res.errors)).not.toContain("secret-one");
    }
  });

  it("refuses a non-boolean enabled", () => {
    const res = parseBundle(JSON.stringify(base(4, { enabled: "false" })));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toContainEqual({ where: "challenges[0].enabled", message: "enabled must be true or false" });
  });

  it("still accepts attachment files on a version 3 bundle", () => {
    const res = parseBundle(JSON.stringify({ ...base(3), attachmentFiles: [] }));
    expect(res.ok).toBe(true);
  });
});
