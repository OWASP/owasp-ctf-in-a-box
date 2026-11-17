/** The scorer's own solve script (scorer/src/store.js), run against the live
 *  Redis with the keys and args the scorer's recordSolves hands it. `at` is
 *  the ISO solve time; `judgedResetAt` is the settings' `resetAt` the score
 *  was judged against ("" when none). */
export async function scorerSolveWrite(
  target: string,
  id: string,
  at: string,
  challenge: string,
  login = "",
  judgedResetAt = "",
): Promise<unknown> {
  const storeUrl = new URL("../../../../../scorer/src/store.js", import.meta.url).href;
  const { RECORD_SOLVES_SCRIPT } = (await import(/* @vite-ignore */ storeUrl)) as { RECORD_SOLVES_SCRIPT: string };
  const { upstashEval } = await import("@/lib/upstash");
  const lower = login.toLowerCase();
  return upstashEval(
    RECORD_SOLVES_SCRIPT,
    [`ctf:solves:${target}`, `ctf:score-hold:${id}`, "ctf:auth:user", `ctf:link:github:${lower}`, "ctf:admin:settings"],
    [id, at, lower, String(Date.parse(at)), judgedResetAt, challenge],
  );
}
