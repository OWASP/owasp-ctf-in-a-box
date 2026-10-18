const API_VERSION = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };

// The check name is also the required context branch protection carries, and
// the job-id-without-`name:` shape the workflow it replaces used. Keep it
// stable: renaming it silently unrequires the old context.
export const CHECK_NAME = "coderabbit-approved";

// Publish the gate's decision as a check run named `coderabbit-approved` on
// the PR's head SHA. The run is created with the App's installation token, so
// its owning app is the App — which is the identity branch protection must
// require the check from. A run posted by the PR checkout's own workflow (the
// forgeable shape this replaces) is a different app and does not satisfy that
// requirement.
//
// An existing run by this app for this head is UPDATED rather than
// re-created, so a PR accumulates one gate row, not one per push and review.
export async function publishCheck({ apiUrl, token, appId, repo, headSha, pass, reason, fetchImpl = fetch, log = {} }) {
  const conclusion = pass ? "success" : "failure";
  const output = {
    title: pass ? "CodeRabbit approved this head" : "CodeRabbit has not approved this head",
    summary: reason,
  };
  const headers = { ...API_VERSION, authorization: `Bearer ${token}`, "content-type": "application/json" };

  const listUrl = `${apiUrl}/repos/${repo}/commits/${encodeURIComponent(headSha)}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&per_page=100`;
  const listRes = await fetchImpl(listUrl, { headers });
  if (!listRes.ok) throw new Error(`GitHub ${listRes.status} listing check runs for ${headSha}`);
  const list = await listRes.json();
  const mine = (Array.isArray(list?.check_runs) ? list.check_runs : []).filter((c) => String(c?.app?.id) === String(appId));

  const body = JSON.stringify({ name: CHECK_NAME, head_sha: headSha, status: "completed", conclusion, output });
  let res;
  if (mine.length > 0) {
    const id = mine[mine.length - 1].id;
    log.info?.(`gate: updating check ${id} for ${repo}@${headSha} -> ${conclusion}`);
    res = await fetchImpl(`${apiUrl}/repos/${repo}/check-runs/${id}`, { method: "PATCH", headers, body });
  } else {
    log.info?.(`gate: creating check for ${repo}@${headSha} -> ${conclusion}`);
    res = await fetchImpl(`${apiUrl}/repos/${repo}/check-runs`, { method: "POST", headers, body });
  }
  if (!res.ok) throw new Error(`GitHub ${res.status} publishing the ${CHECK_NAME} check for ${headSha}`);
}
