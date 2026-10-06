"use client";

// One challenge's interactive surface — the flag input, grading feedback and
// cooldown countdown — extracted from the old all-in-one board (issue #208)
// so it can live on the challenge's own page (/flags/[id], /ai/[id]).
//
// Shared by BOTH flag-graded modules, which differ only in how a submission
// leaves the browser (`dispatchSubmit` below is the whole of that difference):
// classic POSTs to /api/classic/submit, and ai calls a Server Action defined
// beside its page. Either way the server it reaches is the sole authority on
// grading, the already-solved guard and the cooldown (see classic-store.ts /
// ai-store.ts). This component never sees — and cannot render — a flag:
// `ChallengeView` has no field that could carry one.

import AttachmentList, { type AttachmentView } from "@/components/attachment-list";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Markdown from "@/components/markdown";
import { formatCompact, getRemaining, type Remaining } from "@/lib/countdown";

/** Per-challenge progress, mutually exclusive. Every branch carries only
 *  public-safe data — never a flag, in either form. */
export type ChallengeStatus =
  | { status: "unsolved" }
  | { status: "solved"; earnedPoints: number }
  | { status: "cooldown"; retryAt: string };

/** Old name, kept importable for classic's existing call sites and tests —
 *  see challenge-board.tsx's re-export note. */
export type ClassicStatus = ChallengeStatus;

/** What a challenge surface needs to render one challenge — deliberately just
 *  the public `Challenge` fields, this challenge's solve count, and this
 *  viewer's derived status. Built by the server pages from `listChallenges()`
 *  + `getViewerClassic()` + `getSolveCounts()`, field by field — never from a
 *  spread of a raw store record, which is how a flag would leak. */
export type ChallengeView = {
  id: string;
  title: string;
  category: string;
  description: string;
  points: number;
  solveCount: number;
  /** Compared with capitalisation intact (issue #193). Public deliberately —
   *  see the badge below. Optional so every existing caller is unchanged. */
  caseSensitive?: boolean;
  /** Files and links (#186), classic only today. Optional so every other
   *  caller is unchanged; absent or empty renders nothing extra. */
  attachments?: readonly AttachmentView[];
} & ChallengeStatus;

/** Old name, kept importable for classic's existing call sites and tests —
 *  see challenge-board.tsx's re-export note. */
export type ClassicChallengeView = ChallengeView;

/** The wire shape a submission comes back as, whichever transport carried it.
 *  Exported so the ai module's Server Action can be typed against exactly what
 *  this component knows how to render — the two cannot drift into disagreeing
 *  about a field. Nothing here can carry a flag, a token or a key. */
export type SubmitResponse =
  | { correct: true; points: number; already?: boolean; dryRun?: boolean }
  | { correct: false; dryRun?: boolean }
  | { error: string; retryAt?: string };

/** The ai module's transport: a Server Action bound to the challenge id,
 *  taking the typed flag and returning the same shape the fetch path parses. */
export type SubmitAction = (flag: string) => Promise<SubmitResponse>;

/** WHERE a submission goes, as a union so each module passes exactly one and
 *  neither can pass both. Classic's call sites are unchanged by construction:
 *  `submitPath` alone still type-checks. */
export type SubmitTarget =
  | { submitPath: string; submitAction?: never }
  | { submitPath?: never; submitAction: SubmitAction };

/** The ONE place the two transports differ. Everything downstream — the
 *  feedback precedence, the refusal copy, the `router.refresh()` — is a single
 *  code path over this result, so a module cannot end up with its own quietly
 *  different rendering of the same outcome.
 *
 *  `ok` is what the fetch path reads off the response status. An action has no
 *  status, so its refusals are identified by the `error` key they carry —
 *  which is the same discriminator the caller falls back on anyway.
 *
 *  Exported for direct testing: this repo has no testing-library, so a
 *  component's click handler cannot be driven, and the pin that matters here
 *  ("with an action in hand, nothing is ever fetched") is only observable on
 *  this function. */
