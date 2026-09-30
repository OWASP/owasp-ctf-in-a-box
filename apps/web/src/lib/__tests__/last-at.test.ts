// The `ctf:<module>:lastAt` reader (#522): login -> ISO time of that login's
// latest award, the leaderboard's "whoever got there first" tiebreak.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readLastAt } from "../last-at";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readLastAt", () => {
  it("maps each login to its ISO time", () => {
    const out = readLastAt({ result: ["ada", "2026-10-01T12:00:00.000Z", "bob", "2026-10-01T13:00:00.000Z"] }, "quiz");
    expect(out).toEqual(
      new Map([
        ["ada", "2026-10-01T12:00:00.000Z"],
        ["bob", "2026-10-01T13:00:00.000Z"],
      ]),
    );
  });

  it("drops a value that is not a parseable time", () => {
    const out = readLastAt({ result: ["ada", "not-a-date", "bob", "2026-10-01T13:00:00.000Z"] }, "quiz");
    expect(out).toEqual(new Map([["bob", "2026-10-01T13:00:00.000Z"]]));
  });

  it("reads an empty or missing hash as no times", () => {
    expect(readLastAt({ result: [] }, "quiz")).toEqual(new Map());
    expect(readLastAt({ result: null }, "quiz")).toEqual(new Map());
  });

  // Fail OPEN, and say so: the time only breaks a points tie, so a failed
  // read must not take the module's points down with it. It is logged by
  // label, never by value.
  it("logs a failed read and returns no times rather than throwing", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readLastAt({ error: "WRONGTYPE Operation against a key holding the wrong kind of value" }, "classic")).toEqual(new Map());
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain("classic");
  });
});
