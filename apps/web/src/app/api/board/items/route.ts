import { NextResponse } from "next/server";
import { LOGIN_RE } from "@/lib/admin-admins";
import { getViewerAi, listAiChallenges } from "@/lib/ai-store";
import { getViewerClassic, listChallenges, listStories } from "@/lib/classic-store";
import { isLocked, lockedLabel, storyPositions } from "@/lib/story-lock";
import { auth } from "@/lib/auth";
import { isModuleLive } from "@/lib/enabled-modules";
import { requireLaunchedApi } from "@/lib/launch";
import { getViewerQuiz, listQuestions } from "@/lib/quiz-store";

/** How many logins one request may union — a team's roster, not a scrape. */
const MAX_LOGINS = 8;

type Item = { id: string; label: string; points: number; done: boolean; earnedPoints?: number };

/**
 * Per-item quiz/classic/ai completion for a login (an expanded leaderboard
 * row) or a roster (an expanded team row, whose completion is the members'
 * union — the same union the team's banked points already reflect).
 *
 * Public and read-only, like the leaderboard it serves: WHO has solved WHAT
 * is already on the board as counts, and every label here (a question's
 * prompt, a challenge's title) is on a public page. What must never leave
 * this route is grading material — items are built field by field from the
 * public records, and the viewer maps carry only ids and banked points. The
 * ai arm reads through `listAiChallenges` (the contestant-safe lister) and
 * `getViewerAi` — never `listAiChallengesForAdmin`, which is the only ai
 * reader that carries flags, hints and signing keys.
 */
export async function GET(request: Request) {
  // #464 pre-launch lock: this returns challenge titles and points, which is
  // module content. The session is optional here (the board is public once
  // launched); it is read only so an admin's preview board still loads.
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  const notLaunched = await requireLaunchedApi((session?.user as { login?: string } | undefined)?.login);
  if (notLaunched) return notLaunched;

  const raw = new URL(request.url).searchParams.get("logins") ?? "";
  const logins = raw.split(",").map((l) => l.trim()).filter(Boolean);
  if (logins.length === 0 || logins.length > MAX_LOGINS || !logins.every((l) => LOGIN_RE.test(l))) {
    return NextResponse.json({ error: "bad logins" }, { status: 400 });
  }

  const [quizLive, classicLive, aiLive] = await Promise.all([
    isModuleLive("quiz"),
    isModuleLive("classic"),
    isModuleLive("ai"),
  ]);

  let quiz: Item[] | null = null;
  if (quizLive) {
    const [questions, viewers] = await Promise.all([
      listQuestions(),
      Promise.all(logins.map((l) => getViewerQuiz(l))),
    ]);
    quiz = questions.map((q) => {
      const hit = viewers.map((v) => v.answered[q.id]).find(Boolean);
      return { id: q.id, label: q.prompt, points: q.points, done: Boolean(hit), earnedPoints: hit?.points };
    });
  }

  let classic: Item[] | null = null;
  if (classicLive) {
    const [challenges, viewers, stories] = await Promise.all([
      listChallenges(),
      Promise.all(logins.map((l) => getViewerClassic(l))),
      listStories(),
    ]);
    // #463: a story step these logins (the team) have not unlocked is
    // redacted to its position alone — label, points AND id, since an id is
    // derived from the title.
    const positions = storyPositions(stories);
    const teamSolved = new Set(viewers.flatMap((v) => Object.keys(v.solved)));
    classic = challenges.map((c) => {
      const pos = positions.get(c.id);
      if (pos && isLocked(pos, teamSolved)) {
        return { id: `locked:${pos.storyId}:${pos.position}`, label: lockedLabel(pos), points: 0, done: false };
      }
      const hit = viewers.map((v) => v.solved[c.id]).find(Boolean);
      return { id: c.id, label: c.title, points: c.points, done: Boolean(hit), earnedPoints: hit?.points };
    });
  }

  let ai: Item[] | null = null;
  if (aiLive) {
    const [challenges, viewers] = await Promise.all([
      listAiChallenges(),
      Promise.all(logins.map((l) => getViewerAi(l))),
    ]);
    ai = challenges.map((c) => {
      const hit = viewers.map((v) => v.solved[c.id]).find(Boolean);
      return { id: c.id, label: c.title, points: c.points, done: Boolean(hit), earnedPoints: hit?.points };
    });
  }

  return NextResponse.json({ quiz, classic, ai });
}
