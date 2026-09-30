// /code-of-conduct on a quiz-only event.
//
// Footer-linked from every page, and it carried secure-development's
// vocabulary in two places: the code applying to "the OWASP-CTF GitHub
// organization, and any pull requests or reviews you take part in" (an event
// without that module has no such org activity), and reporting "a bug in a
// challenge or the scorer".
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

// The page now reaches `getGithubOrg` (bootstrap-env.ts's `import
// "server-only"`) even on this quiz-only branch, which never renders the org
// — every other page fixture in this repo mocks "server-only" for the same
// reason; this file predates the page needing it.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["quiz"]),
);
// `eventContact` is config v2's source for the organizer contact address
// (issue #386, PR 1b). The baked `@/lib/enabled-modules` shim's
// `getAdminSettingsSnapshot` lazily reads this mock's `getAdminSettings`.
vi.mock("@/lib/admin-store", () => ({
  getAdminSettings: async () => ({
    moduleOverrides: {},
    enabledModuleIds: ["quiz"],
    eventIdentity: { eventContact: "organizers@example.com" },
  }),
}));

import CodeOfConduct from "@/app/(site)/code-of-conduct/page";

// `await` because the page became async when secure-development joined the
// runtime-toggleable set (issue #386): it reads the live set to decide its
// wording. Rendering the un-awaited call suspends instead of failing clearly.
const html = await CodeOfConduct().then(renderToStaticMarkup);

describe("/code-of-conduct in a quiz-only event", () => {
  it("keeps the whole of the platform's conduct copy", () => {
    expect(html).toContain("OWASP Code of Conduct");
    expect(html).toContain("Harassment of any kind ends your event.");
    expect(html).toContain("Which code applies");
    expect(html).toContain("Reporting a problem");
    // "the target" is a homonym here — the person a behaviour is aimed at.
    // The sentence stands as written on every event; the leak pattern is
    // narrowed around it instead (see secure-dev-terms.ts).
    expect(html).toContain("You do not need to be the target to report something");
    expect(html).toContain("organizers@example.com");
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

  it("says where the code reaches without naming a GitHub org this event doesn't use", () => {
    expect(html).toContain("applies to the CTF Discord and to every space this event runs in");
  });
});
