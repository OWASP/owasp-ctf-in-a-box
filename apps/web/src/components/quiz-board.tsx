"use client";

// The quiz's interactive surface. Owns selection state and dispatches to
// /api/quiz/answer, which authenticates the session and is the sole
// authority on grading, the attempt cap, and the cooldown (see
// src/lib/quiz-store.ts). This component never sees — and cannot render —
// a correct answer: `QuizQuestionView` has no field that could carry one.
//
// State split, same shape as team-card.tsx: `questions` (the prop) is the
// server's source of truth for each question's status; `selections` /
// `pending` / `feedback` are UI-only, keyed by question id, and survive a
// `router.refresh()` (which re-renders the server parent with fresh props)
// since this component instance isn't remounted.

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Choice, QuestionType } from "@/lib/quiz-store";
import ProgressSummary from "@/components/progress-summary";
import { formatCompact, getRemaining, type Remaining } from "@/lib/countdown";

/** Per-question progress, mutually exclusive. Every branch carries only
 *  public-safe data — never the correct choice id(s). */
export type QuizStatus =
  | { status: "unanswered" }
  | { status: "answered"; earnedPoints: number }
  | { status: "cooldown"; retryAt: string }
  | { status: "exhausted" };

/** What the board needs to render one question — deliberately just the
 *  public `Question` fields plus this viewer's derived status. Built by
 *  the server page from `listQuestions()` + `getViewerQuiz()`, never from a
 *  spread of a raw store record (which is how an answer key would leak). */
export type QuizQuestionView = {
  id: string;
  prompt: string;
  type: QuestionType;
  choices: Choice[];
  points: number;
  /** Graded attempts this viewer has already spent on this question. Drives
   *  the attempts chip; 0 for a signed-out visitor and for anything never
   *  attempted. Server-derived from the same `ctf:quiz:attempts:<login>` row
   *  the retry gate reads, so the chip and the gate can't disagree. */
  attemptsUsed: number;
} & QuizStatus;

type AnswerResponse =
  | { correct: true; points: number; already?: boolean; dryRun?: boolean }
  | { correct: false; dryRun?: boolean }
  | { error: string; retryAt?: string };

export type Feedback = { kind: "success" | "error" | "info"; text: string };

/** Feedback for an accepted (correct) submission. The `already` branch is
 *  NOT cosmetic: `/api/quiz/answer` reports an idempotent re-submission of a
 *  question this login had already banked as `correct: true, points: 0`
 *  (see quiz-store's AnswerResult), and rendering that through the normal
 *  template would announce "Correct — +0 points." — which reads as "this
 *  question is worth nothing", the opposite of the truth. Exported for
 *  direct testing. */
export function describeCorrect(points: number, already?: boolean, dryRun?: boolean): string {
  // An admin preview (#464): graded by the same script, nothing recorded.
  if (dryRun) return `Correct — preview only, nothing was recorded (+${points} once the event launches).`;
  if (already) return "You already answered this one — those points are already yours.";
  return `Correct — +${points} point${points === 1 ? "" : "s"}.`;
}

/** The wrong-answer line; an admin preview (#464) says nothing was recorded.
 *  Exported for direct testing. */
export function describeIncorrect(dryRun?: boolean): string {
  return dryRun ? "Not quite — preview only, nothing was recorded." : "Not quite.";
}

/** The ONE result line a question card prints, and the precedence between the
 *  two things that used to print their own.
 *
 *  An answered question carries a durable "Answered — earned 50 points." from
 *  its server-derived status, and a just-submitted answer sets a transient
 *  "Correct — +50 points." feedback. Both were rendered, stacked, so a
 *  contestant read the same points twice and reasonably wondered whether they
 *  had been scored twice. Fresh feedback wins: it is the more specific
 *  statement of the same fact, and it is the only thing that can say "you
 *  already had these points" or why a submission was refused. On the next page
 *  load the feedback is gone and the durable line says it instead. Mirrors
 *  `resultLine` in challenge-detail.tsx. */
export function resultLine(question: QuizQuestionView, feedback: Feedback | undefined): Feedback | null {
  if (feedback) return feedback;
  if (question.status === "answered") {
    const p = question.earnedPoints;
    return { kind: "success", text: `Answered — earned ${p} point${p === 1 ? "" : "s"}.` };
  }
  if (question.status === "exhausted") {
    return { kind: "info", text: "No attempts remaining for this question." };
  }
  return null;
}

/** How many graded attempts are left, as a contestant-facing chip — or null
 *  when the organizer has uncapped attempts (`maxAttempts: 0`) and there is
 *  no budget to report.
 *
 *  The cap has always been enforced and never shown: a contestant got three
 *  graded tries by default, was never told, and discovered the limit by
 *  running into it. Clamped at 0 because the cap is re-read live from
 *  /admin — an organizer who lowers it mid-event can leave a contestant with
 *  more attempts spent than the new cap allows, and "-1 attempts left" is
 *  not a thing to print at them. */
