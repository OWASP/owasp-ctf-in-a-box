// The quiz/classic counterpart of AppBreakdown — same static-render
// pattern. Collapsed is the resting state, so these pins cover the toggle's
// contract; the expanded rows are client state a static render can't reach
// (the same limit AppBreakdown's coverage lives with).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import ModuleItemList, { type ModuleItem } from "@/components/module-item-list";

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
