// The per-module 404 boundaries (issue #175 follow-up).
//
// What these pin is the CLAIM the page makes, not its markup. A module route
// 404s for exactly one reason — this event is not running that module — and
// the root 404's "the link is just wrong or out of date" is false in that
// case. A contestant who had /flags open a minute ago has a correct link and a
// working browser; sending them to hunt for a better URL is the failure mode
// worth a test.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", () => import("@/test/enabled-modules-baked"));
// The flags boundaries name the module by its RESOLVED title now (an
// organizer can rename it in /admin); getResolvedModules needs the same two
// stubs every other consumer's suite carries.
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/admin-store", () => ({ getAdminSettings: async () => ({ moduleOverrides: {} }) }));
// The shared body resolves live modules for its route directory; that is
// covered elsewhere, and stubbing it keeps these tests about the copy.
vi.mock("@/components/not-found-body", () => ({
  getNotFoundRoutes: async () => [],
  default: ({ title, description, eyebrow }: { title: string; description: string; eyebrow?: string }) => (
    <div>
      <span>{eyebrow}</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  ),
}));

import FlagsNotFound from "@/app/(site)/flags/not-found";
import QuizNotFound from "@/app/(site)/quiz/not-found";
import ChallengesNotFound from "@/app/(site)/challenges/not-found";

/** Static markup escapes apostrophes to `&#x27;`, so "doesn't" never matches a
 *  regex written the way the copy reads. Decode before asserting rather than
 *  writing entity-aware patterns, which drift the moment the copy is edited. */
const text = (html: string) => html.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&");

const WRONG_LINK = /link is just wrong|out of date|doesn't exist/i;

// challenges/not-found.tsx branches on secureDevAvailable(process.env) — the
// "switched off" copy below is the has-a-scorer-image case (CodeRabbit
// round 1 finding D). Set it for this whole suite so the shared loop below
// keeps exercising that branch; the scorer-less branch gets its own
// describe further down, which deletes it just for that render.
process.env.SCORE_IMAGE = "ghcr.io/x/score:latest";

describe("a switched-off module's 404", () => {
  for (const [label, Component, name] of [
    ["flags", FlagsNotFound, "Jeopardy"],
    ["quiz", QuizNotFound, "Quiz"],
    ["challenges", ChallengesNotFound, "Secure Development"],
  ] as const) {
    describe(label, async () => {
      const html = text(renderToStaticMarkup(await Component()));

      it("names the module, so the page says which thing is off", () => {
        expect(html).toContain(name);
      });

      it("does NOT tell the contestant their link is wrong", () => {
        // The whole point. Their link is correct; the event changed under them.
        expect(html).not.toMatch(WRONG_LINK);
      });

      it("says their existing progress is untouched", () => {
        // Disabling is a switch, not a delete — and the person most likely to
        // fear otherwise is the one staring at this page.
        expect(html).toMatch(/nothing you have already solved is affected/i);
      });

      it("says it can come back", () => {
        expect(html).toMatch(/come back/i);
      });
    });
  }
});

// CodeRabbit round 1, finding D: a deployment with no scorer image at all
// never ran secure-development, so "an organizer turned the module off... it
// can come back" is false for it — there is nothing to come back from. That
// deployment gets its own copy instead.
describe("challenges' 404 on a deployment with no scorer image at all", () => {
  it("says the module isn't available here, not that it was switched off", async () => {
    delete process.env.SCORE_IMAGE;
    try {
      const html = text(renderToStaticMarkup(await ChallengesNotFound()));
      expect(html).toContain("Secure Development");
      expect(html).toMatch(/isn't available on this event/i);
      // Not the "switched off" claim — this deployment never ran it.
      expect(html).not.toMatch(/switched off/i);
      expect(html).not.toMatch(WRONG_LINK);
      expect(html).toMatch(/nothing you have already solved is affected/i);
      expect(html).toMatch(/what this event does have open/i);
    } finally {
      process.env.SCORE_IMAGE = "ghcr.io/x/score:latest";
    }
  });

  it("still carries the eyebrow, unchanged", async () => {
    delete process.env.SCORE_IMAGE;
    try {
      const html = text(renderToStaticMarkup(await ChallengesNotFound()));
      expect(html).toContain("Not running");
    } finally {
      process.env.SCORE_IMAGE = "ghcr.io/x/score:latest";
    }
  });
});