export function describeAttempts(attemptsUsed: number, maxAttempts: number): string | null {
  if (maxAttempts <= 0) return null;
  const left = Math.max(0, maxAttempts - attemptsUsed);
  return `${left} of ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"} left`;
}

/** Whether the submit control is inert, for BOTH branches that render one.
 *
 *  The cooldown branch used to hardcode `disabled`, while the choices it sat
 *  under were released the moment the countdown reached zero — so a card
 *  reading "Cooldown's over — you can try again now." offered live radios
 *  above a button that could not be pressed again without a manual reload.
 *  One rule, one place, so the two can't drift apart again.
 *
 *  Releasing on `cooledDown` is optimistic by design: GRADE_SCRIPT re-checks
 *  the cooldown inside the same atomic EVAL that records the attempt, so an
 *  early click is refused server-side rather than granted. */
export function submitDisabled(opts: {
  onCooldown: boolean;
  /** The client-side countdown has reached zero. False through the server
   *  render and the first paint — see `useCooldown`. */
  cooledDown: boolean;
  pending: boolean;
  selectedCount: number;
}): boolean {
  if (opts.onCooldown && !opts.cooledDown) return true;
  return opts.pending || opts.selectedCount === 0;
}

/** Exported for direct testing (the pre-launch copy, #464). */
export function describeRefusal(reason: string): string {
  switch (reason) {
    case "not-launched":
      // #464: reachable from a tab loaded before an un-launch — the page
      // itself redirects before launch, but an open tab can still submit.
      return "The event hasn't launched yet — nothing counts until it starts.";
    case "paused":
      return "Scoring is paused right now. Try again later.";
    case "ended":
      // #567: the scheduled end has passed. Final — no "try again", which
      // is the pause's promise and false once the event is over.
      return "Scoring has closed — the event has ended.";
    case "answered":
      return "You already answered this one.";
    case "exhausted":
      return "No attempts remaining for this question.";
    case "cooldown":
      // Deliberately no instant here. The question's own cooldown line runs a
      // live countdown; a second, frozen copy of the same deadline in the
      // feedback area would be stale the moment it rendered.
      return "On cooldown right now — the timer on the question shows when you can retry.";
    case "unavailable":
      return "Couldn't verify that right now. Try again in a moment.";
    case "no-team":
      // Names the fix, not the rule. Someone who reaches this has already
      // answered a question and is being told it didn't count; "you need a
      // team" without saying where to get one is a dead end.
      return "You need a team before answers count — create one on your profile, or hit Play solo there for a team of one.";
    default:
      return "That submission wasn't accepted.";
  }
}

/** Ticks a question's cooldown once a second.
 *
 *  `mounted` stays false for the server render AND the client's first paint,
 *  so both produce identical markup and hydration can't mismatch — the same
 *  shape `components/event-countdown.tsx` uses, and the reason neither reads
 *  a clock during render. Callers show a time-free placeholder until it
 *  flips. Returns `remaining: null` once the deadline passes.
 *
 *  Passing `undefined` (a question that isn't cooling down) parks the hook:
 *  no timer, no state churn. It still has to be CALLED unconditionally. */
