// The row every level of the tree renders. The rules under test are the ones
// the live profile broke: a source with no point data must not print "8 / 0
// pts"; two fractions must never run together; a module's unit word must be
// its own; and a row with children must be a real, keyboard-operable
// disclosure rather than a click handler on a div.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ProgressRow, { MODULE_UNIT, MODULE_VERB, moduleUnit, moduleVerb } from "@/components/progress/progress-row";

const target = { label: "Juice Shop", done: 1, total: 38, unit: "patched", earned: 2, max: 141 };

describe("module vocabulary", () => {
  it("gives each module its own unit word", () => {
    expect(MODULE_UNIT["secure-development"]).toBe("patched");
    expect(MODULE_UNIT.quiz).toBe("answered");
    expect(MODULE_UNIT.classic).toBe("solved");
    // Classic's verb is "flags", so a member summary never reads
    // "3 solved · 3 solved".
    expect(MODULE_VERB.classic).toBe("flags");
  });

  it("falls back to 'solved' for a module neither map names, rather than throwing", () => {
    expect(moduleUnit("not-a-module")).toBe("solved");
    expect(moduleVerb("not-a-module")).toBe("solved");
  });
});

describe("ProgressRow", () => {
  it("shows the count in the module's unit and the points as earned / max", () => {
    const html = renderToStaticMarkup(<ProgressRow {...target} />);
    expect(html).toContain("38 patched");
    expect(html).toContain("141 pts");
  });

  it("shows a score with no ceiling as the earned figure alone — never '8 / 0 pts'", () => {
    // A team's quiz/classic block carries points but no maximum, and the
    // profile's secure-development header used to arrive this way too.
    const html = renderToStaticMarkup(
      <ProgressRow label="Secure Development" done={6} total={321} unit="patched" earned={8} max={0} />,
    );
    expect(html).toContain("321 patched");
    expect(html).toContain("8");
    expect(html).toContain("pts");
    expect(html).not.toContain("/ 0 pts");
    // The bar still renders, falling back to the count.
    expect(html).toContain('aria-valuemax="321"');
  });

  it("says nothing about points when there is neither a score nor a ceiling", () => {
    const html = renderToStaticMarkup(
      <ProgressRow label="Security Shepherd" done={0} total={40} unit="patched" earned={0} max={0} />,
    );
    expect(html).toContain("40 patched");
    expect(html).not.toContain("pts");
  });

  it("shows the completed count without a denominator when total is 0 — never '1 / 0 answered'", () => {
    const html = renderToStaticMarkup(
      <ProgressRow label="Quiz" done={1} total={0} unit="answered" earned={10} max={0} />,
    );
    expect(html).toContain("1");
    expect(html).toContain("answered");
    expect(html).not.toContain("/ 0 answered");
    // With no ceiling to measure progress against, the bar is omitted rather
    // than exposing a 0 denominator in its accessible label or a false fill.
    expect(html).not.toContain('role="progressbar"');
  });

  it("omits the progress bar when bar is false, keeping earned points and completed count visible", () => {
    const html = renderToStaticMarkup(
      <ProgressRow label="Quiz" done={1} total={10} unit="answered" earned={10} max={100} bar={false} />,
    );
    expect(html).toContain("1");
    expect(html).toContain("10 answered");
    expect(html).toContain("10");
    expect(html).toContain("100 pts");
    expect(html).not.toContain('role="progressbar"');
  });

  it("separates the two fractions on the narrow layout, where they share a line", () => {
    // "1 / 38 patched2 / 141 pts" on the deployed profile. From md the fixed
    // points column parts them, so the dot is md:hidden rather than always on.
    const html = renderToStaticMarkup(<ProgressRow {...target} />);
    expect(html).toMatch(/md:hidden[^>]*>·/);
    expect(html).toContain("md:w-40 md:text-right");
  });

  it("puts the bar on its own line below md and inline from md", () => {
    const html = renderToStaticMarkup(<ProgressRow {...target} />);
    expect(html).toContain("basis-full md:min-w-24 md:flex-1 md:basis-0");
  });

  it("shows hint spend only when there is some, in the hint colour", () => {
    expect(renderToStaticMarkup(<ProgressRow {...target} hints={10} />)).toContain("−10 hints");
    expect(renderToStaticMarkup(<ProgressRow {...target} hints={0} />)).not.toContain("hints");
    expect(renderToStaticMarkup(<ProgressRow {...target} />)).not.toContain("hints");
  });

  it("labels a post-hint total when the spend itself is not on screen", () => {
    const html = renderToStaticMarkup(<ProgressRow {...target} totalLabel="net" />);
    expect(html).toContain("net");
  });

  it("colours a target label with its accent and leaves a module label alone", () => {
    const asTarget = renderToStaticMarkup(<ProgressRow {...target} level="target" accent="#d4a017" />);
    expect(asTarget).toContain("color:#d4a017");
    const asModule = renderToStaticMarkup(<ProgressRow {...target} level="module" accent="#d4a017" />);
    expect(asModule).not.toContain("color:#d4a017");
  });

  it("is a plain row without children and a native disclosure with them", () => {
    const plain = renderToStaticMarkup(<ProgressRow {...target} />);
    expect(plain).not.toContain("<details");
    const open = renderToStaticMarkup(<ProgressRow {...target}>the list</ProgressRow>);
    // <details>/<summary> is keyboard-operable for free; a div with onClick
    // is not, and this tree is read as much by keyboard as by mouse.
    expect(open).toContain("<details");
    expect(open).toContain("<summary");
    expect(open).toContain("the list");
    expect(open).not.toMatch(/<details[^>]*open=/);
  });

  it("can start open when the caller has a reason to", () => {
    expect(renderToStaticMarkup(<ProgressRow {...target} defaultOpen>x</ProgressRow>)).toMatch(/<details[^>]*open=""/);
  });
});
