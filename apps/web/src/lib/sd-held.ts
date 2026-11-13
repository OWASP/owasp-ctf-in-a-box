import "server-only";

import { getAdminSettings } from "@/lib/admin-store";
import { linkKey, LINK_AT_KEY, parseLinkAt } from "@/lib/github-link";
import { assertPipelineOk, upstashPipeline } from "@/lib/upstash";

// Secure Development scores sync parked for PR authors with no kit account
// linked yet. Sync writes them (`ctf:sd:held:authors` set of lowercase logins,
// `ctf:sd:held:by:<login>` hash of `<commentId>@<updated_at>` -> JSON); this is
// the admin's read-only view of them.
export const HELD_AUTHORS_KEY = "ctf:sd:held:authors";
export const heldByKey = (login: string) => `ctf:sd:held:by:${login}`;

export type HeldScore = {
  login: string;
  target: string;
  solved: string[];
  pr: number;
  at: string;
  status: "held" | "unclaimed";
};

function parseRow(login: string, raw: string): Omit<HeldScore, "status"> | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at))) return null;
    if (typeof v.target !== "string" || typeof v.pr !== "number") return null;
    const solved = Array.isArray(v.solved) ? v.solved.filter((s): s is string => typeof s === "string") : [];
    return { login, target: v.target, solved, pr: v.pr, at: v.at };
  } catch {
    return null;
  }
}

/** Every held score, oldest comment first. A row sync cannot parse is skipped
 *  here as it is left in place there.
 *
 *  `unclaimed` means no tick will ever release the score: the author linked at
 *  or after the close, or is still unlinked once it has passed. An author who
 *  linked before the close stays `held` after it, because sync still releases
 *  that score on a later tick. It must stay in step with `linkAfterClose` in
 *  sync/src/index.js, the rule that keeps such a score held; a link with no
 *  readable time counts as after the close, as there. */
export async function listHeldScores(nowMs: number = Date.now()): Promise<HeldScore[]> {
  const [{ scoringEndsAt }, [members]] = await Promise.all([
    getAdminSettings(),
    upstashPipeline([["SMEMBERS", HELD_AUTHORS_KEY]]).then((r) => assertPipelineOk(r, "sd held authors")),
  ]);
  const authors = Array.isArray(members.result) ? (members.result as string[]) : [];
  if (authors.length === 0) return [];

  const endMs = typeof scoringEndsAt === "string" && scoringEndsAt !== "" ? Date.parse(scoringEndsAt) : NaN;
  const hasEnd = Number.isFinite(endMs);

  const hashes = assertPipelineOk(
    await upstashPipeline(authors.map((a) => ["HGETALL", heldByKey(a)])),
    "sd held rows",
  );
  const owners = hasEnd
    ? assertPipelineOk(await upstashPipeline(authors.map((a) => ["GET", linkKey(a)])), "sd held links")
    : [];
  const linked = owners.flatMap((r, i) => (typeof r.result === "string" && r.result ? [{ i, player: r.result }] : []));
  const times =
    linked.length > 0
      ? assertPipelineOk(
          await upstashPipeline(linked.map((l) => ["HGET", LINK_AT_KEY, l.player])),
          "sd held link times",
        )
      : [];
  const linkedIdx = new Set(linked.map((l) => l.i));
  const afterClose = new Set<number>();
  linked.forEach((l, k) => {
    const at = parseLinkAt(times[k].result);
    if (at === null || at >= endMs) afterClose.add(l.i);
  });

  const out: HeldScore[] = [];
  authors.forEach((login, i) => {
    const flat = Array.isArray(hashes[i].result) ? (hashes[i].result as string[]) : [];
    const unclaimed = hasEnd && (afterClose.has(i) || (!linkedIdx.has(i) && nowMs >= endMs));
    for (let f = 1; f < flat.length; f += 2) {
      const row = parseRow(login, flat[f]);
      if (row) out.push({ ...row, status: unclaimed ? "unclaimed" : "held" });
    }
  });
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
