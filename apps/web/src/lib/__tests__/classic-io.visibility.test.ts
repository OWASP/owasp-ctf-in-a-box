// Bundle version 4 carries a challenge's visibility. A file stamped older that
// carries the field is refused: a box built before it would import the
// challenge live, publishing something its organizer meant to keep hidden.
import { describe, expect, it } from "vitest";
import { CLASSIC_BUNDLE_VERSION, bundleVersionFor, carriesVisibility, parseBundle } from "@/lib/classic-io";

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

describe("parseBundle and releaseAt", () => {
  const at = "2099-10-08T13:00:00.000Z";

  it("accepts a release instant on a version 4 bundle", () => {
    const res = parseBundle(JSON.stringify(base(4, { enabled: false, releaseAt: at })));
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.bundle.challenges[0].releaseAt).toBe(at);
    expect(bundleVersionFor(false, carriesVisibility({ releaseAt: at }))).toBe(4);
  });

  it("refuses it on an older version, by position", () => {
    const res = parseBundle(JSON.stringify(base(3, { releaseAt: at })));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toContainEqual({ where: "challenges[0].releaseAt", message: '"releaseAt" needs bundle version 4' });
  });

  it("refuses an unreadable instant without echoing it", () => {
    const res = parseBundle(JSON.stringify(base(4, { releaseAt: "next-tuesday-zz8" })));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toContainEqual({ where: "challenges[0].releaseAt", message: "releaseAt must be an ISO 8601 date and time ending in Z or an offset such as -03:00" });
    expect(JSON.stringify(res.errors)).not.toContain("next-tuesday-zz8");
  });
});

describe("parseBundle and a release time's zone", () => {
  const errorFor = (releaseAt: string) => {
    const res = parseBundle(JSON.stringify(base(4, { enabled: false, releaseAt })));
    return res.ok ? null : res.errors;
  };

  it("refuses an offset-less instant, by position and rule, never the value", () => {
    const errors = errorFor("2099-10-08T10:00:07");
    expect(errors).toContainEqual({ where: "challenges[0].releaseAt", message: "releaseAt must be an ISO 8601 date and time ending in Z or an offset such as -03:00" });
    expect(JSON.stringify(errors)).not.toContain("10:00:07");
  });

  it("refuses a date that does not exist", () => {
    expect(errorFor("2099-02-30T10:00:00Z")).toContainEqual({ where: "challenges[0].releaseAt", message: "releaseAt must be an ISO 8601 date and time ending in Z or an offset such as -03:00" });
  });

  it("accepts Z and an explicit offset", () => {
    expect(errorFor("2099-10-08T13:00:00Z")).toBeNull();
    expect(errorFor("2099-10-08T10:00:00-03:00")).toBeNull();
  });
});
