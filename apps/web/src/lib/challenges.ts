import "server-only";
import { errorLabel } from "@/lib/error-label";
import type { AppId } from "@/lib/apps";
import { owaspCategory, type OwaspCategory } from "@/lib/owasp";

// Live challenge catalogue served by the scorer at
// `${LEADERBOARD_API_URL}/challenges`:
//
//   { challenges: [{ app, id, name, points, owasp }],
//     counts: { "juice-shop": 38, ... }, total: 338 }
//
// `owasp` on the wire is the bare CODE ("A01", "API3") or null — the scorer
// carries rubric data and nothing about how to present it. The label and the
// canonical link are resolved here, from lib/owasp.ts, so OWASP's taxonomy
// lives in one repo rather than two that can drift.
//
// This endpoint went unserved for a long time: the app asked for it, the
// scorer routed only /score, /leaderboard and /healthz, and the 404 was
// swallowed into the static fallback below. The shape above is what the
// scorer actually emits now, not what the retired Lambda backend did.

export type { OwaspCategory };

/** One challenge as the scorer sends it. */
type WireChallenge = {
  app: AppId;
  id: string;
  /** The rubric's human-readable challenge name. */
  name: string;
  points: number;
  /** Bare category code, or null for a challenge the rubric doesn't map. */
  owasp: string | null;
};

export type CatalogChallenge = {
  app: AppId;
  /** Stable catalogue id, e.g. "Challenge-1-Password-Hash-Leak". */
  id: string;
  description: string;
  points: number;
  /** Absent when the rubric carries no category for this challenge — the
   *  badge is then simply not rendered. */
  owasp?: OwaspCategory;
};

export type ChallengeCatalog = {
  byApp: Partial<Record<AppId, CatalogChallenge[]>>;
  total: number;
};

type ChallengesResponse = {
  challenges: WireChallenge[];
  counts: Partial<Record<AppId, number>>;
  total: number;
};

/** The wire shape, resolved into what the UI renders: the rubric's `name`
 *  becomes the displayed `description`, and the bare category code becomes a
 *  code/label/link triple. */
function toCatalogChallenge(c: WireChallenge): CatalogChallenge {
  const owasp = owaspCategory(c.owasp);
  return {
    app: c.app,
    id: c.id,
    description: c.name,
    points: c.points,
    ...(owasp ? { owasp } : {}),
  };
}

/** Groups the flat challenge list by app. Counts and total are re-derived
 *  from the list itself so the page can't disagree with what it renders. */
export function groupCatalog(data: ChallengesResponse): ChallengeCatalog {
  const byApp: ChallengeCatalog["byApp"] = {};
  for (const challenge of data.challenges) {
    (byApp[challenge.app] ??= []).push(toCatalogChallenge(challenge));
  }
  return { byApp, total: data.challenges.length };
}

/** Fetches the live catalogue; returns null (and logs) on any failure so the
 *  challenges page can degrade to its static per-app cards. */
export async function getChallengeCatalog(): Promise<ChallengeCatalog | null> {
  const base = process.env.LEADERBOARD_API_URL;
  if (!base) return null;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/challenges`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as ChallengesResponse;
    if (!Array.isArray(data.challenges) || data.challenges.length === 0) {
      throw new Error("empty or malformed challenge list");
    }
    return groupCatalog(data);
  } catch (err) {
    console.error("Challenge catalogue fetch failed:", errorLabel(err));
    return null;
  }
}
