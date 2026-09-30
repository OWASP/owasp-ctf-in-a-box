// /faq on a quiz-only event.
//
// This page was 100% secure-development — "fork the target's repo", "open a
// pull request", "the scorer watches main", hints, PR authorship — and it is
// in the HEADER NAV, so a quiz-only event linked contestants to it from every
// page of the site.
//
// Same negative-assertion discipline as the /rules and /how-to-play suites,
// and the same shared term list. Own file for the usual `vi.mock` hoisting
// reason.
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
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["quiz"]),
);
vi.mock("@/lib/admin-store", () => ({
  // `getResolvedModules` reads `moduleOverrides` from this; `enabledModuleIds`
  // mirrors the set the enabled-modules mock above serves.
  getAdminSettings: async () => ({ moduleOverrides: {}, enabledModuleIds: ["quiz"] }),
}));

import Faq from "@/app/(site)/faq/page";

const html = await Faq().then(renderToStaticMarkup);

describe("/faq in a quiz-only event", () => {
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

  it("answers the same questions in the quiz's own terms", () => {
    expect(html).toContain("How do I submit an answer?");
    expect(html).toContain("Can I retry a question I got wrong?");
    expect(html).toContain("I answered correctly but didn&#x27;t get points. What happened?");
  });

  it("keeps the module's questions interleaved with the platform's, not bolted on the end", () => {
    // "Do I need experience to compete?" is the module's opener and must come
    // BEFORE the platform's "Can I compete solo?", which in turn comes before
    // the module's "What do I need to bring?" — the running order the page
    // shipped with, and the reason the contributions are bucketed at all.
    const order = ["Do I need experience to compete?", "Can I compete solo?", "What do I need to bring?"].map(
      (q) => html.indexOf(q),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
