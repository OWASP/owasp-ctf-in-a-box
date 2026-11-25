const MARKER = /<!--\s*ctf-score:\s*(\{[\s\S]*?\})\s*-->/;
// Same grammar the scorer enforces — author becomes a Redis key segment there.
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/;

/** Whether a comment carries a `ctf-score:` marker AT ALL, regardless of
 *  whether that marker survives validation.
 *
 *  The poller needs the two cases apart. `parseScoreComment` returns null for
 *  both "this is an ordinary bot comment" (the workflow's "⏳ Scoring in
 *  progress…" placeholder, every other Action's comments — routine, expected,
 *  uninteresting) and "this comment claims to carry a score and the claim is
 *  unusable" (a schema drift, a truncated body, a forgery attempt — never
 *  routine). Collapsing them is how the second one stays invisible. */
export function hasScoreMarker(body) {
  return MARKER.test(body ?? "");
}

export function parseScoreComment(body, { targets }) {
  const m = MARKER.exec(body ?? "");
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const { author, target, solved } = data;
  if (typeof author !== "string" || !GITHUB_LOGIN.test(author)) return null;
  if (!targets.includes(target)) return null;
  if (!Array.isArray(solved) || solved.some((s) => typeof s !== "string")) return null;
  return {
    author,
    target,
    solved,
    pr: Number(data.pr ?? 0) || 0,
    sha: typeof data.sha === "string" ? data.sha : "",
    // When the judge produced this verdict; null when absent or unusable (a
    // marker from a scorer image that predates the field).
    judgedAt: typeof data.judgedAt === "string" && Number.isFinite(Date.parse(data.judgedAt)) ? data.judgedAt : null,
  };
}
