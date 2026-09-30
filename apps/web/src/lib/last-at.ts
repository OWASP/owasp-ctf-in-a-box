import { errorLabel } from "@/lib/error-label";

/** Reads one `ctf:<module>:lastAt` HGETALL reply (#522): login -> ISO time of
 *  that login's latest award, written by the module's grading script. It is
 *  the leaderboard's "whoever got there first" tiebreak and nothing else.
 *
 *  Fails OPEN, and says so: a failed read logs by label and returns no times,
 *  so every row keeps its points and only the tiebreak degrades (to the
 *  caller's stable order). Throwing here would take the module's points down
 *  over a value that only orders equal scores. A value that is not a
 *  parseable time is dropped, not guessed at. */
export function readLastAt(reply: { result?: unknown; error?: unknown }, module: string): Map<string, string> {
  const out = new Map<string, string>();
  if (reply.error !== undefined && reply.error !== null) {
    console.error(`${module} lastAt read failed:`, errorLabel(new Error(String(reply.error))));
    return out;
  }
  const flat = Array.isArray(reply.result) ? (reply.result as unknown[]) : [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const login = flat[i];
    const at = flat[i + 1];
    if (typeof login === "string" && typeof at === "string" && Number.isFinite(Date.parse(at))) out.set(login, at);
  }
  return out;
}
