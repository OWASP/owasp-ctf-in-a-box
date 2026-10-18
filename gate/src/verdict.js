// The verdict rule, pure and free of I/O: given a PR's reviews, its head SHA
// and its author, decide whether CodeRabbit has approved THIS head.
//
// It is deliberately the only place the rule lives. The App-owned check is
// just this decision published as a check run, and the tests pin it directly
// rather than through the HTTP surface, so the rule cannot drift from the
// check that reports it.

const CODERABBIT = "coderabbitai[bot]";
export const DEPENDABOT = "dependabot[bot]";
// A review that only comments is not a verdict. COMMENTED and PENDING are
// dropped before selection: either would otherwise win on a newer timestamp
// and hide an earlier approval.
const VERDICT_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

// The newest verdict review coderabbitai filed, or null if it has filed none.
// GitHub returns reviews oldest-first and submitted_at is ISO-8601 UTC, which
// sorts byte-wise, so the newest is a max by that string — never the first or
// last row as given (a later CHANGES_REQUESTED must beat an earlier APPROVED).
export function latestVerdictReview(reviews) {
  let latest = null;
  for (const r of Array.isArray(reviews) ? reviews : []) {
    const login = String(r?.user?.login ?? "").toLowerCase();
    if (login !== CODERABBIT) continue;
    const state = r?.state;
    if (!VERDICT_STATES.has(state)) continue;
    const row = {
      submittedAt: String(r?.submitted_at ?? ""),
      commitId: String(r?.commit_id ?? ""),
      state,
    };
    if (latest === null || row.submittedAt >= latest.submittedAt) latest = row;
  }
  return latest;
}

// Dependabot PRs are not reviewed by CodeRabbit by design, so no verdict will
// ever arrive. The bypass is an exact match on the author login — not a suffix
// or a case-fold — so a human login that merely contains the string is not
// reached by it.
export function evaluateVerdict({ reviews, headSha, author }) {
  if (author === DEPENDABOT) {
    return { pass: true, reason: "author is dependabot[bot]; CodeRabbit does not review Dependabot PRs" };
  }
  const latest = latestVerdictReview(reviews);
  if (latest === null) {
    return { pass: false, reason: "coderabbitai[bot] has filed no verdict review (APPROVED/CHANGES_REQUESTED/DISMISSED) on this PR" };
  }
  if (latest.state !== "APPROVED") {
    return { pass: false, reason: `coderabbitai's latest verdict review is ${latest.state}, not APPROVED` };
  }
  if (latest.commitId !== headSha) {
    return { pass: false, reason: `coderabbitai approved ${latest.commitId}, not this head (${headSha})` };
  }
  return { pass: true, reason: `coderabbitai's latest verdict review is APPROVED for ${headSha}` };
}