function useCooldown(retryAt: string | undefined): { mounted: boolean; remaining: Remaining | null } {
  const [state, setState] = useState<{ mounted: boolean; remaining: Remaining | null }>({
    mounted: false,
    remaining: null,
  });

  useEffect(() => {
    // Parked: no timer, and deliberately no state reset either. Resetting here
    // would be a synchronous setState in an effect body, and it would be
    // unobservable anyway — every reader guards on `status === "cooldown"`,
    // which is the only case that supplies a `retryAt` at all.
    if (!retryAt) return;
    const targetMs = new Date(retryAt).getTime();
    const tick = () => setState({ mounted: true, remaining: getRemaining(targetMs) });
    // Deferred rather than called in the effect body, matching event-countdown:
    // it reads as subscribing to the clock instead of computing during render,
    // and satisfies react-hooks/set-state-in-effect.
    const timeout = setTimeout(tick, 0);
    const interval = setInterval(tick, 1000);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [retryAt]);

  return state;
}

export default function QuizBoard({
  questions,
  authenticated,
  maxAttempts,
}: {
  questions: QuizQuestionView[];
  /** The organizer's graded-attempt cap, live from /admin (0 = uncapped).
   *  Passed down rather than read here so the board and the server's own
   *  status derivation are working from the same number. */
  maxAttempts: number;
  /** False for a signed-out visitor: questions stay visible, but submitting
   *  requires a GitHub session (`/api/quiz/answer` 401s otherwise), so an
   *  unanswered question renders a sign-in prompt instead of a submit
   *  control. */
  authenticated: boolean;
}) {
  const router = useRouter();
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<Record<string, Feedback | undefined>>({});

  function toggle(question: QuizQuestionView, choiceId: string) {
    setSelections((prev) => {
      const current = prev[question.id] ?? [];
      if (question.type === "single") {
        return { ...prev, [question.id]: [choiceId] };
      }
      const next = current.includes(choiceId) ? current.filter((id) => id !== choiceId) : [...current, choiceId];
      return { ...prev, [question.id]: next };
    });
  }

  async function submit(question: QuizQuestionView) {
    const choices = selections[question.id] ?? [];
    if (choices.length === 0 || pending[question.id]) return;

    setPending((prev) => ({ ...prev, [question.id]: true }));
    setFeedback((prev) => ({ ...prev, [question.id]: undefined }));
    try {
      const res = await fetch("/api/quiz/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: question.id, choices }),
      });
      const data = (await res.json().catch(() => ({}))) as AnswerResponse;
      if (res.ok && "correct" in data) {
        setFeedback((prev) => ({
          ...prev,
          [question.id]: data.correct
            ? { kind: "success", text: describeCorrect(data.points, data.already, data.dryRun) }
            // No "Try again." here. Whether they CAN try again right now is
            // the retry gate's answer, not this line's: a wrong answer
            // usually starts a cooldown, and the card's own countdown says
            // when. Printing an invitation next to a form the same
            // submission just disabled is what made this read as broken.
            : { kind: "error", text: describeIncorrect(data.dryRun) },
        }));
      } else if ("error" in data && typeof data.error === "string") {
        setFeedback((prev) => ({
          ...prev,
          [question.id]: { kind: "info", text: describeRefusal(data.error) },
        }));
      } else {
        setFeedback((prev) => ({ ...prev, [question.id]: { kind: "error", text: "Something went wrong. Try again." } }));
      }
    } catch {
      setFeedback((prev) => ({ ...prev, [question.id]: { kind: "error", text: "Something went wrong. Try again." } }));
    } finally {
      setPending((prev) => ({ ...prev, [question.id]: false }));
      // Resyncs status (answered/cooldown/exhausted) from the server's own
      // derivation — this component never decides that for itself.
      router.refresh();
    }
  }

  // The board's own progress, from the same props the cards render — one
  // source, no second count that can drift. `earnedPoints` (what the grade
  // actually banked) rather than `points` (the sticker price), so a question
  // deleted-and-recreated or re-priced mid-event still reads honestly.
  const answeredCount = questions.filter((q) => q.status === "answered").length;
  const earnedPoints = questions.reduce(
    (n, q) => n + (q.status === "answered" ? q.earnedPoints : 0),
    0,
  );
  const availablePoints = questions.reduce((n, q) => n + q.points, 0);

  return (
    <div className="flex flex-col gap-5">
      {/* Progress strip — the shared shape (progress-summary.tsx), so this
          board reads exactly like the classic rail and the challenge
          browser: answered/total, earned/available, bar. */}
      {authenticated && questions.length > 0 && (
        <div className="rounded-lg border border-white/[0.06] bg-[#16162a] px-4 py-3">
          <ProgressSummary
            done={answeredCount}
            total={questions.length}
            noun="answered"
            earned={earnedPoints}
            available={availablePoints}
          />
        </div>
      )}
      {questions.map((q) => (
        <QuestionCard
          key={q.id}
          question={q}
          authenticated={authenticated}
          maxAttempts={maxAttempts}
          selected={selections[q.id] ?? []}
          pending={pending[q.id] ?? false}
          feedback={feedback[q.id]}
          onToggle={(choiceId) => toggle(q, choiceId)}
          onSubmit={() => submit(q)}
        />
      ))}
    </div>
  );
}

/** Exported for tests ONLY, following the same rule as `resultLine` and
 *  `submitDisabled` above: the ordering of the outcome line against the
 *  cooldown line (#126) is only observable once `feedback` is set, and
 *  `feedback` is client state this repo cannot drive — there is no
 *  testing-library here, by choice. Rendering the card directly with a
 *  feedback prop is the one way to assert that ordering without adding a
 *  dependency. Not used by anything outside __tests__. */
