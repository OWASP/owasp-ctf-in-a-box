import { verifySignature } from "./verify.js";
import { evaluateVerdict, DEPENDABOT } from "./verdict.js";
import { publishCheck, CHECK_NAME } from "./checks.js";

const API_VERSION = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };

// The pull_request actions that move the head or its readiness. Any other
// action (labeled, assigned, …) cannot change the verdict, so it is ignored
// rather than re-publishing an unchanged check.
const HANDLED_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
// A PR with more review pages than this is pathological; the cap keeps a
// misbehaving Link header from looping forever.
const MAX_REVIEW_PAGES = 20;

function nextLink(link) {
  if (typeof link !== "string") return null;
  const m = /<([^>]+)>\s*;\s*rel="next"/.exec(link);
  return m ? m[1] : null;
}

// Every review on the PR, one page at a time. GitHub's reviews list is not
// ordered by submission time and pages at 30 by default, so the newest verdict
// can sit on any page — the rule sorts, but it needs the whole set first.
export async function fetchAllReviews({ apiUrl, token, repo, number, fetchImpl = fetch }) {
  const headers = { ...API_VERSION, authorization: `Bearer ${token}` };
  const reviews = [];
  let url = `${apiUrl}/repos/${repo}/pulls/${number}/reviews?per_page=100`;
  for (let page = 0; url !== null && page < MAX_REVIEW_PAGES; page++) {
    const res = await fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`GitHub ${res.status} reading ${repo}#${number} reviews`);
    const batch = await res.json();
    if (!Array.isArray(batch)) throw new Error(`GitHub returned a non-array reviews payload for ${repo}#${number}`);
    reviews.push(...batch);
    url = nextLink(typeof res.headers?.get === "function" ? res.headers.get("link") : null);
  }
  return reviews;
}

// Build the webhook handler. Every dependency (App auth, fetch, logger) is
// injected so the decision path is exercised without GitHub or a network.
export function createHandler({ webhookSecret, auth, appId, apiUrl = "https://api.github.com", fetchImpl = fetch, log = console }) {
  return async function handle({ event, headers = {}, body }) {
    // Before anything else: a delivery not signed by the App's webhook secret
    // is not from GitHub. This is the fix. The check is produced here, from
    // data the App fetches with its own token, never from the PR's own
    // workflow — so a contestant who edits the workflow in their PR changes
    // nothing this service trusts.
    if (!verifySignature({ secret: webhookSecret, body, header: headers["x-hub-signature-256"] })) {
      log.warn?.(`gate: refused a delivery with a missing or invalid signature (event=${event ?? "?"})`);
      return { status: 401 };
    }

    let payload;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return { status: 400 };
    }

    if (event !== "pull_request" && event !== "pull_request_review") return { status: 204 };
    if (event === "pull_request" && !HANDLED_ACTIONS.has(payload.action)) return { status: 204 };

    const pr = payload.pull_request;
    const repo = payload.repository?.full_name;
    const headSha = pr?.head?.sha;
    if (!pr || !repo || !headSha) return { status: 204 };
    const author = pr.user?.login ?? "";
    const number = pr.number;

    let token;
    try {
      token = await auth.getToken(fetchImpl);
    } catch (err) {
      // With no token no check can be published at all. Return 500 so GitHub
      // redelivers, rather than recording a delivery that changed nothing.
      log.error?.(`gate: cannot mint an installation token: ${err?.message ?? err}`);
      return { status: 500 };
    }

    let decision;
    try {
      if (author === DEPENDABOT) {
        decision = evaluateVerdict({ reviews: [], headSha, author });
      } else {
        const reviews = await fetchAllReviews({ apiUrl, token, repo, number, fetchImpl });
        decision = evaluateVerdict({ reviews, headSha, author });
      }
    } catch (err) {
      // A failed read fails CLOSED: publish a failing check, never leave a
      // stale success standing on the head.
      decision = { pass: false, reason: `could not read this PR's reviews from the API: ${err?.message ?? err}` };
      log.error?.(`gate: ${repo}#${number}: ${decision.reason}`);
    }

    try {
      await publishCheck({ apiUrl, token, appId, repo, headSha, pass: decision.pass, reason: decision.reason, fetchImpl, log });
    } catch (err) {
      log.error?.(`gate: could not publish the ${CHECK_NAME} check for ${repo}@${headSha}: ${err?.message ?? err}`);
      return { status: 500 };
    }
    return { status: 202 };
  };
}
