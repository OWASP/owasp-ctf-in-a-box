import test from "node:test";
import assert from "node:assert/strict";
import { latestVerdictReview, evaluateVerdict } from "../src/verdict.js";

const HEAD = "1111111111111111111111111111111111111111";
const OTHER = "2222222222222222222222222222222222222222";

function rev(state, commitId, submittedAt, login = "coderabbitai[bot]") {
  return { user: { login }, state, commit_id: commitId, submitted_at: submittedAt };
}

test("an APPROVED review on this head passes", () => {
  const d = evaluateVerdict({ reviews: [rev("APPROVED", HEAD, "2026-01-01T00:00:00Z")], headSha: HEAD, author: "octocat" });
  assert.equal(d.pass, true);
});

test("latestVerdictReview picks the newest by submitted_at, not array order", () => {
  const latest = latestVerdictReview([
    rev("CHANGES_REQUESTED", HEAD, "2026-01-03T00:00:00Z"),
    rev("APPROVED", HEAD, "2026-01-01T00:00:00Z"),
    rev("APPROVED", HEAD, "2026-01-02T00:00:00Z"),
  ]);
  assert.equal(latest.state, "CHANGES_REQUESTED");
});

test("APPROVED then a newer COMMENTED on the same head still passes", () => {
  const d = evaluateVerdict({
    reviews: [rev("APPROVED", HEAD, "2026-01-01T00:00:00Z"), rev("COMMENTED", HEAD, "2026-01-02T00:00:00Z")],
    headSha: HEAD,
    author: "octocat",
  });
  assert.equal(d.pass, true);
});

test("a newer CHANGES_REQUESTED beats an earlier APPROVED on this head", () => {
  const d = evaluateVerdict({
    reviews: [rev("APPROVED", HEAD, "2026-01-01T00:00:00Z"), rev("CHANGES_REQUESTED", HEAD, "2026-01-02T00:00:00Z")],
    headSha: HEAD,
    author: "octocat",
  });
  assert.equal(d.pass, false);
  assert.match(d.reason, /CHANGES_REQUESTED/);
});

test("a newer DISMISSED beats an earlier APPROVED on this head", () => {
  const d = evaluateVerdict({
    reviews: [rev("APPROVED", HEAD, "2026-01-01T00:00:00Z"), rev("DISMISSED", HEAD, "2026-01-02T00:00:00Z")],
    headSha: HEAD,
    author: "octocat",
  });
  assert.equal(d.pass, false);
  assert.match(d.reason, /DISMISSED/);
});

test("a stale approval on another commit does not pass", () => {
  const d = evaluateVerdict({ reviews: [rev("APPROVED", OTHER, "2026-01-01T00:00:00Z")], headSha: HEAD, author: "octocat" });
  assert.equal(d.pass, false);
  assert.match(d.reason, /not this head/);
});

test("no review at all fails closed", () => {
  const d = evaluateVerdict({ reviews: [], headSha: HEAD, author: "octocat" });
  assert.equal(d.pass, false);
  assert.match(d.reason, /no verdict review/);
});

test("a comment-only review is not a verdict and fails closed", () => {
  const d = evaluateVerdict({ reviews: [rev("COMMENTED", HEAD, "2026-01-01T00:00:00Z")], headSha: HEAD, author: "octocat" });
  assert.equal(d.pass, false);
});

test("a non-CodeRabbit reviewer is ignored", () => {
  const d = evaluateVerdict({ reviews: [rev("APPROVED", HEAD, "2026-01-01T00:00:00Z", "some-human")], headSha: HEAD, author: "octocat" });
  assert.equal(d.pass, false);
});

test("the login match is case-insensitive", () => {
  const d = evaluateVerdict({ reviews: [rev("APPROVED", HEAD, "2026-01-01T00:00:00Z", "CodeRabbitAI[bot]")], headSha: HEAD, author: "octocat" });
  assert.equal(d.pass, true);
});

test("Dependabot passes with no reviews", () => {
  const d = evaluateVerdict({ reviews: [], headSha: HEAD, author: "dependabot[bot]" });
  assert.equal(d.pass, true);
});

test("a human login that merely contains the bot name is not bypassed", () => {
  const d = evaluateVerdict({ reviews: [], headSha: HEAD, author: "dependabot[bot]-impostor" });
  assert.equal(d.pass, false);
});