export async function dispatchSubmit(
  challengeId: string,
  flag: string,
  target: SubmitTarget,
): Promise<{ ok: boolean; data: SubmitResponse }> {
  if (target.submitAction) {
    const data = await target.submitAction(flag);
    return { ok: !("error" in data), data };
  }
  const res = await fetch(target.submitPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challengeId, flag }),
  });
  const data = (await res.json().catch(() => ({}))) as SubmitResponse;
  return { ok: res.ok, data };
}

export type Feedback = { kind: "success" | "error" | "info"; text: string };

/** Feedback for an accepted (correct) submission. The `already` branch is NOT
 *  cosmetic — mirrors `describeCorrect` in quiz-board.tsx: `/api/classic/
 *  submit` reports an idempotent re-submission of a flag this login had
 *  already banked as `correct: true, points: 0`, and rendering that through
 *  the normal template would announce "Correct — +0 points." — the opposite
 *  of the truth. Exported for direct testing. */
export function describeCorrect(points: number, already?: boolean, dryRun?: boolean): string {
  // An admin preview (#464): graded by the same script, nothing recorded.
  if (dryRun) return `Correct — preview only, nothing was recorded (+${points} once the event launches).`;
  if (already) return "You already solved this one — those points are already yours.";
  return `Correct — +${points} point${points === 1 ? "" : "s"}.`;
}

/** The wrong-answer line; an admin preview (#464) says nothing was recorded.
 *  Exported for direct testing. */
export function describeIncorrect(dryRun?: boolean): string {
  return dryRun ? "Not quite — preview only, nothing was recorded." : "Not quite.";
}

/** The ONE result line a challenge card prints, and the precedence between the
 *  two things that used to print their own.
 *
 *  A solved challenge carries a durable "Solved — earned 50 points." from its
 *  server-derived status, and a just-submitted flag sets a transient "Correct
 *  — +50 points." feedback. Both were rendered, stacked, so a contestant read
 *  the same points twice and reasonably wondered whether they had been scored
 *  twice. Fresh feedback wins: it is the more specific statement of the same
 *  fact, and it is the only thing that can say "you already had these points"
 *  or why a submission was refused. On the next page load the feedback is gone
 *  and the durable line says it instead. */
export function resultLine(challenge: ChallengeView, feedback: Feedback | undefined): Feedback | null {
  if (feedback) return feedback;
  if (challenge.status === "solved") {
    const p = challenge.earnedPoints;
    return { kind: "success", text: `Solved — earned ${p} point${p === 1 ? "" : "s"}.` };
  }
  return null;
}

/** One sentence per refusal slug either module's server half can return.
 *  Exported for direct testing — the slug vocabulary is shared across two
 *  modules and a reason that quietly starts hitting the generic fallback is
 *  invisible in a static render. */