export function QuestionCard({
  question,
  authenticated,
  maxAttempts,
  selected,
  pending,
  feedback,
  onToggle,
  onSubmit,
}: {
  question: QuizQuestionView;
  authenticated: boolean;
  maxAttempts: number;
  selected: string[];
  pending: boolean;
  feedback?: Feedback;
  onToggle: (choiceId: string) => void;
  onSubmit: () => void;
}) {
  const inputType = question.type === "multi" ? "checkbox" : "radio";
  const inputName = `quiz-${question.id}`;
  const cooldown = useCooldown(question.status === "cooldown" ? question.retryAt : undefined);
  // Once the countdown reaches zero the form re-opens without a refresh. Safe
  // to do optimistically: the grading script re-checks the cooldown inside the
  // same atomic EVAL that records the attempt, so an early click is refused
  // server-side rather than granted.
  const cooledDown = cooldown.mounted && cooldown.remaining === null;
  // Choices stay visible in every state (including cooldown) so a contestant
  // can review the question; they're just non-interactive once the state
  // isn't "unanswered".
  const showChoices = question.status === "unanswered" || question.status === "cooldown";
  const choicesDisabled = question.status === "cooldown" && !cooledDown;
  const result = resultLine(question, feedback);
  // Only while the budget still means something. A question already answered
  // correctly is done, and its remaining attempts are not a fact the
  // contestant has any use for.
  const attemptsLeft = question.status === "answered" ? null : describeAttempts(question.attemptsUsed, maxAttempts);

  return (
    <div className="ds-card rounded-lg border border-white/[0.06] bg-[#16162a] p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-white">{question.prompt}</p>
        <div className="flex flex-none items-center gap-1.5">
          {attemptsLeft && (
            <span className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
              {attemptsLeft}
            </span>
          )}
          <span className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
            {question.points} pts
          </span>
        </div>
      </div>

      {/* OUTCOME AND ITS CONSEQUENCE, TOGETHER AND ABOVE THE FORM.
          These two lines describe the same submission and used to render at
          opposite ends of the card, with the whole form between them — the
          cooldown up here, the result after the submit button. A contestant
          then met the consequence before the cause: a cooldown with no
          explanation, whose reason sat four elements further down past a form
          they could no longer use.

          Reading order is now what happened → what it means → what to do.
          They are separate <p>s rather than one string because the countdown
          re-renders every second while the result text is frozen, and because
          the pre-mount branch below exists to avoid a hydration mismatch (see
          `useCooldown`). */}
      {(result || question.status === "cooldown") && (
        <div className="mt-3 flex flex-col gap-1">
          {result && (
            <p
              role="status"
              className={`text-sm ${
                result.kind === "success"
                  ? "text-[#22c55e]"
                  : result.kind === "error"
                    ? "text-[#e53e3e]"
                    : "text-zinc-400"
              }`}
            >
              {result.text}
            </p>
          )}
          {question.status === "cooldown" && (
            <p className={`text-sm ${cooledDown ? "text-[#22c55e]" : "text-[#d4a017]"}`}>
              {!cooldown.mounted
                ? // Server render and the client's first paint. No clock is read
                  // here: a live Date.now() during render disagrees with the
                  // server's and trips a hydration mismatch.
                  "On cooldown — you can try again shortly."
                : cooldown.remaining
                  ? `On cooldown — you can try again in ${formatCompact(cooldown.remaining)}.`
                  : "Cooldown's over — you can try again now."}
            </p>
          )}
        </div>
      )}

      {showChoices && (
        <fieldset disabled={choicesDisabled} className="mt-3 flex flex-col gap-2">
          <legend className="sr-only">{question.prompt}</legend>
          {question.choices.map((choice) => (
            <label key={choice.id} className="flex items-center gap-2 text-sm text-zinc-300">
              <input
                type={inputType}
                name={inputName}
                value={choice.id}
                checked={selected.includes(choice.id)}
                disabled={choicesDisabled}
                onChange={() => onToggle(choice.id)}
                className="h-4 w-4 flex-none accent-[#2563eb]"
              />
              {choice.label}
            </label>
          ))}
        </fieldset>
      )}

      {question.status === "unanswered" &&
        (authenticated ? (
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitDisabled({ onCooldown: false, cooledDown, pending, selectedCount: selected.length })}
            className="mt-3 rounded-md bg-[#2563eb] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#1d4ed8] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
          >
            {pending ? "Submitting…" : "Submit answer"}
          </button>
        ) : null)}

      {/* The cooldown's own submit control. It used to be hardcoded
          `disabled`, while `choicesDisabled` released the radios the moment
          the countdown hit zero — so a contestant whose card said "Cooldown's
          over — you can try again now." got live choices above a button that
          could never be pressed again without a manual reload. It now tracks
          the same `cooledDown` flag the choices do (challenge-detail.tsx routes
          both through one `inputLocked` for exactly this reason). Releasing
          it optimistically is safe: GRADE_SCRIPT re-checks the cooldown
          inside the same atomic EVAL that records the attempt, so an early
          click is refused server-side rather than granted. */}
      {question.status === "cooldown" &&
        (authenticated ? (
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitDisabled({ onCooldown: true, cooledDown, pending, selectedCount: selected.length })}
            className="mt-3 rounded-md bg-[#2563eb] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#1d4ed8] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
          >
            {pending ? "Submitting…" : "Submit answer"}
          </button>
        ) : null)}

    </div>
  );
}
