import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAdminSettingsSnapshot: vi.fn() }));
vi.mock("@/lib/enabled-modules", () => ({ getAdminSettingsSnapshot: mocks.getAdminSettingsSnapshot }));

import { getSite, resolveSite } from "@/lib/site";

beforeEach(() => mocks.getAdminSettingsSnapshot.mockReset());

describe("resolveSite", () => {
  it("serves the spec defaults when nothing is stored", () => {
    const s = resolveSite(null, null);
    expect(s.name).toBe("OWASP CTF in a Box");
    expect(s.theme).toBe("");
    expect(s.location).toBe("");
    expect(s.contactEmail).toBe("");
    expect(s.discordUrl).toBe("");
  });
  it("lays stored fields over the defaults, field by field", () => {
    const s = resolveSite({ eventName: "Demo CTF", eventDiscord: "https://discord.gg/x" }, null);
    expect(s.name).toBe("Demo CTF");
    expect(s.discordUrl).toBe("https://discord.gg/x");
    expect(s.theme).toBe("");
  });
  // Config v2, PR 3A (#386): dates/ctfStartsAt no longer come from event.yaml
  // — they're derived from the admin scoring schedule via formatDateRange.
  it("derives dates and ctfStartsAt from the scoring schedule", () => {
    const s = resolveSite({}, {
      scoringStartsAt: "2026-10-01T09:00:00Z",
      scoringEndsAt: "2026-10-03T18:00:00Z",
    });
    expect(s.dates).toBe("Oct 1 – Oct 3, 2026");
    expect(s.ctfStartsAt).toBe("2026-10-01T09:00:00Z");
  });
  it("renders no dates line and a null ctfStartsAt when there is no schedule", () => {
    const s = resolveSite({}, null);
    expect(s.dates).toBe("");
    expect(s.ctfStartsAt).toBeNull();
  });
  it("keeps the OWASP policy urls static", () => {
    expect(resolveSite(null, null).owaspPrivacyUrl).toMatch(/^https:\/\/policy\.owasp\.org\//);
    expect(resolveSite(null, null).privacyContactEmail).toBe("privacy@owasp.com");
  });
  // Finding M1: an empty stored eventName (only reachable by a hand-run HSET
  // — the app's own write path already rejects "") must still fall back to
  // the default rather than render a blank <title>/headline. The other four
  // identity fields keep their existing "'' is a legitimate no-override" `??`
  // semantics — pinned here with eventTheme so a future edit can't collapse
  // `||` onto every field by mistake.
  it("falls back to the default name on an empty stored eventName, but leaves the other fields' blank-is-valid semantics alone", () => {
    expect(resolveSite({ eventName: "" }, null).name).toBe("OWASP CTF in a Box");
    expect(resolveSite({ eventTheme: "" }, null).theme).toBe("");
  });
});

describe("getSite", () => {
  it("reads identity off the shared settings snapshot", async () => {
    mocks.getAdminSettingsSnapshot.mockResolvedValue({ eventIdentity: { eventName: "Snapshot CTF" } });
    expect((await getSite()).name).toBe("Snapshot CTF");
    expect(mocks.getAdminSettingsSnapshot).toHaveBeenCalledTimes(1);
  });
  it("fails open to the defaults when the snapshot is null", async () => {
    mocks.getAdminSettingsSnapshot.mockResolvedValue(null);
    expect((await getSite()).name).toBe("OWASP CTF in a Box");
  });
  // The schedule fields flow through the SAME snapshot read as the identity
  // fields — no second HGETALL — and getSite() passes both into resolveSite.
  it("derives dates/ctfStartsAt off the snapshot's schedule fields, with one snapshot read", async () => {
    mocks.getAdminSettingsSnapshot.mockResolvedValue({
      eventIdentity: { eventName: "Snapshot CTF" },
      scoringStartsAt: "2026-10-01T09:00:00Z",
      scoringEndsAt: "2026-10-03T18:00:00Z",
    });
    const site = await getSite();
    expect(site.dates).toBe("Oct 1 – Oct 3, 2026");
    expect(site.ctfStartsAt).toBe("2026-10-01T09:00:00Z");
    expect(mocks.getAdminSettingsSnapshot).toHaveBeenCalledTimes(1);
  });
});