export function describeRefusal(reason: string): string {
  switch (reason) {
    case "paused":
      return "Scoring is paused right now. Try again later.";
    case "ended":
      // #567: the scheduled end has passed. Final — no "try again", which
      // is the pause's promise and false once the event is over.
      return "Scoring has closed — the event has ended.";
    case "solved":
      return "You already solved this one.";
    case "cooldown":
      // Deliberately no instant here. The challenge's own cooldown line runs
      // a live countdown; a second, frozen copy of the same deadline in the
      // feedback area would be stale the moment it rendered.
      return "On cooldown right now — the timer above shows when you can retry.";
    case "unavailable":
      return "Couldn't verify that right now. Try again in a moment.";
    case "no-team":
      // Names the fix, not the rule. Someone who reaches this has already
      // submitted a flag and is being told it didn't count; "you need a team"
      // without saying where to get one is a dead end.
      return "You need a team before solves count — create one on your profile, or hit Play solo there for a team of one.";
    case "locked":
      // #463: a story step whose previous step the team hasn't solved yet.
      return "This step is still locked — solve the previous step in the story first.";
    case "not-launched":
      // #464: reachable from a tab loaded before an un-launch — the page
      // itself redirects before launch, but an open tab can still submit.
      return "The event hasn't launched yet — nothing counts until it starts.";
    case "unauthorized":
      // Reachable, unlike `gate` below: a session can expire while this page
      // stays open. The form was rendered for a signed-in viewer, so by the
      // time a submit comes back with this, the fix is to sign in again, not
      // to reload — the generic fallback used to say neither.
      return "Your session expired — sign in and try again.";
    // The rest are never emitted by classic's own route. `wrong-mode`,
    // `invalid` and `error` are `AiSubmitResult` reasons the ai module's
    // Server Action passes straight through (ai/[id]/actions.ts, mapping them
    // exactly as `aiAwardResponse` does).
    case "wrong-mode":
      return "This challenge doesn't take typed flags — solve it on the challenge site and it reports back.";
    case "invalid":
      return "That submission didn't look right — reload the page and try again.";
    case "error":
      return "Grading didn't complete. Try again in a moment.";
    // `rate-limited`, `invalid-token` and `expired` come from /api/ai/submit,
    // which is the EXTERNAL surface (spec §6.1's 2026-09-02 amendment) — this
    // form never calls it, so nothing here reaches this caller today. Kept
    // because the copy is right if a future in-box path ever does relay them,
    // and because deleting a branch is how a slug quietly starts falling
    // through to the generic line below.
    case "rate-limited":
      return "Too many tries too fast — give it a few seconds.";
    case "invalid-token":
    case "expired":
      return "This page's session token expired — reload the page and try again.";
    // Everything else, including the action's `gate` refusal (unreachable
    // from a rendered form: the page redirects an ungated visitor before it
    // can render one — unlike `unauthorized` above, nothing re-opens the gate
    // for an already-loaded tab) and classic's prose-style route errors.
    default:
      return "That submission wasn't accepted.";
  }
}

/** Ticks a challenge's cooldown once a second. Identical shape to
 *  `quiz-board.tsx`'s `useCooldown` — see its comment for why `mounted` stays
 *  false through the server render AND the client's first paint (so both
 *  produce identical markup and hydration can't mismatch), and why parking
 *  (no `retryAt`) still calls the hook unconditionally. */
