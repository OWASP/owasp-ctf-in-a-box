// Test-only stand-in for the two reads `unlockingSolvedIdsBatch` issues per
// login: an HGETALL of their solves hash, then HMGET team/joinedAt from their
// user record. Replies are keyed on the real key builders, so a renamed key
// fails the test rather than quietly answering an empty reply.
import { classicSolvesKey } from "@/lib/classic-keys";
import { userKey } from "@/lib/team-keys";

export type UnlockMember = {
  /** challenge id -> the solve's `at` stamp. */
  solves?: Record<string, string>;
  team?: string | null;
  joinedAt?: string | null;
};

export const solveRow = (at: string, points = 10) => JSON.stringify({ points, at });

/** A `upstashPipeline` implementation answering only those two reads; any
 *  other command (a captain/join-code HGET, say) gets a null result. */
export function unlockPipeline(members: Record<string, UnlockMember>) {
  return (commands: readonly (readonly unknown[])[]) =>
    Promise.resolve(
      commands.map((command) => {
        const [op, key] = command as [string, string];
        if (op === "HGETALL") {
          const login = Object.keys(members).find((l) => classicSolvesKey(l) === key);
          const solves = login === undefined ? {} : (members[login].solves ?? {});
          return { result: Object.entries(solves).flatMap(([id, at]) => [id, solveRow(at)]) };
        }
        if (op === "HMGET") {
          const login = Object.keys(members).find((l) => userKey(l) === key);
          const member = login === undefined ? undefined : members[login];
          return { result: [member?.team ?? "", member?.joinedAt ?? ""] };
        }
        return { result: null };
      }),
    );
}
