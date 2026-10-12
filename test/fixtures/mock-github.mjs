import { createServer } from "node:http";
import { existsSync } from "node:fs";

const score = (author, target, solved, pr) =>
  `Scored ✅\n<!-- ctf-score: ${JSON.stringify({ author, target, solved, pr, sha: "deadbeef" })} -->`;

const comments = [
  { id: 1, user: { login: "github-actions[bot]" }, updated_at: "2026-08-13T10:00:00Z",
    body: score("octocat", "dvwa", ["sqli-low", "exec-low"], 7) },
  { id: 2, user: { login: "mallory" }, updated_at: "2026-08-13T10:05:00Z",
    body: score("mallory", "dvwa", ["sqli-low", "exec-low", "csrf-low", "upload-low"], 8) }, // forged — must be ignored
  { id: 3, user: { login: "github-actions[bot]" }, updated_at: "2026-08-13T10:10:00Z",
    body: score("mona", "juice-shop", ["restfulXss"], 3) },
];

// A 4th, initially-hidden comment — smoke.sh's freeze stage touches
// EXTRA_COMMENT_FLAG to make it appear mid-run, simulating a fresh
// contributor score landing while scoring is frozen, without needing to
// rebuild this fixture (or the sync image) mid-test.
const EXTRA_COMMENT_FLAG = "/tmp/extra-comment";
const extraComment = { id: 4, user: { login: "github-actions[bot]" }, updated_at: "2026-08-13T10:15:00Z",
  body: score("trinity", "dvwa", ["csrf-low"], 9) };

createServer((req, res) => {
  if (/^\/repos\/[^/]+\/[^/]+\/issues\/comments/.test(req.url)) {
    const body = existsSync(EXTRA_COMMENT_FLAG) ? [...comments, extraComment] : comments;
    res.writeHead(200, { "content-type": "application/json", etag: 'W/"fixture"' });
    res.end(JSON.stringify(body));
    return;
  }
  // GitHub App auth (sync mints an App JWT then exchanges it here).
  if (req.url === "/app/installations") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ id: 1 }]));
    return;
  }
  if (/^\/app\/installations\/\d+\/access_tokens$/.test(req.url)) {
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ token: "ghs_mock_installation", expires_at: "2099-01-01T00:00:00Z" }));
    return;
  }
  res.writeHead(404).end();
}).listen(8080, () => console.error("mock-github on :8080"));
