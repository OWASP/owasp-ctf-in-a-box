// A preview launch token (#464) is honoured only while the event is not
// launched, and refused when that cannot be established.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ getAdminSettings: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-store", () => ({ getAdminSettings: m.getAdminSettings }));

import { previewClaimStillValid } from "@/lib/ai-preview";
import { PLANTED_LOG_SECRET, decoratedError, expectLabelOnly } from "./log-redaction";

const NOW = Date.parse("2026-10-01T12:00:00Z");

beforeEach(() => vi.clearAllMocks());

describe("previewClaimStillValid", () => {
  it("is valid before launch (no start, or a start still ahead)", async () => {
    m.getAdminSettings.mockResolvedValue({ scoringStartsAt: null });
    expect(await previewClaimStillValid(NOW)).toBe(true);
    m.getAdminSettings.mockResolvedValue({ scoringStartsAt: "2026-10-02T00:00:00Z" });
    expect(await previewClaimStillValid(NOW)).toBe(true);
  });

  it("is no longer valid once the event has launched", async () => {
    m.getAdminSettings.mockResolvedValue({ scoringStartsAt: "2026-10-01T00:00:00Z" });
    expect(await previewClaimStillValid(NOW)).toBe(false);
  });

  it("fails CLOSED when the settings cannot be read", async () => {
    m.getAdminSettings.mockRejectedValue(new Error("redis down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await previewClaimStillValid(NOW)).toBe(false);
  });

  // A thrown string could BE a secret; the shared label never stringifies a
  // non-Error, and a decorated Error reaches the log as its label (#500).
  it("logs the label only: never a thrown non-Error, never the error's decoration", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      m.getAdminSettings.mockRejectedValueOnce(PLANTED_LOG_SECRET);
      expect(await previewClaimStillValid(NOW)).toBe(false);
      expectLabelOnly(log, { label: "non-Error throw" });
      m.getAdminSettings.mockRejectedValueOnce(decoratedError("redis down"));
      expect(await previewClaimStillValid(NOW)).toBe(false);
      expectLabelOnly(log, { label: "redis down" });
    } finally {
      log.mockRestore();
    }
  });
});
