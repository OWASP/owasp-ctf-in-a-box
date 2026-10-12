// The quiz/classic counterpart of AppChallengeList — same static-render
// pattern. Collapsed is the resting state, so these pins cover the toggle's
// contract; the expanded rows are client state a static render can't reach
// (the same limit AppChallengeList's coverage lives with).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import ModuleItemList, { itemPointsLabel, itemStatusLabel, type ModuleItem } from "@/components/module-item-list";

const items: ModuleItem[] = [
  { id: "q1", label: "What does XSS stand for?", points: 50, done: true, earnedPoints: 50 },
  { id: "q2", label: "Which header stops clickjacking?", points: 25, done: false },
];

describe("ModuleItemList", () => {
  it("offers a Show-N toggle and keeps the rows behind it at rest", () => {
    const html = renderToStaticMarkup(
      <ModuleItemList items={items} noun="questions" doneLabel="Answered" />,
    );
    expect(html).toContain("Show 2 questions");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("What does XSS stand for?");
  });

  it("renders nothing at all for an empty item list", () => {
    expect(renderToStaticMarkup(<ModuleItemList items={[]} noun="flags" doneLabel="Solved" />)).toBe("");
  });
});

// A hidden story step carries no price (ADR 60); its row says so instead of
// claiming it is worth 0.
describe("itemPointsLabel", () => {
  it("shows a dash, never 0pt, for a hidden step", () => {
    expect(itemPointsLabel({ id: "locked:op:2", label: "??? — step 2 of 8", points: 0, done: false, hidden: true })).toBe("—");
  });

  it("shows the banked points for a done item and the price otherwise", () => {
    expect(itemPointsLabel({ id: "c1", label: "Recon", points: 50, done: true, earnedPoints: 40 })).toBe("40pt");
    expect(itemPointsLabel({ id: "c2", label: "Crypto", points: 100, done: false })).toBe("100pt");
  });
});

// A hidden step is locked for the VIEWER, so "Open" would be false; the
// route says nothing per position, so it is never "Solved" either.
describe("itemStatusLabel", () => {
  it("says Locked for a hidden step", () => {
    expect(itemStatusLabel({ id: "locked:op:2", label: "??? — step 2 of 8", points: 0, done: false, hidden: true }, "Solved")).toBe("Locked");
  });

  it("says the done word or Open otherwise", () => {
    expect(itemStatusLabel({ id: "c1", label: "Recon", points: 50, done: true }, "Solved")).toBe("Solved");
    expect(itemStatusLabel({ id: "c2", label: "Crypto", points: 100, done: false }, "Solved")).toBe("Open");
  });
});
