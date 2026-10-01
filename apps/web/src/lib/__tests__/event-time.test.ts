import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVENT_TIME_ZONE, canonicalTimeZone, formatInZone, instantToWall, wallToInstant, zoneLabel,
} from "@/lib/event-time";

// #547: one configured zone for every date the event shows. These run in
// whatever TZ the test process has — every assertion names its zone, so a
// pass here never depends on the host clock's zone.

describe("canonicalTimeZone", () => {
  it("accepts an IANA zone and returns Intl's canonical spelling", () => {
    expect(canonicalTimeZone("America/Argentina/Buenos_Aires")).toBe("America/Argentina/Buenos_Aires");
    expect(canonicalTimeZone("utc")).toBe("UTC");
  });
  it("rejects junk", () => {
    expect(canonicalTimeZone("Mars/Olympus")).toBeNull();
    expect(canonicalTimeZone("")).toBeNull();
    expect(canonicalTimeZone("not a zone")).toBeNull();
    // Intl takes an offset ID ("+05:30") as a zone, but it is not IANA and
    // has no daylight-saving rules: refused, never stored (PR #548 review).
    expect(canonicalTimeZone("+05:30")).toBeNull();
    expect(canonicalTimeZone("-03:00")).toBeNull();
    // An IANA link name stays accepted.
    expect(canonicalTimeZone("US/Eastern")).toBe("US/Eastern");
  });
  it("defaults to UTC", () => {
    expect(DEFAULT_EVENT_TIME_ZONE).toBe("UTC");
  });
});

describe("zoneLabel", () => {
  it("is UTC for the default zone", () => {
    expect(zoneLabel("UTC", Date.parse("2026-10-03T12:00:00Z"))).toBe("UTC");
  });
  it("is the offset for a fixed-offset zone", () => {
    expect(zoneLabel("America/Argentina/Buenos_Aires", Date.parse("2026-10-03T12:00:00Z"))).toBe("GMT-3");
  });
  it("follows daylight saving at the instant shown", () => {
    expect(zoneLabel("America/New_York", Date.parse("2026-07-01T12:00:00Z"))).toBe("GMT-4");
    expect(zoneLabel("America/New_York", Date.parse("2026-12-01T12:00:00Z"))).toBe("GMT-5");
  });
});

describe("formatInZone", () => {
  it("formats the instant on the event's wall clock", () => {
    const opts = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } as const;
    expect(formatInZone("2026-10-03T12:00:00Z", "UTC", opts)).toBe("Oct 3, 12:00 PM");
    expect(formatInZone("2026-10-03T12:00:00Z", "America/Argentina/Buenos_Aires", opts)).toBe("Oct 3, 9:00 AM");
  });
});

describe("wall clock <-> instant", () => {
  it("reads a datetime-local value in the event zone, not the host's", () => {
    expect(wallToInstant("2026-10-03T09:00", "America/Argentina/Buenos_Aires")).toBe("2026-10-03T12:00:00.000Z");
    expect(wallToInstant("2026-10-03T09:00", "UTC")).toBe("2026-10-03T09:00:00.000Z");
  });
  it("writes an instant back as the event's wall clock", () => {
    expect(instantToWall("2026-10-03T12:00:00.000Z", "America/Argentina/Buenos_Aires")).toBe("2026-10-03T09:00");
    expect(instantToWall("2026-10-03T12:00:00.000Z", "UTC")).toBe("2026-10-03T12:00");
  });
  it("round-trips on both sides of a DST change", () => {
    for (const wall of ["2026-03-07T10:00", "2026-03-09T10:00", "2026-11-01T00:30", "2026-11-02T10:00"]) {
      expect(instantToWall(wallToInstant(wall, "America/New_York")!, "America/New_York")).toBe(wall);
    }
  });
  // CodeRabbit CLI: just after spring-forward the first estimate uses the
  // pre-change offset and lands an hour late; the one that round-trips wins.
  it("reads a time just after a spring-forward change at its real offset", () => {
    expect(wallToInstant("2026-03-08T03:30", "America/New_York")).toBe("2026-03-08T07:30:00.000Z");
    expect(wallToInstant("2026-03-08T01:30", "America/New_York")).toBe("2026-03-08T06:30:00.000Z");
    expect(wallToInstant("2026-11-01T03:30", "America/New_York")).toBe("2026-11-01T08:30:00.000Z");
  });

  it("lands a time inside a spring-forward gap on a real instant, an hour on", () => {
    // 02:30 does not exist in New York on 2026-03-08: the clock jumps 02:00 -> 03:00.
    const iso = wallToInstant("2026-03-08T02:30", "America/New_York")!;
    expect(instantToWall(iso, "America/New_York")).toBe("2026-03-08T03:30");
  });
  it("returns null / empty for empty or malformed input", () => {
    expect(wallToInstant("", "UTC")).toBeNull();
    expect(wallToInstant("tomorrow", "UTC")).toBeNull();
    expect(instantToWall(null, "UTC")).toBe("");
    expect(instantToWall("garbage", "UTC")).toBe("");
  });
});
