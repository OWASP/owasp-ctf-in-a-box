// #595: the admin Jeopardy list says how many teams and players solved each
// challenge, so an organizer spots a flag nobody can solve from the list.
import { describe, expect, it } from "vitest";

import { solvesLabel } from "@/components/admin-classic-model";

describe("solvesLabel", () => {
  it("names teams and players", () => {
    expect(solvesLabel({ teams: 3, players: 5 })).toBe("3 teams · 5 players");
    expect(solvesLabel({ teams: 1, players: 1 })).toBe("1 team · 1 player");
  });

  it("calls an unsolved challenge unsolved, so it stands out", () => {
    expect(solvesLabel({ teams: 0, players: 0 })).toBe("unsolved");
  });

  it("shows what it knows when one count could not be read, and nothing with neither", () => {
    expect(solvesLabel({ teams: null, players: 4 })).toBe("4 players");
    expect(solvesLabel({ teams: 2, players: null })).toBe("2 teams");
    expect(solvesLabel({ teams: null, players: null })).toBeNull();
    expect(solvesLabel(undefined)).toBeNull();
  });
});
