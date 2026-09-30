// /faq on a classic-only event. This page is in the header nav, so a
// classic-only event must not link contestants to a page that still tells
// them to fork a target and open a pull request.
//
// Own file for the usual `vi.mock` hoisting reason.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  findSecureDevLeaks,
  normalizeHtml,
  SECURE_DEV_PATTERNS,
  SECURE_DEV_TERMS,
} from "../../__tests__/secure-dev-terms";

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["classic"]),
);
vi.mock("@/lib/admin-store", () => ({
  // `getResolvedModules` reads `moduleOverrides` from this; `enabledModuleIds`
  // mirrors the set the enabled-modules mock above serves.
  getAdminSettings: async () => ({ moduleOverrides: {}, enabledModuleIds: ["classic"] }),
}));

import Faq from "@/app/(site)/faq/page";

const html = await Faq().then(renderToStaticMarkup);

describe("/faq in a classic-only event", () => {
  it("keeps the platform-wide questions", () => {
    expect(html).toContain("Can I compete solo?");
    expect(html).toContain("Is there a prize?");
    expect(html).toContain("Where do I ask for help during the event?");
  });

  it("renders no secure-development copy", () => {
    expect(findSecureDevLeaks(html)).toEqual([]);
  });

  it.each(SECURE_DEV_TERMS)("does not leak %j", (term) => {
    expect(normalizeHtml(html)).not.toContain(term);
  });

  it.each(SECURE_DEV_PATTERNS)("does not leak %s", (pattern) => {
    expect(html).not.toMatch(pattern);
  });

  it("answers the same questions in classic's own terms", () => {
    expect(html).toContain("How do I submit a flag?");
    expect(html).toContain("Can I retry a flag I got wrong?");
    expect(html).toContain(
      "I submitted the right flag but didn&#x27;t get points. What happened?",
    );
  });

  it("states case/whitespace insensitivity and never claims an attempt cap", () => {
    expect(html).toContain("Does case or extra spacing matter?");
    expect(html).not.toMatch(/\battempts? (remaining|left)\b/i);
  });

  /** A statement about case that carries its exception in the same sentence.
   *  `[^.]*` is the load-bearing part — it cannot span a full stop, so the
   *  qualifier has to be attached to the claim rather than merely present on
   *  the page. */
  const QUALIFIED_CASE_CLAIM = /\bcase\b[^.]*\bcase-sensitive\b/i;

  // Asserting the ANSWER, not just that the question rendered. The question
  // alone was all this file checked, and under it sat "No. Matching trims
  // leading and trailing whitespace and ignores case" — flatly wrong for a
  // challenge marked case-sensitive, which `flagComparisonForm`
  // (classic-keys.ts) compares verbatim and the board badges. Same regression
  // as #193, in the one place a stuck contestant looks first.
  it("does not promise case-insensitive matching without the case-sensitive exception", () => {
    const answer = "Leading and trailing whitespace never matters";
    expect(html).toContain(answer);
    const body = html.slice(html.indexOf(answer), html.indexOf(answer) + 400);

    // The claim about case and its exception must sit in the SAME sentence
    // (`[^.]*` cannot cross a full stop). Merely mentioning "case-sensitive"
    // somewhere nearby is not enough: a rewrite to "Case is ignored for all
    // flags." followed by an unrelated sentence about case-sensitive flags
    // would satisfy that, and would be exactly as wrong as the copy this
    // test exists to keep out.
    expect(body).toMatch(QUALIFIED_CASE_CLAIM);
  });

  // The guard above is only as good as this regex, so prove it discriminates
  // rather than assuming it: an unqualified claim with the exception stranded
  // in a neighbouring sentence must fail it.
  it("the case-qualification pattern rejects an unqualified claim", () => {
    expect(QUALIFIED_CASE_CLAIM.test("Case is ignored for all flags. Some are case-sensitive.")).toBe(false);
    expect(QUALIFIED_CASE_CLAIM.test("No. Matching trims whitespace and ignores case.")).toBe(false);
    expect(
      QUALIFIED_CASE_CLAIM.test("Case usually doesn't either, but a flag can be marked case-sensitive."),
    ).toBe(true);
    expect(QUALIFIED_CASE_CLAIM.test("Case is ignored unless the flag is case-sensitive.")).toBe(true);
  });

  it("keeps the module's questions interleaved with the platform's, not bolted on the end", () => {
    const order = ["Do I need experience to compete?", "Can I compete solo?", "What do I need to bring?"].map(
      (q) => html.indexOf(q),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
