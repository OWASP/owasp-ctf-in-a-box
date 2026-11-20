import { NextResponse } from "next/server";
import { getPlayer } from "@/lib/player";
import { getViewerHints, resolveHintConfig } from "@/lib/hint-store";
import { listChallenges } from "@/lib/classic-store";
import { visibleNow } from "@/lib/classic-release";
import { errorLabel } from "@/lib/error-label";
import { requireLaunchedApi } from "@/lib/launch";

/** The viewer's bought Jeopardy hint texts, minus any for a challenge that is
 *  hidden now: on the contestant side it does not exist, for its buyers too.
 *  The spend is untouched. Fails CLOSED: when the challenges cannot be read,
 *  no Jeopardy text is returned rather than one that might be hidden. */
async function visibleClassicHints(
  texts: Record<string, string>,
  levels: Record<string, Record<number, string>>,
): Promise<{ classic: Record<string, string>; classicLevels: Record<string, Record<number, string>> }> {
  if (Object.keys(texts).length === 0 && Object.keys(levels).length === 0) return { classic: texts, classicLevels: levels };
  try {
    const visible = new Set(visibleNow(await listChallenges()).map((c) => c.id));
    return {
      classic: Object.fromEntries(Object.entries(texts).filter(([id]) => visible.has(id))),
      classicLevels: Object.fromEntries(Object.entries(levels).filter(([id]) => visible.has(id))),
    };
  } catch (err) {
    console.error("hints: challenge read failed, withholding Jeopardy hint text:", errorLabel(err));
    return { classic: {}, classicLevels: {} };
  }
}

/** The signed-in viewer's full hint state (all apps) — lets the challenges
 *  page pre-reveal everything already bought with a single fetch. */
export async function GET(request: Request) {
  const player = await getPlayer(request.headers);
  if (!player) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const playerId = player.id;
  // The pre-launch lock comes before any store read: an admin passes as a
  // preview, everyone else gets the same 403 `not-launched` the other module
  // routes give.
  const refused = await requireLaunchedApi(player.id);
  if (refused) return refused;

  const hints = await getViewerHints(playerId);
  const { enabled, cost } = await resolveHintConfig();
  const visibleClassic = await visibleClassicHints(hints.classic, hints.classicLevels);
  return NextResponse.json({
    enabled,
    cost,
    purchased: hints.purchased,
    classic: visibleClassic.classic,
    classicLevels: visibleClassic.classicLevels,
    spent: hints.spent,
    count: hints.count,
  });
}
