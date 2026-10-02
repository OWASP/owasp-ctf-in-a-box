// @testing-library/react is not a dependency of this repo and must not be
// added just for this test. renderToStaticMarkup (ships with react-dom) is
// enough to check the initial server render, since we only assert on markup
// text — same pattern as admin/__tests__/page.test.tsx.
import { beforeEach, describe, expect, it, vi } from "vitest";
// #464 pre-launch lock: launched by default in this file; the "pre-launch
// lock" test below drives the refused path. The lock itself is unit-tested in
// lib/__tests__/launch.test.ts.
const launchLock = vi.hoisted(() => ({
  redirectIfNotLaunched: vi.fn(async () => ({ allowed: true, preview: false })),
}));
vi.mock("@/lib/launch", () => launchLock);
import { renderToStaticMarkup } from "react-dom/server";

const { moduleLive, isAdminLogin, getSession, listQuestions, getViewerQuiz, getAdminSettings, getResolvedModules } = vi.hoisted(() => ({
  moduleLive: vi.fn(),
  isAdminLogin: vi.fn(),
  getSession: vi.fn(),
  listQuestions: vi.fn(),
  getViewerQuiz: vi.fn(),
  getAdminSettings: vi.fn(),
  getResolvedModules: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules((id) => moduleLive(id)),
);
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
// QuizBoard (the client component this page renders) calls useRouter for
// its post-submit refresh — needs a mock the same way quiz-board.test.tsx
// mocks it, since real next/navigation needs a router context.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/resolved-modules", () => ({ getResolvedModules }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/admin-auth", () => ({ isAdminLogin }));
vi.mock("@/lib/admin-store", () => ({ getAdminSettings }));
vi.mock("@/lib/quiz-store", () => ({
  listQuestions,
  getViewerQuiz,
  QUIZ_MAX_ATTEMPTS: 3,
  QUIZ_RETRY_AFTER_MIN: 1,
}));

import QuizPage from "@/app/(site)/quiz/page";

const baseQuestions = [
  {
    id: "q1",
    prompt: "Answered already",
    type: "single",
    choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    points: 10,
    order: 0,
  },
  {
    id: "q2",
    prompt: "Out of attempts",
    type: "single",
    choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    points: 5,
    order: 1,
  },
  {
    id: "q3",
    prompt: "Still cooling down",
    type: "single",
    choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    points: 5,
    order: 2,
  },
  {
    id: "q4",
    prompt: "Never attempted",
    type: "multi",
    choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    points: 20,
    order: 3,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  isAdminLogin.mockReturnValue(false);
  // Registry-default fallback, same shape resolveModules would produce for an
  // event with only the quiz module enabled and no organizer overrides. Tests
  // that care about an organizer-renamed title override this per-case.
  getResolvedModules.mockResolvedValue([{ id: "quiz", title: "Quiz", blurb: "Answer security questions for points." }]);
});

describe("quiz page gate", () => {
  it("404s when the quiz module is not enabled", async () => {
    moduleLive.mockReturnValue(false);
    await expect(QuizPage()).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });
});

describe("quiz page view model", () => {
  it("derives answered/exhausted/cooldown/unanswered per question from viewer progress and settings", async () => {
    moduleLive.mockReturnValue(true);
    getSession.mockResolvedValue({ user: { login: "alice" } });
    listQuestions.mockResolvedValue(baseQuestions);
    getAdminSettings.mockResolvedValue({ quizMaxAttempts: 2, quizRetryAfterMin: 5 });
    getViewerQuiz.mockResolvedValue({
      answered: { q1: { points: 10, at: "2026-08-18T00:00:00.000Z" } },
      attempts: {
        q2: { attempts: 2, lastAt: "2026-08-18T00:00:00.000Z" }, // hit the 2-attempt cap
        q3: { attempts: 1, lastAt: new Date().toISOString() }, // fresh — inside the 5-minute cooldown
      },
    });

    const html = renderToStaticMarkup(await QuizPage());

    expect(html).toMatch(/answered.*earned 10 point/i);
    expect(html).toMatch(/no attempts remaining/i);
    expect(html).toMatch(/on cooldown/i);
    expect(html).toMatch(/submit answer/i); // q4 (never attempted) still offers one
    // The count lives in the board's progress strip now, not a sentence.
    expect(html).toContain("/ 4 answered");
  });

  it("treats a signed-out visitor as having no progress and prompts sign-in instead of a submit control", async () => {
    moduleLive.mockReturnValue(true);
    getSession.mockResolvedValue(null);
    listQuestions.mockResolvedValue([baseQuestions[3]]);
    getAdminSettings.mockResolvedValue({ quizMaxAttempts: null, quizRetryAfterMin: null });

    const html = renderToStaticMarkup(await QuizPage());

    expect(getViewerQuiz).not.toHaveBeenCalled();
    expect(html).toMatch(/sign in with github/i);
    expect(html).not.toContain("<button");
  });

  it("shows an empty state with no questions available", async () => {
    moduleLive.mockReturnValue(true);
    getSession.mockResolvedValue(null);
    listQuestions.mockResolvedValue([]);
    getAdminSettings.mockResolvedValue({ quizMaxAttempts: null, quizRetryAfterMin: null });

    const html = renderToStaticMarkup(await QuizPage());
    expect(html).toMatch(/no quiz questions are available/i);
  });

  // The state every new event starts in, and the first thing an organizer
  // sees after provisioning. A contestant's "check back soon" is a correct
  // dead end for them and a useless one for whoever has to author the bank.
  it("routes an organizer to the authoring tab from the empty state", async () => {
    moduleLive.mockReturnValue(true);
    isAdminLogin.mockReturnValue(true);
    getSession.mockResolvedValue({ user: { login: "alice" } });
    listQuestions.mockResolvedValue([]);
    getViewerQuiz.mockResolvedValue({ answered: {}, attempts: {} });
    getAdminSettings.mockResolvedValue({ quizMaxAttempts: null, quizRetryAfterMin: null });

    const html = renderToStaticMarkup(await QuizPage());

    expect(html).toContain('href="/admin?tab=quiz"');
    expect(html).toMatch(/author questions/i);
    expect(html).not.toMatch(/check back soon/i);
  });

  it("shows a signed-in contestant the plain empty state, with no admin link", async () => {
    moduleLive.mockReturnValue(true);
    isAdminLogin.mockReturnValue(false);
    getSession.mockResolvedValue({ user: { login: "bob" } });
    listQuestions.mockResolvedValue([]);
    getViewerQuiz.mockResolvedValue({ answered: {}, attempts: {} });
    getAdminSettings.mockResolvedValue({ quizMaxAttempts: null, quizRetryAfterMin: null });

    const html = renderToStaticMarkup(await QuizPage());

    expect(html).toMatch(/check back soon/i);
    expect(html).not.toContain("/admin");
  });

  it("renders the organizer's module title instead of the default", async () => {
    moduleLive.mockReturnValue(true);
    getSession.mockResolvedValue(null);
    listQuestions.mockResolvedValue([]);
    getAdminSettings.mockResolvedValue({ quizMaxAttempts: null, quizRetryAfterMin: null });
    getResolvedModules.mockResolvedValue([{ id: "quiz", title: "Round 1", blurb: "Ten questions." }]);

    const html = renderToStaticMarkup(await QuizPage());
    expect(html).toContain("Round 1");
  });
});

// The blurb is organizer-editable in /admin and used to reach `generateMetadata`
// and nothing else — an organizer could rewrite it, save, reload the page they
// were describing, and see no change at all. It is the module's own account of
// itself, so it is the page's lede; the per-viewer progress line that used to
// occupy that slot is viewer state, and moved into the body.
describe("quiz page blurb and progress line", () => {
  beforeEach(() => {
    moduleLive.mockReturnValue(true);
    getAdminSettings.mockResolvedValue({ quizMaxAttempts: null, quizRetryAfterMin: null });
    getViewerQuiz.mockResolvedValue({ answered: {}, attempts: {} });
    listQuestions.mockResolvedValue(baseQuestions);
    getResolvedModules.mockResolvedValue([
      { id: "quiz", title: "Round 1", blurb: "Ten questions on the OWASP Top 10, one point each." },
    ]);
  });

  it("renders the organizer's blurb as the page header's description", async () => {
    getSession.mockResolvedValue({ user: { login: "alice" } });

    const html = renderToStaticMarkup(await QuizPage());

    expect(html).toContain("Ten questions on the OWASP Top 10, one point each.");
    // In the HEADER, not merely somewhere on the page: the blurb must sit
    // between the <h1> and the header's divider, which is the slot the
    // progress line used to hold. Matching across the h1 is what makes this
    // fail if the blurb is only rendered further down the body.
    expect(html).toMatch(/<h1[^>]*>Round 1<\/h1><p[^>]*>Ten questions on the OWASP Top 10, one point each\.<\/p>/);
  });

  it("carries the viewer's progress in the board strip, once — the old sentence is gone", async () => {
    getSession.mockResolvedValue({ user: { login: "alice" } });

    const html = renderToStaticMarkup(await QuizPage());

    // The strip owns the count (answered/total + points); the sentence that
    // used to restate the same numbers directly above it must not return.
    expect(html).toContain("/ 4 answered");
    expect(html).not.toMatch(/You&#x27;ve answered/);
    // Below the header divider — viewer state stays out of the header slot.
    const dividerAt = html.indexOf("bg-gradient-to-r");
    const progressAt = html.indexOf("/ 4 answered");
    expect(dividerAt).toBeGreaterThan(-1);
    expect(progressAt).toBeGreaterThan(dividerAt);
  });

  it("still prompts a signed-out visitor to sign in, in the body", async () => {
    getSession.mockResolvedValue(null);

    const html = renderToStaticMarkup(await QuizPage());

    expect(html).toMatch(/sign in with github to answer questions/i);
    // And the header still describes the module rather than the viewer.
    expect(html).toMatch(/<h1[^>]*>Round 1<\/h1><p[^>]*>Ten questions on the OWASP Top 10, one point each\.<\/p>/);
  });

  // Regression guard for the blurb swap itself. The progress line used to be
  // the header description, which rendered whatever the question count was;
  // relocating it into the populated branch took the sign-in prompt away from
  // a signed-out visitor looking at a quiz with no questions authored yet —
  // the visitor most worth telling, since signing in now is what lets them
  // answer the moment questions appear.
  it("still prompts a signed-out visitor to sign in when there are no questions at all", async () => {
    getSession.mockResolvedValue(null);
    listQuestions.mockResolvedValue([]);

    const html = renderToStaticMarkup(await QuizPage());

    // Non-vacuity: this really is the empty-state render, not a populated one.
    expect(html).toMatch(/no quiz questions are available/i);
    expect(html).toMatch(/sign in with github to answer questions/i);
  });

  it("falls back to the registry default blurb when the organizer set none", async () => {
    getSession.mockResolvedValue(null);
    getResolvedModules.mockResolvedValue([{ id: "quiz", title: "Quiz", blurb: "Answer security questions for points." }]);

    const html = renderToStaticMarkup(await QuizPage());
    expect(html).toContain("Answer security questions for points.");
  });
});

describe("quiz page metadata", () => {
  it("falls back to the registry default title/description when there's no organizer override", async () => {
    getResolvedModules.mockResolvedValue([{ id: "quiz", title: "Quiz", blurb: "Answer security questions for points." }]);
    const { generateMetadata } = await import("@/app/(site)/quiz/page");

    await expect(generateMetadata()).resolves.toEqual({
      title: "Quiz",
      description: "Answer security questions for points.",
    });
  });

  it("uses the organizer's resolved title/blurb when set", async () => {
    getResolvedModules.mockResolvedValue([{ id: "quiz", title: "Round 1", blurb: "Ten questions." }]);
    const { generateMetadata } = await import("@/app/(site)/quiz/page");

    await expect(generateMetadata()).resolves.toEqual({
      title: "Round 1",
      description: "Ten questions.",
    });
  });
});

describe("pre-launch lock (#464)", () => {
  it("sends a refused viewer to the landing page before loading any content", async () => {
    launchLock.redirectIfNotLaunched.mockImplementationOnce(async () => {
      throw new Error("NEXT_REDIRECT:/");
    });
    await expect(QuizPage()).rejects.toThrow("NEXT_REDIRECT:/");
    expect(listQuestions).not.toHaveBeenCalled();
  });
});
