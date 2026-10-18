const API_VERSION = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };

// The check name is also the required context branch protection carries, and
// the job-id-without-`name:` shape the workflow it replaces used. Keep it
// stable: renaming it silently unrequires the old context.
export const CHECK_NAME = "coderabbit-approved";

// The App's own run for this head, if one exists. Runs posted by any other
// app — including the PR checkout's own workflow, the forgeable shape this
// service replaces — are filtered out: updating those would hand the PR's own
// code a way to move the gate. The App id is what branch protection requires.
async function ownRun({ apiUrl, token, appId, repo, headSha, fetchImpl }) {
  const headers = { ...API_VERSION, authorization: `Bearer ${token}` };
  const listUrl = `${apiUrl}/repos/${repo}/commits/${encodeURIComponent(headSha)}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&per_page=100`;
  const res = await fetchImpl(listUrl, { headers });
  if (!res.ok) throw new Error(`GitHub ${res.status} listing check runs for ${headSha}`);
  const list = await res.json();
  const mine = (Array.isArray(list?.check_runs) ? list.check_runs : []).filter((c) => String(c?.app?.id) === String(appId));
  return mine.length > 0 ? mine[mine.length - 1].id : null;
}

// One write: update this App's run for the head when there is one, otherwise
// create it. Updating rather than re-creating keeps a PR to one gate row, not
// one per push and review.
async function writeRun({ apiUrl, token, repo, headSha, runId, body, verb, fetchImpl, log }) {
  const headers = { ...API_VERSION, authorization: `Bearer ${token}`, "content-type": "application/json" };
  let res;
  if (runId === null) {
    log.info?.(`gate: creating check for ${repo}@${headSha} -> ${verb}`);
    res = await fetchImpl(`${apiUrl}/repos/${repo}/check-runs`, { method: "POST", headers, body });
  } else {
    log.info?.(`gate: updating check ${runId} for ${repo}@${headSha} -> ${verb}`);
    res = await fetchImpl(`${apiUrl}/repos/${repo}/check-runs/${runId}`, { method: "PATCH", headers, body });
  }
  if (!res.ok) throw new Error(`GitHub ${res.status} publishing the ${CHECK_NAME} check for ${headSha}`);
}

// Claim the head's gate row BEFORE the verdict is read or written. The run
// moves to `in_progress` with no conclusion, so every failure that follows —
// the reviews read, the completion write, the process dying mid-delivery —
// leaves an unfinished check, and an unfinished required check does not
// satisfy branch protection. Without this, a failed write would leave whatever
// an earlier delivery concluded on the same head standing, and GitHub does not
// automatically redeliver failed deliveries to correct it.
export async function claimCheck({ apiUrl, token, appId, repo, headSha, fetchImpl = fetch, log = {} }) {
  const runId = await ownRun({ apiUrl, token, appId, repo, headSha, fetchImpl });
  const body = JSON.stringify({ name: CHECK_NAME, head_sha: headSha, status: "in_progress" });
  await writeRun({ apiUrl, token, repo, headSha, runId, body, verb: "in_progress", fetchImpl, log });
}

// Publish the gate's decision as a completed check run named
// `coderabbit-approved` on the PR's head SHA. The run is created with the
// App's installation token, so its owning app is the App — which is the
// identity branch protection must require the check from. A run posted by the
// PR checkout's own workflow (the forgeable shape this replaces) is a
// different app and does not satisfy that requirement.
export async function publishCheck({ apiUrl, token, appId, repo, headSha, pass, reason, fetchImpl = fetch, log = {} }) {
  const conclusion = pass ? "success" : "failure";
  const output = {
    title: pass ? "CodeRabbit approved this head" : "CodeRabbit has not approved this head",
    summary: reason,
  };
  const runId = await ownRun({ apiUrl, token, appId, repo, headSha, fetchImpl });
  const body = JSON.stringify({ name: CHECK_NAME, head_sha: headSha, status: "completed", conclusion, output });
  await writeRun({ apiUrl, token, repo, headSha, runId, body, verb: conclusion, fetchImpl, log });
}