function useCooldown(retryAt: string | undefined): { mounted: boolean; remaining: Remaining | null } {
  const [state, setState] = useState<{ mounted: boolean; remaining: Remaining | null }>({
    mounted: false,
    remaining: null,
  });

  useEffect(() => {
    if (!retryAt) return;
    const targetMs = new Date(retryAt).getTime();
    const tick = () => setState({ mounted: true, remaining: getRemaining(targetMs) });
    const timeout = setTimeout(tick, 0);
    const interval = setInterval(tick, 1000);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [retryAt]);

  return state;
}

/** The challenge page's interactive body: owns this ONE challenge's input,
 *  pending and feedback state, and re-syncs status from the server after
 *  every submission (`router.refresh()` — this component never decides
 *  solved/cooldown for itself). */
export default function ChallengeDetail(
  props: {
    challenge: ChallengeView;
    authenticated: boolean;
  } & SubmitTarget,
) {
  const { challenge, authenticated } = props;
  const router = useRouter();
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | undefined>(undefined);

  async function submit() {
    const flag = value.trim();
    if (!flag || pending) return;

    setPending(true);
    setFeedback(undefined);
    try {
      const { ok, data } = await dispatchSubmit(challenge.id, flag, props);
      if (ok && "correct" in data) {
        setFeedback(
          data.correct
            ? { kind: "success", text: describeCorrect(data.points, data.already, data.dryRun) }
            : // No "Try again." — same reasoning as quiz-board.tsx: a wrong
              // flag starts the classic cooldown, and the card's own countdown
              // is what says when the form re-opens.
              { kind: "error", text: describeIncorrect(data.dryRun) },
        );
      } else if ("error" in data && typeof data.error === "string") {
        setFeedback({ kind: "info", text: describeRefusal(data.error) });
      } else {
        setFeedback({ kind: "error", text: "Something went wrong. Try again." });
      }
    } catch {
      setFeedback({ kind: "error", text: "Something went wrong. Try again." });
    } finally {
      setPending(false);
      router.refresh();
    }
  }

  return (
    <ChallengeCard
      challenge={challenge}
      authenticated={authenticated}
      value={value}
      pending={pending}
      feedback={feedback}
      onChange={setValue}
      onSubmit={submit}
    />
  );
}

/** Exported (in addition to `ChallengeDetail`) purely so tests can drive
 *  `feedback` directly: the ordering of the outcome line against the cooldown
 *  line (#126) is only observable once `feedback` is set, and `feedback` is
 *  client state this repo cannot drive — there is no testing-library here, by
 *  choice. Not used by anything outside this file and __tests__. */
export function ChallengeCard({
  challenge,
  authenticated,
  value,
  pending,
  feedback,
  onChange,
  onSubmit,
}: {
  challenge: ChallengeView;
  authenticated: boolean;
  value: string;
  pending: boolean;
  feedback?: Feedback;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const cooldown = useCooldown(challenge.status === "cooldown" ? challenge.retryAt : undefined);
  // Once the countdown reaches zero the form re-opens without a refresh. Safe
  // to do optimistically: the grading script re-checks the cooldown inside
  // the same atomic EVAL that records the attempt, so an early click is
  // refused server-side rather than granted.
  const cooledDown = cooldown.mounted && cooldown.remaining === null;
  const inputLocked = pending || (challenge.status === "cooldown" && !cooledDown);
  const result = resultLine(challenge, feedback);

  return (
    <div className="ds-card rounded-lg border border-white/[0.06] bg-[#16162a] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-white">{challenge.title}</p>
          <p className="mt-0.5 text-xs text-muted">
            {challenge.solveCount} solve{challenge.solveCount === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex flex-none items-center gap-1.5">
          {/* Case sensitivity is PUBLIC (issue #193). Without it a contestant
              submits the right characters, reads "Not quite", and has no way
              to work out why — the one failure the board can explain for free.
              It gives away nothing about the answer itself. */}
          {challenge.caseSensitive && (
            <span
              title="This flag is compared with capitalisation intact."
              className="rounded border border-amber-400/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300/90"
            >
              case-sensitive
            </span>
          )}
          <span className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
            {challenge.points} pts
          </span>
        </div>
      </div>

      <Markdown source={challenge.description} />
      {challenge.attachments && <AttachmentList items={challenge.attachments} />}

      {/* OUTCOME AND ITS CONSEQUENCE, TOGETHER AND ABOVE THE FORM. Mirrors
          quiz-board.tsx exactly — the two boards mirror each other
          deliberately, so a fix to one that skipped the other would be the
          regression. Both lines describe the same submission and used to
          render at opposite ends of the card with the form between them,
          putting the consequence before the cause. */}
      {(result || challenge.status === "cooldown") && (
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
          {challenge.status === "cooldown" && (
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

      {challenge.status !== "solved" &&
        (authenticated ? (
          // A real <form>, so Enter in the input submits — a contestant who
          // types a flag and hits Enter should not be met with silence
          // (CodeRabbit on #209). preventDefault keeps it a fetch, not a
          // navigation; the disabled guards below still apply because the
          // submit handler is the same one the button calls.
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            <input
              type="text"
              value={value}
              disabled={inputLocked}
              onChange={(e) => onChange(e.target.value)}
              placeholder="CTF{...}"
              className="flex-1 rounded-md border border-white/10 bg-[#12121e] px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
            />
            <button
              type="submit"
              disabled={inputLocked || value.trim().length === 0}
              className="flex-none rounded-md bg-[#2563eb] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#1d4ed8] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
            >
              {pending ? "Submitting…" : "Submit flag"}
            </button>
          </form>
        ) : (
          <p className="mt-3 text-xs text-muted">Sign in with GitHub to submit a flag.</p>
        ))}
    </div>
  );
}
