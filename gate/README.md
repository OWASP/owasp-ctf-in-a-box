# ctf-coderabbit-gate

The trusted producer of the `coderabbit-approved` required check (#487).

## Why this is a service, not a workflow

A `pull_request` or `pull_request_review` workflow runs the workflow file from
the **merge commit of the pull request** — that is, the PR author's own copy.
A required check the PR can rewrite is not a gate: a contestant edits
`coderabbit-approved.yml`, replaces the step with `exit 0`, and the check
goes green with no review. `pull_request_target` is base-owned but has no
`review submitted/edited/dismissed` activity type, so it cannot re-evaluate
when CodeRabbit's verdict changes.

So the check is produced here, by a GitHub App, from data the App fetches with
its own installation token. Nothing in the PR touches this path.

## What it does

On a signed `pull_request` (`opened`, `synchronize`, `reopened`,
`ready_for_review`) or `pull_request_review` (`submitted`, `edited`,
`dismissed`) delivery, it reads the PR's reviews and publishes a check run
named `coderabbit-approved` on the PR's head SHA. The check is `success` only
when CodeRabbit's **latest** verdict review (`APPROVED` / `CHANGES_REQUESTED`
/ `DISMISSED`, newest by `submitted_at`) is `APPROVED` on that exact head. A
comment-only review is ignored; no verdict, a non-approved state (a dismissal
included), an approval of another commit, or a failed API read all fail
closed. Dependabot PRs, which CodeRabbit does not review, pass on the exact
author login `dependabot[bot]`.

A delivery writes the check twice: it first **claims** the head's row
(`in_progress`, no conclusion), then completes it with the verdict. Anything
that fails after the claim — the reviews read, the completion write, the
process dying mid-delivery — therefore leaves an unfinished check, which a
required status does not satisfy, rather than whatever an earlier delivery
concluded on the same head.

### When the check cannot be written at all

GitHub does **not** automatically redeliver failed webhook deliveries, so two
failures answer `500` and change nothing: the token mint and the check-run
writes themselves (both need the GitHub API). They surface as failed
deliveries in the App's webhook log, where the operator can redeliver them
(deliveries are redeliverable for 3 days); any later push or review on the PR
re-publishes the check anyway. Nothing in this service can publish through an
API outage — a durable retry queue is deliberately not built, because this is
a repo-governance process with no datastore. Once a delivery holds a token,
every state it can leave behind is unfinished or failing, never passing; the
residual window is an outage before the claim lands, where an earlier
conclusion on the same head stands until a later delivery succeeds.

## GitHub App setup (maintainer)

Register an App and install it on the repository:

- **Permissions:** Checks — read & write; Pull requests — read; Metadata —
  read. Nothing else (no `contents`: it never checks out).
- **Subscribe to events:** `Pull request`, `Pull request review`.
- **Webhook URL:** `https://<host>/webhook`; set a webhook secret.
- Then branch protection requires the `coderabbit-approved` check **from this
  App** (a ruleset's required check can name the source app) in place of the
  removed workflow's job context.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `GITHUB_APP_ID` | yes | The App's id. |
| `GITHUB_APP_PRIVATE_KEY` | yes | Base64 of the App's `.pem` private key. |
| `GITHUB_APP_INSTALLATION_ID` | no | Pin the installation; auto-discovered when unset. |
| `GITHUB_WEBHOOK_SECRET` | yes | The App's webhook secret, for the HMAC check. |
| `PORT` | no | Listen port (default `8787`). |

## Run

```sh
cd gate && npm test     # the decision rule and the handler, no network
node src/server.js      # POST /webhook, GET /healthz
```

App auth is reused from `sync/src/appAuth.js` — one signer, not two — so a
change there must re-run this suite (`scripts/ci-changes.sh` routes it into
both areas).
