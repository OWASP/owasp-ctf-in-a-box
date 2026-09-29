/**
 * The ONLY thing a store is allowed to hand `console.error` for a caught value.
 *
 * Never the caught value itself. The grading paths call `upstashEval` with the
 * submitted flag or answer — and, for classic, the stored flag's comparison
 * form — as ARGV, so a client or driver that decorates its errors with the
 * request it failed on (an attached `command`, `body` or `cause`, or a
 * serialized argument list) turns one `console.error(err)` into the event's
 * flags in the log. A rejected promise can also be an arbitrary value, not an
 * `Error` at all.
 *
 * So: name and message, both capped, and nothing else. No stack (it is the
 * part most likely to carry interpolated arguments), no own properties, and no
 * `String(err)` on a non-`Error` — a thrown string could BE the flag.
 *
 * Shared by every store, `ai-http` and — as `adminErrorLabel` — the admin
 * routes (#241, #244, #500), so they cannot drift: this is the ONE body, and
 * `error-label.test.ts` fails if a hand-rolled copy appears anywhere else in
 * `src/`. `docs/reviewing.md`'s secrets-in-logs invariant is the rule this
 * implements.
 */
export function errorLabel(err: unknown): string {
  if (!(err instanceof Error)) return "non-Error throw";
  return `${err.name}: ${err.message}`.slice(0, 200);
}
