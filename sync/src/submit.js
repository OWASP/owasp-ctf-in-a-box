/**
 * POST one score to the scorer. Resolves to the scorer's verdict:
 *   - `accepted`: written (2xx).
 *   - `refused`: a FINAL verdict (422) on when the score was posted (during a
 *     freeze, outside the scoring window, or before the last master reset)
 *     or on who posted it (`player-deleted`: the account is gone). The rule
 *     did its job; `reason` is the scorer's `refused` code.
 *   - `rejected`: any other 4xx, a score that will never be written without
 *     a human.
 * Anything else throws, and the caller re-presents the comment next tick.
 */
// Above the scorer's own 35 s drain cap (createDrain in scorer/src/serve.js),
// so a slow write is not abandoned while the scorer is still finishing it. A
// timeout throws like any network failure: the comment is re-presented, and a
// write that landed anyway keeps its earliest time.
export const SUBMIT_TIMEOUT_MS = 40_000;

export async function submitScore(cfg, payload, fetchImpl = fetch) {
  const res = await fetchImpl(`${cfg.scorerUrl}/score`, {
    method: "POST",
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    headers: {
      authorization: `Bearer ${cfg.scorerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (res.ok) return { outcome: "accepted" };
  if (res.status === 422) {
    let reason = "unknown";
    try {
      const body = await res.json();
      if (typeof body?.refused === "string" && body.refused !== "") reason = body.refused.slice(0, 40);
    } catch {
      // An unreadable body is still the final verdict the status says it is.
    }
    return { outcome: "refused", reason };
  }
  if (res.status >= 400 && res.status < 500) return { outcome: "rejected" };
  throw new Error(`scorer ${res.status}`);
}
