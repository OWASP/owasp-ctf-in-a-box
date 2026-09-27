// @testing-library/react is not a dependency of this repo and must not be
// added just for this test. QuizBoard has no effects that run during a
// plain render, so renderToStaticMarkup is enough to check markup — same
// pattern as team-card.test.tsx. useRouter is mocked since next/navigation's
// real hook needs a router context. Anything gated behind a useState toggle
// (submit feedback, pending text) never appears in this static render — these
// tests only assert on the initial server-derived view.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import QuizBoard, {
  QuestionCard,
  describeAttempts,
  describeCorrect,
  resultLine,
  submitDisabled,
  type Feedback,
  type QuizQuestionView,
  describeRefusal as describeQuizRefusal,
} from "@/components/quiz-board";

const singleChoiceQuestion: QuizQuestionView = {
  id: "q1",
  prompt: "Which HTTP header mitigates clickjacking?",
  type: "single",
  choices: [
    { id: "opt-a", label: "X-Frame-Options" },
    { id: "opt-b", label: "Content-Length" },
  ],
  points: 10,
  attemptsUsed: 0,
  status: "unanswered",
};

const multiChoiceQuestion: QuizQuestionView = {
  id: "q2",
  prompt: "Which of these are injection risks? (select all that apply)",
  type: "multi",
  choices: [
    { id: "opt-c", label: "String-concatenated SQL" },
    { id: "opt-d", label: "Parameterized queries" },
    { id: "opt-e", label: "eval() on user input" },
  ],
  points: 15,
  attemptsUsed: 0,
  status: "unanswered",
};

