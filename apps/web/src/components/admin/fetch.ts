// The JSON transport the module admin panels (admin-quiz-controls,
// admin-classic-controls, admin-ai-controls) share for every write to
// `/api/admin/<module>`. Each panel used to carry its own copy of the three
// things here — a lenient body parser, the 400-vs-503 message mapping, and
// the try/fetch/catch around a POST or DELETE — and the copies were identical
// down to the sentence a network failure produces. One implementation, so a
// change to how an organizer is told about a failed write happens once.
//
// Client-safe: plain functions over the global `fetch`, no store import.

/** The sentence every module panel shows when the request never got an
 *  answer — a network failure, not a server refusal. */
export const NETWORK_ERROR = "Couldn't reach the server — try again.";

/** Reads a JSON body, resolving to `{}` for a body that is not JSON (a
 *  gateway's HTML error page, an empty 204) rather than throwing — the
 *  caller then reads `data.error` as absent and falls back to its own
 *  sentence. */
export async function parseJson<T>(res: Response): Promise<T> {
  return (await res.json().catch(() => ({}))) as T;
}

/** Maps a `/api/admin/<module>` reply to a message that tells a validation
 *  failure (the organizer's payload was bad — 400) apart from an
 *  infrastructure failure (the store itself is unavailable — 503), so an
 *  organizer is never told "bad request" for a problem that was never theirs
 *  to fix. `fallback` is the module's own sentence for a reply that carries
 *  no message ("…check the question…" / "…check the challenge…"). */
export function describeAdminError(status: number, message: string | undefined, fallback: string): string {
  if (status === 503) {
    return message ? `Store unavailable — ${message}` : "Store unavailable — try again shortly.";
  }
  return message ?? fallback;
}

/** A module's bound error mapper — `describeAdminError` with its fallback
 *  already applied. What the module panels export as `describeXError`. */
export type DescribeError = (status: number, message?: string) => string;

type SendResult<T> = { ok: true; status: number; data: T } | { ok: false; message: string };

/** One JSON request with the headers every module write uses. A non-2xx
 *  reply is resolved to the described message; a network failure to
 *  `NETWORK_ERROR`. A 2xx reply is returned WITH its status and parsed body,
 *  because the callers still check a payload field (`data.challenge`,
 *  `data.categories`) and describe its absence through the same mapper with
 *  the same status. Never throws. */
export async function sendJson<T>(
  endpoint: string,
  init: { method: "POST" | "DELETE"; body: unknown },
  describe: DescribeError,
): Promise<SendResult<T>> {
  try {
    const res = await fetch(endpoint, {
      method: init.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(init.body),
    });
    const data = await parseJson<T & { error?: string }>(res);
    if (!res.ok) return { ok: false, message: describe(res.status, data.error) };
    return { ok: true, status: res.status, data };
  } catch {
    return { ok: false, message: NETWORK_ERROR };
  }
}
