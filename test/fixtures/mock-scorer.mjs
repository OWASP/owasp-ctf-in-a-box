import { createServer } from "node:http";

const TOKEN = process.env.SCORER_TOKEN ?? "s3cret";
const solves = new Map(); // author -> Set(target:id)
// author -> the `at` of the last score received for them: the score comment's
// time sync forwards. Judging it (window, freeze, reset) is the real scorer's
// job and is gated by acceptance-scorer.sh; this stand-in only shows smoke.sh
// that the time made it through the poll pipeline.
const lastAt = new Map();

createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/score") {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const { author, target, solved, at } = JSON.parse(body);
    lastAt.set(author, typeof at === "string" ? at : null);
    const set = solves.get(author) ?? new Set();
    for (const id of solved ?? []) set.add(`${target}:${id}`);
    solves.set(author, set);
    res.writeHead(202).end();
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/leaderboard")) {
    const leaderboard = [...solves.entries()]
      .map(([author, set]) => ({ author, points: set.size, solved: [...set].sort(), at: lastAt.get(author) ?? null }))
      .sort((a, b) => b.points - a.points);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ leaderboard }));
    return;
  }
  res.writeHead(404).end();
}).listen(4000, () => console.error("mock-scorer on :4000"));