describe("QuizBoard", () => {
  it("renders each question's prompt, points, and choices", () => {
    const html = renderToStaticMarkup(<QuizBoard questions={[singleChoiceQuestion]} maxAttempts={3} authenticated />);
    expect(html).toMatch(/Which HTTP header mitigates clickjacking\?/);
    expect(html).toMatch(/10 pts/);
    expect(html).toContain("X-Frame-Options");
    expect(html).toContain("Content-Length");
  });

  it("uses radio inputs for a single-choice question", () => {
    const html = renderToStaticMarkup(<QuizBoard questions={[singleChoiceQuestion]} maxAttempts={3} authenticated />);
    expect(html).toContain('type="radio"');
    expect(html).not.toContain('type="checkbox"');
  });

  it("uses checkbox inputs for a multi-choice question", () => {
    const html = renderToStaticMarkup(<QuizBoard questions={[multiChoiceQuestion]} maxAttempts={3} authenticated />);
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('type="radio"');
  });

  it("shows an unanswered question with a submit control and selectable, non-disabled choices", () => {
    const html = renderToStaticMarkup(<QuizBoard questions={[singleChoiceQuestion]} maxAttempts={3} authenticated />);
    expect(html).toMatch(/submit answer/i);
    // The submit button itself starts disabled (nothing selected yet), but
    // the choice inputs must not be — that's what distinguishes this from
    // the cooldown state below.
    expect(html).not.toMatch(/type="radio"[^>]*disabled/);
  });

  it("shows an answered question as answered and offers no inputs", () => {
    const answered: QuizQuestionView = { ...singleChoiceQuestion, status: "answered", earnedPoints: 10 };
    const html = renderToStaticMarkup(<QuizBoard questions={[answered]} maxAttempts={3} authenticated />);
    expect(html).toMatch(/answered/i);
    expect(html).toMatch(/10 point/i);
    expect(html).not.toContain("<input");
    expect(html).not.toMatch(/submit answer/i);
  });

  // The board's progress strip: answered/total and earned/available, so the
  // page answers "how far along am I" without scrolling — and never for a
  // signed-out visitor, who has no personal progress to summarize.
  it("shows a signed-in viewer answered-of-total and earned-of-available points", () => {
    const answered: QuizQuestionView = { ...singleChoiceQuestion, status: "answered", earnedPoints: 10 };
    const html = renderToStaticMarkup(
      <QuizBoard questions={[answered, multiChoiceQuestion]} maxAttempts={3} authenticated />,
    );
    expect(html).toContain("/ 2 answered");
    expect(html).toContain("/ 25 pts");
  });

  it("shows no progress strip to a signed-out visitor", () => {
    const html = renderToStaticMarkup(
      <QuizBoard questions={[singleChoiceQuestion, multiChoiceQuestion]} maxAttempts={3} authenticated={false} />,
    );
    expect(html).not.toContain("/ 2 answered");
    expect(html).not.toContain("/ 25 pts");
  });

  // The retry instant is never printed. It renders as a live countdown that
  // starts after hydration, so the server render — which is all
  // `renderToStaticMarkup` produces — deliberately shows a time-free
  // placeholder instead. Reading a clock during render would disagree with
  // the client's first paint and trip a hydration mismatch.
  //
  // What is testable here: the placeholder, the absence of the raw timestamp,
  // and that submission stays shut. The ticking itself needs a mounted effect,
  // which this repo has no way to drive (no testing-library, by choice); the
  // arithmetic and the "4m 12s" formatting are covered directly in
  // `src/lib/__tests__/countdown.test.ts`.
  it("shows a cooldown question without leaking the raw instant, and disables submission", () => {
    const retryAt = "2026-08-18T12:34:56.000Z";
    const cooling: QuizQuestionView = { ...singleChoiceQuestion, status: "cooldown", retryAt };
    const html = renderToStaticMarkup(<QuizBoard questions={[cooling]} maxAttempts={3} authenticated />);
    expect(html).not.toContain(retryAt);
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(html).toMatch(/on cooldown/i);
    // Choices are still visible for review, but every input and the submit
    // control are disabled.
    expect(html).toContain("<input");
    expect(html).toMatch(/submit answer/i);
    expect(html).toContain('disabled=""');
  });


  // #126: the two lines describing the SAME submission used to render at
  // opposite ends of the card, with the whole form between them — the
  // cooldown above the choices, the result after the submit button. The
  // contestant met the consequence before the cause: a cooldown with no
  // explanation, four elements above the reason for it.
  //
  // Driven through QuestionCard directly, with a `feedback` prop. That is the
  // only way to get BOTH lines on screen at once: resultLine returns null for
  // a cooldown question until a submission produces feedback, and feedback is
  // client state (no testing-library in this repo, by choice). Rendering
  // QuizBoard instead would show only the cooldown line and pass whether or
  // not the fix is present.
  //
  // Asserted as ORDER IN THE MARKUP, not presence — both lines rendered
  // before the fix too, which is precisely why nothing caught this.
  it("puts the outcome before its consequence, and both above the form (#126)", () => {
    const cooling: QuizQuestionView = {
      ...singleChoiceQuestion,
      status: "cooldown",
      retryAt: "2026-08-18T12:34:56.000Z",
    };
    const html = renderToStaticMarkup(
      <QuestionCard
        question={cooling}
        authenticated
        maxAttempts={3}
        selected={[]}
        pending={false}
        feedback={{ kind: "error", text: "Not quite." }}
        onToggle={() => {}}
        onSubmit={() => {}}
      />,
    );

    const outcome = html.indexOf("Not quite.");
    const consequence = html.indexOf("On cooldown");
    const form = html.indexOf("<fieldset");

    expect(outcome).toBeGreaterThan(-1);
    expect(consequence).toBeGreaterThan(-1);
    expect(form).toBeGreaterThan(-1);
    // what happened -> what it means -> what to do
    expect(outcome).toBeLessThan(consequence);
    expect(consequence).toBeLessThan(form);
  });

  it("shows an exhausted question with no submit control", () => {
    const exhausted: QuizQuestionView = { ...singleChoiceQuestion, status: "exhausted" };
    const html = renderToStaticMarkup(<QuizBoard questions={[exhausted]} maxAttempts={3} authenticated />);
    expect(html).toMatch(/no attempts remaining/i);
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
  });

  it("offers a signed-out visitor no submit control, and no per-question prompt", () => {
    const html = renderToStaticMarkup(<QuizBoard questions={[singleChoiceQuestion]} maxAttempts={3} authenticated={false} />);
    // The single sign-in prompt is the PAGE's ("Sign in with GitHub to answer
    // questions.", quiz/page.tsx, rendered above this board) — one line for
    // the whole set. The board repeating it under every question was the
    // signed-out wall of identical CTAs the redesign removed (findings, bug
    // 1), so the board itself now renders neither a submit control nor its
    // own prompt.
    expect(html).not.toMatch(/sign in with github/i);
    expect(html).not.toContain("<button");
  });

  it("never lets a correct-answer id reach the markup, even if props carried extra leaked fields", () => {
    // Simulates an accidental leak — e.g. someone spreading a raw store
    // record (which DOES carry a correct-answer shape) into props instead of
    // building the public view model field by field. QuizBoard must never
    // echo such a field into markup even if it somehow arrived here.
    const leakedCorrectId = "leaked-correct-choice-zz9";
    const leaked = {
      ...singleChoiceQuestion,
      correct: [leakedCorrectId],
      correctChoiceIds: [leakedCorrectId],
      answerKey: leakedCorrectId,
    } as unknown as QuizQuestionView;

    const html = renderToStaticMarkup(<QuizBoard questions={[leaked]} maxAttempts={3} authenticated />);
    expect(html).not.toContain(leakedCorrectId);
  });
});

