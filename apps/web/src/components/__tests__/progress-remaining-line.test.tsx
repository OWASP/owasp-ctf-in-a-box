// The profile's one piece of genuinely new information. It has to survive the
// two states the rest of the page already handles badly: a module whose source
// reports no ceiling at all, and a contestant who has banked more than a
// shrunken ceiling still admits to.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import RemainingLine, { remainingSummary } from "@/components/progress/remaining-line";

describe("remainingSummary", () => {
  it("adds up what is left and names where most of it is", () => {
    expect(
      remainingSummary([
        { title: "Secure Development", earned: 8, max: 668 },
        { title: "Jeopardy", earned: 70, max: 2270 },
        { title: "Quiz", earned: 200, max: 375 },
      ]),
    ).toEqual({ remaining: 660 + 2200 + 175, leader: "Jeopardy" });
  });

  it("names nobody when a single module holds everything left — the row above already says it", () => {
    expect(remainingSummary([{ title: "Quiz", earned: 200, max: 375 }])).toEqual({ remaining: 175, leader: null });
    expect(
      remainingSummary([
        { title: "Quiz", earned: 200, max: 375 },
        { title: "AI", earned: 850, max: 850 },
      ]),
    ).toEqual({ remaining: 175, leader: null });
  });

  it("contributes nothing for a module with no point data, rather than a negative", () => {
    expect(remainingSummary([{ title: "Secure Development", earned: 8, max: 0 }])).toEqual({
      remaining: 0,
      leader: null,
    });
  });

  it("clamps per module, so an overshoot cannot eat another module's remainder", () => {
    // A deleted question leaves banked points above the new ceiling.
    expect(
      remainingSummary([
        { title: "Quiz", earned: 400, max: 375 },
        { title: "Jeopardy", earned: 0, max: 100 },
      ]),
    ).toEqual({ remaining: 100, leader: null });
  });

  it("breaks a tie toward the first module, rather than reordering between renders", () => {
    expect(
      remainingSummary([
        { title: "Quiz", earned: 0, max: 100 },
        { title: "Jeopardy", earned: 0, max: 100 },
      ]).leader,
    ).toBe("Quiz");
  });
});

describe("RemainingLine", () => {
  it("reads as the doc's sentence, with thousands grouped", () => {
    const html = renderToStaticMarkup(
      <RemainingLine
        modules={[
          { title: "Jeopardy", earned: 70, max: 2070 },
          { title: "Quiz", earned: 0, max: 100 },
        ]}
      />,
    );
    expect(html).toContain("2,100 pts");
    expect(html).toContain("still on the board");
    expect(html).toContain("most in Jeopardy");
  });

  it("says nothing at all once there is nothing left to win", () => {
    expect(renderToStaticMarkup(<RemainingLine modules={[{ title: "Quiz", earned: 375, max: 375 }]} />)).toBe("");
  });
});
