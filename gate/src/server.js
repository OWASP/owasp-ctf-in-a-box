import http from "node:http";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createHandler } from "./app.js";

// GitHub's pull_request payloads are well under this; the cap is only so a
// hostile or malformed body cannot make the process buffer without bound.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// The webhook endpoint is POST /webhook; GET /healthz is a liveness probe.
// Nothing here reads the filesystem or a git checkout — the only input the
// service trusts is the App-signed body.
export function createServer({ handler, log = console }) {
  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method !== "POST" || req.url !== "/webhook") {
      res.writeHead(404);
      res.end();
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(413);
      res.end();
      return;
    }
    let result;
    try {
      result = await handler({ event: req.headers["x-github-event"], headers: req.headers, body });
    } catch (err) {
      log.error?.(`gate: unhandled error: ${err?.stack ?? err}`);
      res.writeHead(500);
      res.end();
      return;
    }
    res.writeHead(result.status);
    res.end();
  });
}

export function startServer({ port = Number(process.env.PORT ?? 8787), log = console, ...config } = {}) {
  const handler = createHandler({ ...config, log });
  const server = createServer({ handler, log });
  server.listen(port, () => log.info?.(`ctf-coderabbit-gate listening on :${port}`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer(loadConfig());
}
