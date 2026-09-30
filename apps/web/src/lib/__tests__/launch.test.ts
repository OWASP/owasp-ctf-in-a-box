// The pre-launch lock (#464): pages and module APIs are closed to everyone
// but admins until the event is launched (a scoring start that has passed).
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getAdminSettings: vi.fn(),
  isAdminLogin: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-store", () => ({ getAdminSettings: m.getAdminSettings }));
vi.mock("@/lib/admin-auth", () => ({ isAdminLogin: m.isAdminLogin }));
vi.mock("next/navigation", () => ({ redirect: m.redirect }));

import { getLaunchAccess, launchApiAccess, redirectIfNotLaunched, requireLaunchedApi } from "@/lib/launch";
import { isLaunched } from "@/lib/schedule-window";
import { PLANTED_LOG_SECRET, expectLabelOnly } from "./log-redaction";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const PAST = "2026-10-01T00:00:00Z";
const FUTURE = "2026-10-02T00:00:00Z";

beforeEach(() => {
  vi.clearAllMocks();
  m.isAdminLogin.mockResolvedValue(false);
});

describe("isLaunched", () => {
  it("is false with no, an empty, or an unparseable start", () => {
    expect(isLaunched(NOW, null)).toBe(false);
    expect(isLaunched(NOW, "")).toBe(false);
    expect(isLaunched(NOW, "nope")).toBe(false);
  });
  it("is false before the start and true from the start instant on", () => {
    expect(isLaunched(NOW, FUTURE)).toBe(false);
    expect(isLaunched(Date.parse(PAST), PAST)).toBe(true);
    expect(isLaunched(NOW, PAST)).toBe(true);
  });
});

describe("getLaunchAccess", () => {
  it("refuses a non-admin before launch", async () => {
    m.getAdminSettings.mockResolvedValue({ scoringStartsAt: null, scoringEndsAt: null });
    expect(await getLaunchAccess("bob", NOW)).toEqual({ allowed: false, preview: false });
  });
  it("allows everyone once launched — and still after the end (results stay browsable)", async () => {
    m.getAdminSettings.mockResolvedValue({ scoringStartsAt: PAST, scoringEndsAt: PAST });
    expect(await getLaunchAccess("bob", NOW)).toEqual({ allowed: true, preview: false });
    expect(await getLaunchAccess(undefined, NOW)).toEqual({ allowed: true, preview: false });
  });
  it("lets an admin in before launch, as a preview", async () => {
    m.getAdminSettings.mockResolvedValue({ scoringStartsAt: FUTURE, scoringEndsAt: null });
    m.isAdminLogin.mockResolvedValue(true);
    expect(await getLaunchAccess("alice", NOW)).toEqual({ allowed: true, preview: true });
  });
  it("fails CLOSED for a non-admin when the settings read throws, and logs only the message", async () => {
    const err = Object.assign(new Error("redis down"), { request: { flag: "secret" } });
    m.getAdminSettings.mockRejectedValue(err);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getLaunchAccess("bob", NOW)).toEqual({ allowed: false, preview: false });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0].join(" "))).toContain("redis down");
    expect(String(log.mock.calls[0].join(" "))).not.toContain("secret");
    log.mockRestore();
  });
  // A rejection need not be an Error, and a thrown string could BE a secret:
  // `new Error(String(err))` printed it verbatim. The shared label never
  // stringifies a non-Error (#500 follow-up).
  it("never logs a thrown non-Error value", async () => {
    m.getAdminSettings.mockRejectedValue(PLANTED_LOG_SECRET);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await getLaunchAccess("bob", NOW)).toEqual({ allowed: false, preview: false });
      expectLabelOnly(log, { label: "non-Error throw" });
    } finally {
      log.mockRestore();
    }
  });
  it("still lets an admin in when the settings read throws", async () => {
    m.getAdminSettings.mockRejectedValue(new Error("redis down"));
    m.isAdminLogin.mockResolvedValue(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getLaunchAccess("alice", NOW)).toEqual({ allowed: true, preview: true });
  });
  it("treats an admin check that throws as not-admin (fail closed)", async () => {
    m.getAdminSettings.mockResolvedValue({ scoringStartsAt: null, scoringEndsAt: null });
    m.isAdminLogin.mockRejectedValue(new Error("redis down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getLaunchAccess("alice", NOW)).toEqual({ allowed: false, preview: false });
  });
});

describe("requireLaunchedApi", () => {
  it("returns null when allowed", async () => {
    // Real clock here (no `now` parameter), so a start that is past for sure.
    m.getAdminSettings.mockResolvedValue({ scoringStartsAt: "2000-01-01T00:00:00Z", scoringEndsAt: null });
    expect(await requireLaunchedApi("bob")).toBeNull();
  });
  it("returns 403 not-launched when refused", async () => {
    m.getAdminSettings.mockResolvedValue({ scoringStartsAt: null, scoringEndsAt: null });
    const res = await requireLaunchedApi("bob");
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "not-launched" });
  });
});

describe("redirectIfNotLaunched", () => {
  it("redirects a refused viewer to the landing page", async () => {
    m.getAdminSettings.mockResolvedValue({ scoringStartsAt: null, scoringEndsAt: null });
    await expect(redirectIfNotLaunched("bob")).rejects.toThrow("NEXT_REDIRECT:/");
  });
  it("returns the access when allowed (so a page can show the preview banner)", async () => {
    m.getAdminSettings.mockResolvedValue({ scoringStartsAt: null, scoringEndsAt: null });
    m.isAdminLogin.mockResolvedValue(true);
    expect(await redirectIfNotLaunched("alice")).toEqual({ allowed: true, preview: true });
    expect(m.redirect).not.toHaveBeenCalled();
  });
});

describe("launchApiAccess", () => {
  it("refuses a non-admin before launch with 403 not-launched", async () => {
    m.getAdminSettings.mockResolvedValue({ scoringStartsAt: null, scoringEndsAt: null });
    const { refused, preview } = await launchApiAccess("bob");
    expect(preview).toBe(false);
    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toEqual({ error: "not-launched" });
  });
  it("lets everyone through once launched, not as a preview", async () => {
    m.getAdminSettings.mockResolvedValue({ scoringStartsAt: "2000-01-01T00:00:00Z", scoringEndsAt: null });
    expect(await launchApiAccess("bob")).toEqual({ refused: null, preview: false });
  });
  it("lets an admin through before launch AS a preview (the route grades dry)", async () => {
    m.getAdminSettings.mockResolvedValue({ scoringStartsAt: null, scoringEndsAt: null });
    m.isAdminLogin.mockResolvedValue(true);
    expect(await launchApiAccess("alice")).toEqual({ refused: null, preview: true });
  });
});
