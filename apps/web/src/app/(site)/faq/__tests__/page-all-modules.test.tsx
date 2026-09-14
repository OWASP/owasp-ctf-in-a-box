// /faq on an all-modules event — the shape the wizard produces by default,
// and the one case the suite never covered.
//
// Every module writes the reader's questions rather than its own, so the
// generic ones collide by design: all three have a "do I need experience" and
// a "what do I need to bring". Concatenating the contributions rendered the
// same question text three times, as three identical collapsed rows.
//
// It shipped precisely because the only FAQ tests here were quiz-only and
// classic-only, and a single-module event cannot collide. This file is the
// missing half: it pins that questions are unique on the page and that no
// module's answer was dropped to achieve that.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/enabled-modules", () => import("@/test/enabled-modules-baked"));
vi.mock("@/lib/admin-store", () => ({
  // `getResolvedModules` falls back to the baked shim's ALL-module
  // `defaultModuleIds` (which includes ai) unless this names the fixture's
  // own three-module set.
  getAdminSettings: async () => ({
    moduleOverrides: {},
    enabledModuleIds: ["secure-development", "quiz", "classic"],
  }),
}));
vi.mock("@/lib/modules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules")>()),
  isModuleEnabled: (id: string) => ["secure-development", "quiz", "classic"].includes(id),
}));

import Faq from "@/app/(site)/faq/page";

const html = await Faq().then(renderToStaticMarkup);

/** Every rendered question, in page order. The accordion puts each one in a
 *  <span> that opens its <button> (faq-accordion.tsx), and `q` is a plain
 *  string, so the capture needs no tag-stripping — `[^<]*` cannot cross into
 *  markup. Deliberately not a strip-the-tags regex: that shape is an
 *  incomplete sanitizer and CodeQL flags it, rightly, even in a test. */
function questions(): string[] {
  const re = /<button[^>]*>\s*<span[^>]*>([^<]*)<\/span>/g;
  return [...html.matchAll(re)].map((m) => m[1].trim());
}

describe("/faq with every module enabled", () => {
  it("renders each question exactly once", () => {
    const seen = questions();
    expect(seen.length).toBeGreaterThan(0);
    const duplicated = seen.filter((q, i) => seen.indexOf(q) !== i);
    expect(duplicated).toEqual([]);
  });

  it("still asks the questions every module contributes", () => {
    const seen = questions();
    expect(seen).toContain("Do I need experience to compete?");
    expect(seen).toContain("What do I need to bring?");
  });

  it("keeps the platform-wide questions", () => {
    expect(html).toContain("Can I compete solo?");
    expect(html).toContain("Is there a prize?");
    expect(html).toContain("Where do I ask for help during the event?");
  });

  it("keeps every module's answer to a shared question, labelled by module", () => {
    // The three "do I need experience" answers differ only in what they name —
    // targets, questions, flags. Losing one to a dedupe would be silent, so
    // assert each distinctive fragment survives.
    expect(html).toContain("Start with a low-point challenge on any app");
    expect(html).toContain("Start with whichever question looks approachable");
    expect(html).toContain("Start with whichever one looks approachable");
    // …and that a reader can tell whose answer is whose.
    for (const title of ["Secure Development", "Quiz", "Jeopardy"]) {
      expect(html).toContain(title);
    }
  });
});
