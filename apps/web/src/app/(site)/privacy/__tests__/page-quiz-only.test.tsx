// /privacy on a quiz-only event.
//
// This page is platform copy — an inventory of what THIS codebase stores — but
// which stores are live is per-event, and it was written as though every event
// ran secure-development: hint purchases, a per-challenge breakdown, "the
// scorer credits points to the account that authored a pull request", a PR
// number and commit hash on the public board. None of that exists on a
// quiz-only event, and the answers that DO get stored were not mentioned at
// all — a privacy notice that is wrong in both directions.
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

vi.mock("@/lib/enabled-modules", () => import("@/test/enabled-modules-baked"));
vi.mock("@/lib/modules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules")>()),
  isModuleEnabled: (id: string) => id === "quiz",
}));

import Privacy from "@/app/(site)/privacy/page";

// `await` because the page became async when module enablement moved to
// runtime (issue #175): it reads the live set to decide whether to make the
// quiz and classic disclosures. Rendering the un-awaited call suspends, which
// React reports as "a component suspended while responding to synchronous
// input" rather than as anything resembling a missing await.
const rendered = renderToStaticMarkup(await Privacy());

const html = rendered;

describe("/privacy in a quiz-only event", () => {
  // #464 removed the password gate, and with it the gate cookie and the
  // per-IP attempt throttle — the one place this site ever stored an IP. The
  // notice must stop disclosing a store that no longer exists.
  it("discloses no gate cookie and no IP throttle any more", () => {
    expect(rendered).not.toContain("ctf-challenges-gate");
    expect(rendered).not.toContain("five wrong tries");
    expect(rendered).not.toContain("the one place on this site where an IP address is stored");
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

  it("keeps every platform promise", () => {
    expect(rendered).toContain("What we never do");
    expect(rendered).toContain("No advertising, no tracking pixels, no third-party analytics");
    expect(rendered).toContain("We never ask GitHub for write access.");
    expect(rendered).toContain("Cookies");
    expect(rendered).toContain("Counting where the event reached");
    expect(rendered).toContain("Your choices, and how to reach a human");
  });

  it("discloses what a quiz-only event actually stores", () => {
    // The gap this suite closed: quiz answers are written to
    // `ctf:quiz:answers:<login>` and `ctf:quiz:attempts:<login>` and were
    // named nowhere on this page.
    expect(rendered).toContain("Your answers");
    expect(rendered).toContain("the choices you submitted");
    expect(rendered).toContain("how many attempts you have spent");
  });

  it("promises nothing that only the other module has", () => {
    expect(rendered).not.toContain("Hint purchases");
    expect(rendered).not.toContain("most recent pull request");
  });
});
