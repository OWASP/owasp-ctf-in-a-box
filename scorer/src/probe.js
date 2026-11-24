// Probe grammar v1 + execution. The rubric loader only demands that probes
// exist (serve never runs them); the judge is the executor, so IT validates
// the grammar here — loudly, before any network call.

const PROBE_KEYS = new Set(["request", "expect"]);
const REQUEST_KEYS = new Set(["method", "path", "headers", "body"]);
const EXPECT_KEYS = new Set(["status", "bodyIncludes", "bodyMissing"]);
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

const isMapping = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Throws on the first grammar violation; `where` names the challenge
// (e.g. "juice-shop/reflected-xss-search") so the error points at the rubric.
export function validateProbes(probes, where) {
  probes.forEach((probe, i) => {
    const fail = (msg) => {
      throw new Error(`probe ${where}[${i}]: ${msg}`);
    };
    if (!isMapping(probe)) fail("expected a mapping with request + expect");
    const unknown = Object.keys(probe).filter((k) => !PROBE_KEYS.has(k));
    if (unknown.length) fail(`unknown key: ${unknown.join(", ")}`);

    const { request, expect } = probe;
    if (!isMapping(request)) fail("request is required and must be a mapping");
    const unknownR = Object.keys(request).filter((k) => !REQUEST_KEYS.has(k));
    if (unknownR.length) fail(`request: unknown key: ${unknownR.join(", ")}`);
    if (!METHODS.has(request.method)) {
      fail(`request.method must be an uppercase HTTP verb (${[...METHODS].join(", ")})`);
    }
    if (typeof request.path !== "string" || !request.path.startsWith("/")) {
      fail("request.path is required and must start with /");
    }
    if (request.headers !== undefined) {
      if (!isMapping(request.headers)) fail("request.headers must be a mapping");
      for (const [k, v] of Object.entries(request.headers)) {
        if (typeof v !== "string") fail(`request.headers.${k} must be a string`);
      }
    }
    if (request.body !== undefined && typeof request.body !== "string") {
      fail("request.body must be a string");
    }

    if (!isMapping(expect)) fail("expect is required and must be a mapping");
    const unknownE = Object.keys(expect).filter((k) => !EXPECT_KEYS.has(k));
    if (unknownE.length) fail(`expect: unknown key: ${unknownE.join(", ")}`);
    const { status } = expect;
    if (Array.isArray(status)) {
      const [min, max] = status;
      if (status.length !== 2 || !Number.isInteger(min) || !Number.isInteger(max) || min > max) {
        fail("expect.status range must be [min, max] integers with min <= max");
      }
    } else if (!Number.isInteger(status)) {
      fail("expect.status is required: an integer or a [min, max] range");
    }
    for (const k of ["bodyIncludes", "bodyMissing"]) {
      if (expect[k] !== undefined && typeof expect[k] !== "string") fail(`expect.${k} must be a string`);
    }
  });
}

// APP_URL may carry a path prefix (http://app:8080/WebGoat); probe paths
// always start with "/" — trim the base so the join never doubles a slash.
export const joinUrl = (base, path) => base.replace(/\/+$/, "") + path;

const statusMatches = (actual, expected) =>
  Array.isArray(expected) ? actual >= expected[0] && actual <= expected[1] : actual === expected;

// One probe. Network error or timeout = the probe fails, never the run.
// redirect: "manual" so a rubric can pin 3xx statuses.
export async function runProbe(appUrl, probe, { timeoutMs = 10_000, fetchImpl = fetch } = {}) {
  const { request, expect } = probe;
  let res;
  try {
    res = await fetchImpl(joinUrl(appUrl, request.path), {
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return false;
  }
  if (!statusMatches(res.status, expect.status)) return false;
  if (expect.bodyIncludes === undefined && expect.bodyMissing === undefined) return true;
  let text;
  try {
    text = await res.text();
  } catch {
    return false;
  }
  if (expect.bodyIncludes !== undefined && !text.includes(expect.bodyIncludes)) return false;
  if (expect.bodyMissing !== undefined && text.includes(expect.bodyMissing)) return false;
  return true;
}

// A challenge is solved iff ALL its probes pass (short-circuits on the first miss).
export async function runProbes(appUrl, probes, opts) {
  for (const probe of probes) {
    if (!(await runProbe(appUrl, probe, opts))) return false;
  }
  return true;
}

// A reachable error page is not evidence that the application's health endpoint works.
export async function waitForApp(appUrl, { tries = 60, delayMs = 5000, fetchImpl = fetch } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetchImpl(appUrl, { signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
      if (response.status >= 200 && response.status < 300) return true;
    } catch { /* Retry transient connection failures within the readiness budget. */ }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}
