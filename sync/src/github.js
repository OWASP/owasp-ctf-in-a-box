/**
 * Poll one repo's issue comments (PR result comments are issue comments).
 * One request per repo per tick; `since` + ETag keep it far under GitHub's rate limits.
 */
// One poll request. Bounded so a stalled GitHub cannot hold a tick, and so a
// SIGTERM's drain (main() in sync/src/index.js) fits its stop grace period.
export const GITHUB_TIMEOUT_MS = 15_000;

export async function fetchNewScoreComments(cfg, repo, cursor, fetchImpl = fetch) {
  const url = new URL(`${cfg.apiUrl}/repos/${cfg.org}/${repo}/issues/comments`);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "asc");
  if (cursor.since) url.searchParams.set("since", cursor.since);

  const token = await cfg.getToken(fetchImpl);
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (cursor.etag) headers["if-none-match"] = cursor.etag;

  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
  if (res.status === 304) return { comments: [], cursor };
  if (!res.ok) throw new Error(`GitHub ${res.status} polling ${repo}`);

  const all = await res.json();
  return {
    comments: all.filter((c) => c.user?.login === cfg.commentAuthor),
    cursor: {
      since: all.at(-1)?.updated_at ?? cursor.since,
      etag: res.headers.get("etag") ?? cursor.etag,
    },
  };
}
