import "server-only";
import { randomBytes } from "node:crypto";

import { AI_PROGRESS_MAX, AI_TOKEN_TTL_SEC } from "@/lib/ai-defaults";
import { renderLaunchUrl } from "@/lib/ai-keys";
import { getAiLaunchKeys, type AiChallenge, type ViewerAi } from "@/lib/ai-store";
import { signLaunchToken, type AiTokenClaims, type AiTokenProgress } from "@/lib/ai-token";

/**
 * The ONE place a launch token is minted.
 *
 * The gate-at-mint contract lives here by construction: the only caller is the
 * `/ai/[id]` Server Component, which runs behind a session, the team redirect,
 * and its OWN explicit `redirectIfNotLaunched()` call (#464) — so a token cannot exist
 * unless all three said yes, and `AI_TOKEN_TTL_SEC` is the window that
 * decision stays honoured. The API routes never re-check those gates; this is
 * why. See spec §6.
 *
 * The launch check is the page's own line; the proxy guards no module pages.
 * `/ai/[id]/page.tsx` and `/ai/[id]/actions.ts` are the two enforcement
 * points, and each carries its own call.
 *
 * The jti MUST satisfy `AI_JTI_RE` (the event route's replay guard refuses
 * anything else). `randomBytes(16).toString("base64url")` is 22 chars of the
 * exact charset — the test pins the agreement so the two can never drift.
 */
export type LaunchClaimInputs = {
  origin: string;
  login: string;
  challenge: AiChallenge;
  challenges: readonly AiChallenge[];
  viewer: ViewerAi;
  nowSec?: number;
  /** An admin preview mint (#464) — sets `ctf.preview`. */
  preview?: boolean;
};

/** Pure claim shaping, split out so tests reach it without touching crypto or
 *  the store. Field by field from public records — nothing secret can ride. */
export function buildLaunchClaims(inputs: LaunchClaimInputs): AiTokenClaims {
  const nowSec = inputs.nowSec ?? Math.floor(Date.now() / 1000);

  const rows: AiTokenProgress[] = inputs.challenges.map((c) => {
    const solve = inputs.viewer.solved[c.id];
    return { id: c.id, points: c.points, solved: Boolean(solve), solvedAt: solve?.at ?? null };
  });

  // Cap for URL sanity: solved rows first (they are what an external side
  // gates stages on), then board order, then trim.
  let progress = rows;
  let truncated = false;
  if (rows.length > AI_PROGRESS_MAX) {
    progress = [...rows].sort((a, b) => Number(b.solved) - Number(a.solved)).slice(0, AI_PROGRESS_MAX);
    truncated = true;
  }

  const points = Object.values(inputs.viewer.solved).reduce((sum, s) => sum + s.points, 0);

  return {
    iss: inputs.origin,
    sub: inputs.login,
    aud: inputs.challenge.id,
    iat: nowSec,
    exp: nowSec + AI_TOKEN_TTL_SEC,
    jti: randomBytes(16).toString("base64url"),
    ctf: {
      module: "ai",
      challenge: {
        id: inputs.challenge.id,
        title: inputs.challenge.title,
        points: inputs.challenge.points,
      },
      points,
      progress,
      ...(truncated ? { truncated: true as const } : {}),
      ...(inputs.preview ? { preview: true as const } : {}),
    },
  };
}

/** Mints the personal launch URL for one challenge page render. Fresh token
 *  every call — reopening the page is how a stale link fixes itself. */
export async function mintLaunchUrl(inputs: LaunchClaimInputs): Promise<string> {
  const { privateKey } = await getAiLaunchKeys();
  const token = signLaunchToken(buildLaunchClaims(inputs), privateKey);
  return renderLaunchUrl(inputs.challenge.urlTemplate, token);
}
