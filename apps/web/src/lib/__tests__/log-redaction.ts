// Shared assertions for the secrets-in-logs rule (docs/reviewing.md
// invariant 13, #244, #500): a catch site hands the logger `errorLabel(err)`,
// never the caught value. The shape is the one hint-store.test.ts's
// "hint-store log redaction (#500)" block set, lifted here so every family
// checks it the same way.
import { inspect } from "node:util";
import { expect, type MockInstance } from "vitest";

export const PLANTED_LOG_SECRET = "FLAG{do-not-echo}";

/** An Error the way a driver decorates one: the request it failed on rides
 *  along in `command` and `cause`, which is exactly what a raw
 *  `console.error(err)` would print. */
export function decoratedError(message = "upstash down", secret = PLANTED_LOG_SECRET): Error {
  return Object.assign(new Error(message), {
    command: ["EVAL", "...", secret],
    cause: new Error(`while sending ${secret}`),
  });
}

/** Every argument of every call, strings as-is and anything else rendered
 *  deep (hidden properties included), joined — what a log sink could see. */
export function renderLogged(spy: MockInstance): string {
  return spy.mock.calls
    .map((args) => args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 10, showHidden: true }))).join(" "))
    .join("\n");
}

/** The log line happened (so this cannot pass vacuously), it carries the
 *  label, no raw Error was among its arguments, and the planted value is
 *  nowhere in it. */
export function expectLabelOnly(
  spy: MockInstance,
  { label = "upstash down", secret = PLANTED_LOG_SECRET }: { label?: string; secret?: string } = {},
): void {
  expect(spy).toHaveBeenCalled();
  const errorArgs = spy.mock.calls.flat().filter((a) => a instanceof Error);
  expect(errorArgs).toEqual([]);
  const out = renderLogged(spy);
  expect(out).toContain(label);
  expect(out).not.toContain(secret);
}