describe("the attempts budget", () => {
  it("tells a contestant how many graded attempts are left", () => {
    const html = renderToStaticMarkup(
      <QuizBoard questions={[{ ...singleChoiceQuestion, attemptsUsed: 1 }]} maxAttempts={3} authenticated />,
    );
    expect(html).toMatch(/2 of 3 attempts left/i);
  });

  it("says nothing when the organizer has uncapped attempts", () => {
    const html = renderToStaticMarkup(
      <QuizBoard questions={[singleChoiceQuestion]} maxAttempts={0} authenticated />,
    );
    expect(html).not.toMatch(/attempts left/i);
  });

  // The budget is spent and the question is banked — how many tries the
  // contestant didn't need is not a fact worth printing at them.
  it("drops the chip once the question is answered", () => {
    const answered: QuizQuestionView = {
      ...singleChoiceQuestion,
      status: "answered",
      earnedPoints: 10,
      attemptsUsed: 1,
    };
    const html = renderToStaticMarkup(<QuizBoard questions={[answered]} maxAttempts={3} authenticated />);
    expect(html).not.toMatch(/attempts left/i);
  });
});

describe("submitDisabled", () => {
  const live = { onCooldown: false, cooledDown: false, pending: false, selectedCount: 1 };

  it("opens once something is selected", () => {
    expect(submitDisabled(live)).toBe(false);
  });

  it("stays shut with nothing selected, or while a submission is in flight", () => {
    expect(submitDisabled({ ...live, selectedCount: 0 })).toBe(true);
    expect(submitDisabled({ ...live, pending: true })).toBe(true);
  });

  it("stays shut for the whole cooldown", () => {
    expect(submitDisabled({ ...live, onCooldown: true, cooledDown: false })).toBe(true);
  });

  // The regression this exists for: the cooldown branch hardcoded `disabled`,
  // so a card announcing "Cooldown's over — you can try again now." above
  // re-enabled radios still had a permanently dead button under them.
  it("re-opens the moment the countdown reaches zero", () => {
    expect(submitDisabled({ ...live, onCooldown: true, cooledDown: true })).toBe(false);
  });
});

describe("describeAttempts", () => {
  it("counts down from the cap", () => {
    expect(describeAttempts(0, 3)).toBe("3 of 3 attempts left");
    expect(describeAttempts(2, 3)).toBe("1 of 3 attempts left");
    expect(describeAttempts(3, 3)).toBe("0 of 3 attempts left");
    expect(describeAttempts(0, 1)).toBe("1 of 1 attempt left");
  });

  it("has nothing to report when attempts are uncapped", () => {
    expect(describeAttempts(4, 0)).toBeNull();
  });

  // The cap is live from /admin. An organizer who lowers it mid-event leaves
  // contestants holding more spent attempts than the new cap allows.
  it("never reports a negative budget after the cap is lowered mid-event", () => {
    expect(describeAttempts(5, 3)).toBe("0 of 3 attempts left");
  });
});

describe("resultLine", () => {
  const answered: QuizQuestionView = { ...singleChoiceQuestion, status: "answered", earnedPoints: 10 };

  it("states an answered question's award once, from the durable status", () => {
    expect(resultLine(answered, undefined)).toEqual({ kind: "success", text: "Answered — earned 10 points." });
    expect(resultLine({ ...answered, earnedPoints: 1 }, undefined)?.text).toBe("Answered — earned 1 point.");
  });

  // The duplicate this exists to prevent: a fresh submission's feedback and
  // the refreshed answered status both announcing the same points.
  it("returns the fresh feedback INSTEAD of the status line, never both", () => {
    const fresh: Feedback = { kind: "success", text: "Correct — +10 points." };
    expect(resultLine(answered, fresh)).toEqual(fresh);
  });

  it("reports an exhausted question's attempt budget when there's no feedback", () => {
    const exhausted: QuizQuestionView = { ...singleChoiceQuestion, status: "exhausted" };
    expect(resultLine(exhausted, undefined)?.text).toMatch(/no attempts remaining/i);
  });

  it("has nothing to say about an unanswered question with no feedback", () => {
    expect(resultLine(singleChoiceQuestion, undefined)).toBeNull();
  });

  it("passes a refusal or a wrong answer straight through", () => {
    const wrong: Feedback = { kind: "error", text: "Not quite. Try again." };
    expect(resultLine(singleChoiceQuestion, wrong)).toEqual(wrong);
  });
});

describe("describeCorrect", () => {
  it("announces the points awarded for a fresh correct answer", () => {
    expect(describeCorrect(10)).toBe("Correct — +10 points.");
    expect(describeCorrect(1)).toBe("Correct — +1 point.");
  });

  // The API reports an idempotent re-submission of an already-banked
  // question as `correct: true, points: 0`. Rendering that through the
  // normal template said "Correct — +0 points.", which reads as "this
  // question is worth nothing" — the opposite of the truth.
  it("never announces a +0 award for a question that was already banked", () => {
    const text = describeCorrect(0, true);
    expect(text).not.toContain("+0");
    expect(text).toMatch(/already answered/i);
  });
});

describe("describeRefusal (quiz)", () => {
  // #464: a tab loaded before an un-launch can still submit; the refusal must
  // say why, not fall through to the generic line.
  it("names the pre-launch refusal", () => {
    expect(describeQuizRefusal("not-launched")).not.toBe("That submission wasn't accepted.");
    expect(describeQuizRefusal("not-launched")).toMatch(/launch/i);
  });
});
