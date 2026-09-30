// THE regression this task exists for: /how-to-play used to be
// secure-development's workflow guide with no module awareness at all — ~29
// references to patching, pull requests and forks — so a quiz-only event
// handed contestants a step-by-step guide to a game it was not running. The
// failure is silent: the page still renders, still has a title, and only a
// human reading it notices. So the assertions that matter are on ABSENCE, and
// the term list they use is enumerated deliberately in
// ../../__tests__/secure-dev-terms.ts.
//
// Own file because `vi.mock` hoists per file and this fixture needs its own
// module set. Only the live set is mocked —
// `@/lib/modules`, the real registry (the page's own content)
// stays under test — same split as lib/__tests__/modules-resolve.test.ts.
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

import HowToPlay, { generateMetadata } from "@/app/(site)/how-to-play/page";

const html = await HowToPlay().then(renderToStaticMarkup);
const metadata = await generateMetadata();

describe("/how-to-play in a quiz-only event", () => {
  it("still renders the platform frame", () => {
    expect(html).toContain("How to Play");
    expect(html).toContain("Getting Started");
    expect(html).toContain("Read the rules");
    expect(html).toContain("View the leaderboard");
    expect(html).toContain("Stuck, or need an organizer?");
  });

  // The list is enumerated, not sampled: "patched" is the string that leaked
  // last time precisely because the previous suite checked its neighbours and
  // not it. Reported all at once so a regression names every leak.
  it("renders no secure-development copy", () => {
    expect(findSecureDevLeaks(html)).toEqual([]);
  });

  // Belt and braces: the same terms, one assertion each, so a failure points
  // at the exact word rather than at a list.
  it.each(SECURE_DEV_TERMS)("does not leak %j", (term) => {
    expect(normalizeHtml(html)).not.toContain(term);
  });

  it.each(SECURE_DEV_PATTERNS)("does not leak %s", (pattern) => {
    expect(html).not.toMatch(pattern);
  });

  it("renders the quiz's own guide instead", () => {
    expect(html).toContain(
      "New to the quiz? Here&#x27;s everything you need to go from a GitHub sign-in to your first scored answer.",
    );
    expect(html).toContain("read the question");
    for (const title of [
      "Sign in with GitHub",
      "Open the question set",
      "Answer the question",
      "Get scored on submit",
    ]) {
      expect(html).toContain(title);
    }
    expect(html).toContain("Take the quiz");
    expect(html).toContain('href="/quiz"');
  });

  it("still renders the platform's good-to-know and scoring cards, in the quiz's terms", () => {
    expect(html).toContain("Good to know");
    expect(html).toContain("How scoring works");
    expect(html).toContain("Every question is worth a fixed number of points");
  });

  it("has no worked example, because the quiz module contributes none", () => {
    expect(html).not.toContain("Worked example");
    expect(html).not.toContain("<pre");
  });

  it("describes the page with the quiz's meta description", () => {
    expect(metadata.description).toBe(
      "Step-by-step guide to the quiz: sign in with GitHub, work through the questions, and get scored the moment you submit an answer.",
    );
  });
});
