// The app's baseline security headers (audit S1).
//
// AWS (ALB) and Fly (its own proxy) run no Caddy, so before this the only place
// any of these headers was set never reached the event deployment. The app now
// sends them from `next.config.ts`. This file reads the EXPORTED config — what
// Next itself loads — and fails if a header, its value, or its all-routes
// source goes missing. It also pins that Caddy's defence-in-depth block carries
// the same values, so the two layers can never disagree on a response.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCustomRoute } from "next/dist/lib/build-custom-route";

import nextConfig from "../../next.config";

const EXPECTED: Record<string, string> = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

async function configuredHeaders() {
  expect(typeof nextConfig.headers).toBe("function");
  return nextConfig.headers!();
}

describe("next.config security headers", () => {
  it("sends every baseline header with its exact value", async () => {
    const rules = await configuredHeaders();
    const sent = Object.fromEntries(rules.flatMap((r) => r.headers).map((h) => [h.key.toLowerCase(), h.value]));
    for (const [key, value] of Object.entries(EXPECTED)) expect(sent[key], key).toBe(value);
  });

  it("applies them to every route, pages and API alike (compiled by Next)", async () => {
    const rules = await configuredHeaders();
    for (const key of Object.keys(EXPECTED)) {
      const carrying = rules.filter((r) => r.headers.some((h) => h.key.toLowerCase() === key));
      const regexes = carrying.map((r) => new RegExp(buildCustomRoute("header", r).regex));
      for (const path of ["/", "/admin", "/challenges/abc", "/api/admin/event", "/api/attachments/x"]) {
        expect(
          regexes.some((re) => re.test(path)),
          `${key} on ${path}`,
        ).toBe(true);
      }
    }
  });

  it("carries a CSP of frame-ancestors only — no script policy that could block Next's inline bootstrap", async () => {
    const rules = await configuredHeaders();
    const csp = rules.flatMap((r) => r.headers).filter((h) => h.key.toLowerCase() === "content-security-policy");
    expect(csp.map((h) => h.value)).toEqual(["frame-ancestors 'none'"]);
  });

  it("does not advertise X-Powered-By", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});

describe("Caddy's defence-in-depth header block", () => {
  const caddyfile = readFileSync(join(__dirname, "../../../../caddy/Caddyfile.poll"), "utf-8");
  const block = caddyfile.match(/^header \{([\s\S]*?)^\}/m)?.[1] ?? "";

  it("sets each header to the same value the app sends", () => {
    expect(block).not.toBe("");
    const set = Object.fromEntries(
      [...block.matchAll(/^\s*([A-Za-z-]+)\s+"([^"]*)"\s*$/gm)].map((m) => [m[1].toLowerCase(), m[2]]),
    );
    expect(set).toEqual(EXPECTED);
  });

  it("is deferred, so it overwrites the proxied app's copy instead of appending a duplicate", () => {
    expect(block).toMatch(/^\s*defer\s*$/m);
  });
});
