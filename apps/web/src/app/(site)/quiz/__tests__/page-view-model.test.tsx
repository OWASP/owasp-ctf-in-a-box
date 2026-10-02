// The keyless-contestant guarantee, pinned at the PAGE level.
//
// quiz-board.test.tsx already proves <QuizBoard> won't echo a leaked field
// into markup even if one somehow reaches it. This proves the field never
// reaches it in the first place: whatever `listQuestions()` hands back,
// /quiz's view model is built field by field from the public `Question`
// shape, so an answer key cannot ride along.
//
// That property became worth pinning separately once `GET /api/admin/quiz`
// started returning correct sets: the store now HAS a reader that returns the
// key (`listQuestionsForAdmin`), so "no caller ever holds one" is no longer
// true globally — only on this path. Hence a test that watches this path
// specifically, with a store deliberately leaking, rather than trusting the
// contestant page to keep doing the right thing by inspection.
//
// QuizBoard is mocked here (unlike page.test.tsx, which renders it for real)
// purely to capture the props it is handed — the view model itself, before
// any rendering can hide a field.

import { beforeEach, describe, expect, it, vi } from "vitest";
// #464 pre-launch lock: launched by default in this file; the "pre-launch
// lock" test below drives the refused path. The lock itself is unit-tested in
// lib/__tests__/launch.test.ts.
const launchLock = vi.hoisted(() => ({
  redirectIfNotLaunched: vi.fn(async () => ({ allowed: true, preview: false })),
}));
vi.mock("@/lib/launch", () => launchLock);
import { renderToStaticMarkup } from "react-dom/server";

const { moduleLive, getSession, listQuestions, getViewerQuiz, getAdminSettings, getResolvedModules } = vi.hoisted(
  () => ({
    moduleLive: vi.fn(),
    getSession: vi.fn(),
    listQuestions: vi.fn(),
    getViewerQuiz: vi.fn(),
    getAdminSettings: vi.fn(),
    getResolvedModules: vi.fn(),
  }),
);

const captured: { questions: Record<string, unknown>[] } = { questions: [] };

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules((id) => moduleLive(id)),
);
// Runtime admin grants (issue #147) put a Redis read behind the page's
// admin-link check for any signed-in viewer. Mocked to empty here: this suite
// is about the view model's fields, and an unmocked SMEMBERS turns it into a
// test of the datastore.
vi.mock("@/lib/admin-admins", () => ({ listStoredAdmins: async () => [] }));

vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("@/lib/resolved-modules", () => ({ getResolvedModules }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/admin-store", () => ({ getAdminSettings }));
vi.mock("@/lib/quiz-store", () => ({
  listQuestions,
  getViewerQuiz,
  QUIZ_MAX_ATTEMPTS: 3,
  QUIZ_RETRY_AFTER_MIN: 1,
}));
vi.mock("@/components/quiz-board", () => ({
  default: (props: { questions: Record<string, unknown>[] }) => {
    captured.questions = props.questions;
    return null;
  },
}));

import QuizPage from "@/app/(site)/quiz/page";

// Distinctive enough that finding it anywhere in the view model is proof of a
// leak rather than a coincidental substring.
const LEAKED_CORRECT_ID = "leaked-correct-choice-zz9";

/** A store record that HAS leaked — the shape `listQuestionsForAdmin` returns
 *  flattened, plus a few other plausible names an answer could arrive under.
 *  The page must strip every one of them, because it copies the fields it
 *  wants rather than spreading what it was given. */
const leakyRecord = {
  id: "q1",
  prompt: "Which header mitigates clickjacking?",
  type: "single",
  choices: [
    { id: "a", label: "X-Frame-Options" },
    { id: "b", label: "Content-Length" },
  ],
  points: 10,
  order: 1,
  correct: [LEAKED_CORRECT_ID],
  correctChoiceIds: [LEAKED_CORRECT_ID],
  answerKey: LEAKED_CORRECT_ID,
};

beforeEach(() => {
  vi.clearAllMocks();
  captured.questions = [];
  moduleLive.mockReturnValue(true);
  getSession.mockResolvedValue({ user: { login: "alice" } });
  getViewerQuiz.mockResolvedValue({ answered: {}, attempts: {} });
  getAdminSettings.mockResolvedValue({ quizMaxAttempts: 3, quizRetryAfterMin: 5 });
  getResolvedModules.mockResolvedValue([{ id: "quiz", title: "Quiz", blurb: "Answer security questions for points." }]);
});

describe("/quiz view model", () => {
  it("carries no answer field, even when the store hands it one", async () => {
    listQuestions.mockResolvedValue([leakyRecord]);

    renderToStaticMarkup(await QuizPage());

    // Non-vacuity first: the question really did make it into the view model.
    // Without this, an empty list would satisfy every assertion below while
    // proving nothing.
    expect(captured.questions).toHaveLength(1);
    expect(captured.questions[0].prompt).toBe(leakyRecord.prompt);

    const view = captured.questions[0];
    // Serialised first, and on the VALUE rather than the field name: this is
    // the assertion that still catches a leak arriving under a field nobody
    // thought to blacklist, or nested inside one.
    expect(JSON.stringify(view)).not.toContain(LEAKED_CORRECT_ID);
    expect(Object.keys(view)).not.toContain("correct");
    expect(Object.keys(view)).not.toContain("correctChoiceIds");
    expect(Object.keys(view)).not.toContain("answerKey");
  });

  it("exposes exactly the public fields plus the derived per-viewer status", async () => {
    // Pins the whitelist itself: a future field added by a spread rather than
    // copied on purpose fails here even if it isn't named "correct".
    listQuestions.mockResolvedValue([leakyRecord]);

    renderToStaticMarkup(await QuizPage());

    expect(Object.keys(captured.questions[0]).sort()).toEqual(
      // `attemptsUsed` is a deliberate addition (the attempts-left chip), not
      // a spread — a count of graded tries carries nothing from the answer key.
      ["attemptsUsed", "choices", "id", "points", "prompt", "status", "type"].sort(),
    );
  });
});
// The same guarantee one level down — that <QuizBoard> won't echo a leaked
// field into markup even if one did reach it — is quiz-board.test.tsx's
// "never lets a correct-answer id reach the markup" test. The two guards are
// independent on purpose; neither is allowed to be the only one.
