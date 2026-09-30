// Cross-route contract test for the ai module's four HTTP endpoints.
//
// Per-route tests cannot see disagreement BETWEEN routes, and four handlers
// written in sequence against the same helpers are exactly where a contract
// drifts — one route quietly re-implementing a check with a different slug,
// or reaching for a store reader the others were careful to avoid. This file
// pins what must hold across all four:
//
//   1. every route answers a CORS preflight the same way;
//   2. no route ever claims `Access-Control-Allow-Credentials` — the module
//      is cookie-blind, so there is no credential to allow (see
//      `ai-http.ts`'s `AI_CORS_HEADERS` comment);
//   3. a condition shared by more than one route (bad token, unknown
//      challenge, wrong mode, teamless, rate limit) produces the SAME
//      `{ error: "<slug>" }` slug everywhere it can occur;
//   4. every route opts out of prerendering the same way;
//   5. a store outage answers 503 `{error:"unavailable"}` on every route,
//      CORS headers attached — never a bare 500 an external caller cannot even
//      read the status of;
//   6. and — the invariant this file exists for — no route's SOURCE FILE
//      imports a cookie/session primitive, or an admin-only store reader,
//      structurally rather than behaviourally. A future edit that adds a
//      session read fails here even if its own route test still passes.
//
// THE ROUTE SET IS DISCOVERED, NOT LISTED. `DISCOVERED_ROUTES` below reads
// `app/api/ai/`'s directory entries and the suite asserts it EQUALS the
// enumerated `ROUTES` map. Without that, the cookie-blindness argument is only
// as strong as somebody remembering to extend a hardcoded list: a later
// `app/api/ai/hint/route.ts` calling `auth.api.getSession` would be
// CSRF-exempt by prefix, cookie-authenticated and CORS `*` — a live hole —
// and this file would stay green because the new route was never added to it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyLaunchToken: vi.fn(),
  decodeTokenUnverified: vi.fn(),
  verifyEventSignature: vi.fn(),
  getAiLaunchPublicKey: vi.fn(),
  getAiSigningKey: vi.fn(),
  listAiChallenges: vi.fn(),
  submitAiFlag: vi.fn(),
  awardAiEvent: vi.fn(),
  claimAiNonce: vi.fn(),
  releaseAiNonce: vi.fn(),
  getViewerAi: vi.fn(),
  consumeRateLimit: vi.fn(),
  hasTeam: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai-token", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai-token")>()),
  verifyLaunchToken: mocks.verifyLaunchToken,
  decodeTokenUnverified: mocks.decodeTokenUnverified,
  verifyEventSignature: mocks.verifyEventSignature,
}));
vi.mock("@/lib/ai-store", () => ({
  getAiLaunchPublicKey: mocks.getAiLaunchPublicKey,
  getAiSigningKey: mocks.getAiSigningKey,
  listAiChallenges: mocks.listAiChallenges,
  submitAiFlag: mocks.submitAiFlag,
  awardAiEvent: mocks.awardAiEvent,
  claimAiNonce: mocks.claimAiNonce,
  releaseAiNonce: mocks.releaseAiNonce,
  getViewerAi: mocks.getViewerAi,
}));
vi.mock("@/lib/rate-limit-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit-store")>()),
  consumeRateLimit: mocks.consumeRateLimit,
}));
vi.mock("@/lib/team-store", () => ({ hasTeam: mocks.hasTeam }));
// #495: the grading routes gate on the ai module being live. ON for every
// cross-route contract below — the gate itself is pinned in each route's suite.
vi.mock("@/lib/enabled-modules", () => ({ isModuleLive: async () => true }));

import * as SubmitRoute from "@/app/api/ai/submit/route";
import * as EventRoute from "@/app/api/ai/event/route";
import * as StateRoute from "@/app/api/ai/state/route";
import * as LaunchKeyRoute from "@/app/api/ai/launch-key/route";

const CHAL = "prompt-leak-ab12cd";
// Pinned to line up with `postEvent`'s default `ts` below, so the event
// route's clock-skew check (checked before the token) never trips these
// cross-route comparisons for unrelated reasons.
const NOW_MS = 1_756_636_800_000;
// A real Ed25519 public key PEM. `launch-key/route.ts` runs this through the
// real (unmocked) `launchKeyId`, which parses it via `node:crypto` — unlike
// the other three routes, where `verifyLaunchToken` is mocked and never
// looks at the key's actual bytes.
const REAL_PUBLIC_PEM =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAn3ucqIwaK//zm/i15crO7vM+glf/le0cAR1nN/Dyy+8=\n-----END PUBLIC KEY-----\n";

const ROUTES = {
  submit: SubmitRoute,
  event: EventRoute,
  state: StateRoute,
  "launch-key": LaunchKeyRoute,
} as const;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AI_API_DIR = path.join(__dirname, "..");

/** Both filenames Next.js accepts for a route handler. A `route.js` under
 *  this prefix is as much a live endpoint as a `route.ts` — matching only the
 *  TypeScript spelling would let one ship outside every family below while
 *  still CSRF-exempt by prefix and CORS `*`. */
const ROUTE_FILENAMES = ["route.ts", "route.js"] as const;

/** Every route handler that actually exists under `app/api/ai/`, walked
 *  RECURSIVELY — read off the filesystem, so a route added without touching
 *  this file is a FAILURE here rather than an untested endpoint. The
 *  identifier is the path relative to `app/api/ai/` with the `route.*`
 *  segment dropped (e.g. `foo/bar/route.ts` -> `foo/bar`), so a nested route
 *  is named distinctly from a top-level one rather than colliding with it. A
 *  one-level `readdirSync` would miss anything nested — outside this
 *  enumeration, the cookie-blindness grep, the admin-reader grep and the 503
 *  family below, while still enjoying the proxy's `/api/ai/` CSRF exemption
 *  by prefix. `__tests__` and friends never contain a route handler
 *  themselves, so no exclusion is needed for them. The matched FILENAME rides
 *  along so the source read below opens the file that was actually found
 *  rather than assuming the `.ts` spelling.
 *
 *  Every call — including the root one, `discoverRoutes(AI_API_DIR)` with
 *  `prefix` defaulted to `""` — checks the DIRECTORY ITSELF for a route file
 *  before recursing into its children. That root check matters on its own:
 *  a hypothetical `app/api/ai/route.ts` (the exact path `/api/ai`, no
 *  trailing segment) would be invisible to every family below without it —
 *  AND it sits in a different CSRF situation than everything else this file
 *  enumerates. The proxy's exemption is `AI_PREFIX = "/api/ai/"`, WITH the
 *  trailing slash; `/api/ai` doesn't match that prefix, so such a route would
 *  be CSRF-checked like any non-ai route while every id this function finds
 *  normally (`submit`, `event/...`, etc.) is exempt. The discovery has to see
 *  a root handler precisely because its situation differs from the rest. */
function discoverRoutes(dir: string, prefix = ""): { id: string; file: string }[] {
  const found: { id: string; file: string }[] = [];
  for (const file of ROUTE_FILENAMES) {
    if (existsSync(path.join(dir, file))) found.push({ id: prefix, file });
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const childDir = path.join(dir, entry.name);
    const id = prefix ? `${prefix}/${entry.name}` : entry.name;
    found.push(...discoverRoutes(childDir, id));
  }
  return found;
}

const DISCOVERED_FILES = discoverRoutes(AI_API_DIR).sort((a, b) => a.id.localeCompare(b.id));
const DISCOVERED_ROUTES: string[] = DISCOVERED_FILES.map(({ id }) => id);

const SOURCE: Record<string, string> = Object.fromEntries(
  DISCOVERED_FILES.map(({ id, file }) => [id, readFileSync(path.join(AI_API_DIR, id, file), "utf8")]),
);

/** Just the `import ...` lines from a route source file. Several of these
 *  routes deliberately NAME the readers/primitives they refuse to import, in
 *  a doc comment explaining why (e.g. launch-key's header names
 *  `getAiLaunchKeys()` to say it calls the public accessor instead). A plain
 *  substring check over the whole file would flag that prose as if it were a
 *  real import, so every source-grep assertion below runs over the import
 *  lines alone.
 *
 *  Leading whitespace is tolerated. A MULTI-LINE (e.g. Prettier-wrapped)
 *  import list would still slip past this line-by-line matcher — it would need
 *  joining continuation lines onto their `import` before matching — so the
 *  routes keep their store imports on one line and say so where they do. */
function importLines(src: string): string {
  return src
    .split("\n")
    .filter((line) => /^\s*import\s/.test(line))
    .join("\n");
}

const IMPORTS: Record<string, string> = Object.fromEntries(
  DISCOVERED_ROUTES.map((name) => [name, importLines(SOURCE[name])]),
);

function tokenIsGood(sub = "alice") {
  mocks.decodeTokenUnverified.mockReturnValue({ sub, aud: CHAL, jti: "n1" });
  mocks.getAiLaunchPublicKey.mockResolvedValue("-----BEGIN PUBLIC KEY-----test");
  mocks.verifyLaunchToken.mockReturnValue({ ok: true, claims: { sub, aud: CHAL, jti: "n1" } });
  mocks.listAiChallenges.mockResolvedValue([{ id: CHAL, mode: "both", points: 300 }]);
  mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
  mocks.hasTeam.mockResolvedValue(true);
}

const postSubmit = (body: unknown) =>
  new Request("http://x/api/ai/submit", { method: "POST", body: JSON.stringify(body) });

const postEvent = (raw: string, ts = NOW_MS / 1000, headers: Record<string, string> = {}) =>
  new Request("http://x/api/ai/event", {
    method: "POST",
    body: raw,
    headers: {
      "content-type": "application/json",
      "x-ctf-timestamp": String(ts),
      "x-ctf-signature": "sha256=deadbeef",
      ...headers,
    },
  });

const getState = (token: string) =>
  new Request("http://x/api/ai/state", { headers: { authorization: `Bearer ${token}` } });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
});

afterEach(() => vi.useRealTimers());

describe("ai module contract: the enumeration covers every route that exists", () => {
  it("every route directory under app/api/ai is in this file's ROUTES map", () => {
    // The proxy exemption for `/api/ai/` is safe BECAUSE nothing under it
    // reads a cookie — and that argument is only as strong as this
    // enumeration. A fifth route must fail this suite until someone
    // consciously adds it to every assertion family below, rather than
    // shipping CSRF-exempt, CORS `*` and unchecked.
    expect(DISCOVERED_ROUTES).toEqual([...Object.keys(ROUTES)].sort());
  });

  it("read a real source file for each of them", () => {
    // Anti-vacuous: an empty discovery, or an unreadable file, would make
    // every source-grep family below pass by having nothing to check.
    expect(DISCOVERED_ROUTES.length).toBeGreaterThan(0);
    for (const name of DISCOVERED_ROUTES) {
      expect(SOURCE[name], name).toContain("export const dynamic");
      expect(IMPORTS[name], name).toContain('from "@/lib/ai-http"');
    }
  });
});

describe("ai module contract: CORS preflight", () => {
  it.each(Object.keys(ROUTES) as (keyof typeof ROUTES)[])("%s answers a 204 preflight with Allow-Origin: *", async (name) => {
    const route = ROUTES[name];
    expect(route.OPTIONS).toBeTypeOf("function");
    const res = await route.OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("ai module contract: never Allow-Credentials", () => {
  it("submit — neither a success nor a refusal sets Allow-Credentials", async () => {
    tokenIsGood();
    mocks.submitAiFlag.mockResolvedValue({ ok: true, correct: true, points: 300 });
    const ok = await SubmitRoute.POST(postSubmit({ token: "t", flag: "CTF{x}" }));
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();

    mocks.verifyLaunchToken.mockReturnValue({ ok: false, error: "invalid-signature" });
    const bad = await SubmitRoute.POST(postSubmit({ token: "t", flag: "CTF{x}" }));
    expect(bad.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("event — neither a success nor a refusal sets Allow-Credentials", async () => {
    const raw = JSON.stringify({ token: "t", challengeId: CHAL });
    mocks.listAiChallenges.mockResolvedValue([{ id: CHAL, mode: "event", points: 400 }]);
    mocks.getAiSigningKey.mockResolvedValue("aik_key");
    mocks.getAiLaunchPublicKey.mockResolvedValue("-----BEGIN PUBLIC KEY-----test");
    mocks.verifyEventSignature.mockReturnValue(true);
    mocks.verifyLaunchToken.mockReturnValue({ ok: true, claims: { sub: "alice", aud: CHAL, jti: "n1" } });
    mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
    mocks.claimAiNonce.mockResolvedValue(true);
    mocks.hasTeam.mockResolvedValue(true);
    mocks.awardAiEvent.mockResolvedValue({ ok: true, correct: true, points: 400 });

    const ok = await EventRoute.POST(postEvent(raw));
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();

    mocks.verifyEventSignature.mockReturnValue(false);
    const bad = await EventRoute.POST(postEvent(raw));
    expect(bad.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("state — neither a success nor a refusal sets Allow-Credentials", async () => {
    tokenIsGood();
    mocks.getViewerAi.mockResolvedValue({ solved: {}, attempts: {} });
    const ok = await StateRoute.GET(getState("t"));
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();

    mocks.verifyLaunchToken.mockReturnValue({ ok: false, error: "invalid-signature" });
    const bad = await StateRoute.GET(getState("t"));
    expect(bad.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("launch-key — neither a success nor a refusal sets Allow-Credentials", async () => {
    mocks.getAiLaunchPublicKey.mockResolvedValue(REAL_PUBLIC_PEM);
    const ok = await LaunchKeyRoute.GET();
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();

    mocks.getAiLaunchPublicKey.mockRejectedValue(new Error("down"));
    const bad = await LaunchKeyRoute.GET();
    expect(bad.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("ai module contract: shared error slugs agree across routes", () => {
  it("a malformed token yields invalid-token on submit, event and state alike", async () => {
    tokenIsGood();
    mocks.verifyLaunchToken.mockReturnValue({ ok: false, error: "invalid-signature" });
    const submit = await SubmitRoute.POST(postSubmit({ token: "t", flag: "CTF{x}" }));
    expect(await submit.json()).toEqual({ error: "invalid-token" });

    mocks.listAiChallenges.mockResolvedValue([{ id: CHAL, mode: "event", points: 400 }]);
    mocks.getAiSigningKey.mockResolvedValue("aik_key");
    mocks.verifyEventSignature.mockReturnValue(true);
    const event = await EventRoute.POST(postEvent(JSON.stringify({ token: "t", challengeId: CHAL })));
    expect(await event.json()).toEqual({ error: "invalid-token" });

    const state = await StateRoute.GET(getState("t"));
    expect(await state.json()).toEqual({ error: "invalid-token" });
  });

  it("an expired token yields expired on submit, event and state alike", async () => {
    tokenIsGood();
    mocks.verifyLaunchToken.mockReturnValue({ ok: false, error: "expired" });
    const submit = await SubmitRoute.POST(postSubmit({ token: "t", flag: "CTF{x}" }));
    expect(submit.status).toBe(401);
    expect(await submit.json()).toEqual({ error: "expired" });

    mocks.listAiChallenges.mockResolvedValue([{ id: CHAL, mode: "event", points: 400 }]);
    mocks.getAiSigningKey.mockResolvedValue("aik_key");
    mocks.verifyEventSignature.mockReturnValue(true);
    const event = await EventRoute.POST(postEvent(JSON.stringify({ token: "t", challengeId: CHAL })));
    expect(event.status).toBe(401);
    expect(await event.json()).toEqual({ error: "expired" });

    const state = await StateRoute.GET(getState("t"));
    expect(state.status).toBe(401);
    expect(await state.json()).toEqual({ error: "expired" });
  });

  it("an unknown challenge yields unknown-challenge on submit and event alike", async () => {
    tokenIsGood();
    mocks.listAiChallenges.mockResolvedValue([]);
    const submit = await SubmitRoute.POST(postSubmit({ token: "t", flag: "CTF{x}" }));
    expect(submit.status).toBe(404);
    expect(await submit.json()).toEqual({ error: "unknown-challenge" });

    const event = await EventRoute.POST(postEvent(JSON.stringify({ token: "t", challengeId: CHAL })));
    expect(event.status).toBe(404);
    expect(await event.json()).toEqual({ error: "unknown-challenge" });
  });

  it("the wrong mode yields wrong-mode on submit and event alike", async () => {
    tokenIsGood();
    mocks.listAiChallenges.mockResolvedValue([{ id: CHAL, mode: "event", points: 300 }]);
    const submit = await SubmitRoute.POST(postSubmit({ token: "t", flag: "CTF{x}" }));
    expect(submit.status).toBe(409);
    expect(await submit.json()).toEqual({ error: "wrong-mode" });

    mocks.listAiChallenges.mockResolvedValue([{ id: CHAL, mode: "flag", points: 300 }]);
    const event = await EventRoute.POST(postEvent(JSON.stringify({ token: "t", challengeId: CHAL })));
    expect(event.status).toBe(409);
    expect(await event.json()).toEqual({ error: "wrong-mode" });
  });

  it("a teamless subject yields no-team on submit and event alike", async () => {
    tokenIsGood();
    mocks.hasTeam.mockResolvedValue(false);
    const submit = await SubmitRoute.POST(postSubmit({ token: "t", flag: "CTF{x}" }));
    expect(submit.status).toBe(403);
    expect(await submit.json()).toEqual({ error: "no-team" });

    mocks.listAiChallenges.mockResolvedValue([{ id: CHAL, mode: "event", points: 400 }]);
    mocks.getAiSigningKey.mockResolvedValue("aik_key");
    mocks.verifyEventSignature.mockReturnValue(true);
    mocks.claimAiNonce.mockResolvedValue(true);
    const event = await EventRoute.POST(postEvent(JSON.stringify({ token: "t", challengeId: CHAL })));
    expect(event.status).toBe(403);
    expect(await event.json()).toEqual({ error: "no-team" });
  });

  it("an exhausted rate limit yields rate-limited with Retry-After on submit, event and state alike", async () => {
    tokenIsGood();
    mocks.consumeRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 7 });
    const submit = await SubmitRoute.POST(postSubmit({ token: "t", flag: "CTF{x}" }));
    expect(submit.status).toBe(429);
    expect(await submit.json()).toEqual({ error: "rate-limited" });
    expect(submit.headers.get("retry-after")).toBe("7");

    mocks.listAiChallenges.mockResolvedValue([{ id: CHAL, mode: "event", points: 400 }]);
    mocks.getAiSigningKey.mockResolvedValue("aik_key");
    mocks.verifyEventSignature.mockReturnValue(true);
    const event = await EventRoute.POST(postEvent(JSON.stringify({ token: "t", challengeId: CHAL })));
    expect(event.status).toBe(429);
    expect(await event.json()).toEqual({ error: "rate-limited" });
    expect(event.headers.get("retry-after")).toBe("7");

    const state = await StateRoute.GET(getState("t"));
    expect(state.status).toBe(429);
    expect(await state.json()).toEqual({ error: "rate-limited" });
    expect(state.headers.get("retry-after")).toBe("7");
  });

  it("a malformed body yields invalid-request on submit and event alike", async () => {
    const submit = await SubmitRoute.POST(
      new Request("http://x/api/ai/submit", { method: "POST", body: "not json" }),
    );
    expect(submit.status).toBe(400);
    expect(await submit.json()).toEqual({ error: "invalid-request" });

    const event = await EventRoute.POST(
      new Request("http://x/api/ai/event", { method: "POST", body: "not json" }),
    );
    expect(event.status).toBe(400);
    expect(await event.json()).toEqual({ error: "invalid-request" });
  });
});

describe("ai module contract: a store outage is a readable 503 on every route", () => {
  // `upstashPipeline` THROWS on any non-2xx or transport failure, and the
  // store readers these routes call propagate it. Uncaught, Next answers 500
  // with NO CORS headers — so an external SPA's fetch to `/api/ai/state`
  // fails at the CORS layer with no readable status, and an Upstash blip
  // mid-event has the integrator debugging a CORS problem while the box
  // reports nothing. `aiRoute` is what makes the spec's "store failure → 503
  // {error:'unavailable'}" row true on all four.
  const FLAG = "CTF{do-not-log-me}";
  /** A rejection decorated the way a real driver decorates one: with the
   *  command it failed on, whose ARGV on the award path carries the flag. */
  const outage = () =>
    Object.assign(new Error("Upstash pipeline failed: ERR max daily requests"), {
      command: ["EVAL", "...", FLAG],
      cause: new Error(`while sending ${FLAG}`),
    });

  /** Each route's earliest store-touching call, invoked with every gate open
   *  so the ONLY reason a 503 can appear is the throw. */
  const CALL: Record<keyof typeof ROUTES, () => Promise<Response>> = {
    submit: () => SubmitRoute.POST(postSubmit({ token: "t", flag: "CTF{x}" })),
    event: () => EventRoute.POST(postEvent(JSON.stringify({ token: "t", challengeId: CHAL }))),
    state: () => StateRoute.GET(getState("t")),
    "launch-key": () => LaunchKeyRoute.GET(),
  };

  it.each(Object.keys(ROUTES) as (keyof typeof ROUTES)[])(
    "%s answers 503 unavailable with Allow-Origin: * when a store read throws",
    async (name) => {
      tokenIsGood();
      mocks.getViewerAi.mockResolvedValue({ solved: {}, attempts: {} });
      mocks.getAiSigningKey.mockResolvedValue("aik_key");
      mocks.verifyEventSignature.mockReturnValue(true);
      mocks.claimAiNonce.mockResolvedValue(true);
      // The first store read each route makes. Rejecting the whole set keeps
      // this honest whichever one a route reaches for first.
      mocks.getAiLaunchPublicKey.mockRejectedValue(outage());
      mocks.listAiChallenges.mockRejectedValue(outage());

      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await CALL[name]();
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "unavailable" });
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        expect(res.headers.get("access-control-allow-credentials")).toBeNull();

        // Anti-vacuous, and the redaction discipline from `ai-store.ts`: the
        // failure DID reach the logger, and nothing it logged is an Error
        // object — whose own fields carry the request, and the flag with it.
        expect(spy).toHaveBeenCalled();
        for (const call of spy.mock.calls as unknown[][]) {
          expect(call.some((arg) => arg instanceof Error)).toBe(false);
          expect(call.map((arg) => JSON.stringify(arg)).join(" ")).not.toContain(FLAG);
        }
      } finally {
        spy.mockRestore();
      }
    },
  );
});

describe("ai module contract: build-time exports", () => {
  it.each(Object.keys(ROUTES) as (keyof typeof ROUTES)[])("%s opts out of prerendering the same way", (name) => {
    const route = ROUTES[name];
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
  });
});

describe("ai module contract: structural cookie-blindness", () => {
  // Grepping the SOURCE FILE rather than the loaded module: a mocked import
  // in this test file would hide a real `@/lib/auth`/`next/headers` read
  // that only bites in production. This makes the check survive a future
  // edit even if that edit's own route test still passes.
  const FORBIDDEN_IMPORTS = ['"@/lib/auth"', "'@/lib/auth'", '"next/headers"', "'next/headers'", '"@/lib/launch"', "'@/lib/launch'"];

  it.each(DISCOVERED_ROUTES)("%s imports no cookie/session primitive", (name) => {
    const imports = IMPORTS[name];
    for (const needle of FORBIDDEN_IMPORTS) {
      expect(imports).not.toContain(needle);
    }
  });
});

describe("ai module contract: no route reaches for an admin-only secret reader", () => {
  // These identifiers are checked against the IMPORT LINES only (see
  // `importLines` above) — launch-key's own doc comment names
  // `getAiLaunchKeys()` in prose precisely to say it does NOT call it, and a
  // whole-file substring check would misread that as a violation.
  it.each(DISCOVERED_ROUTES)("%s never imports getAiLaunchKeys or listAiChallengesForAdmin", (name) => {
    const imports = IMPORTS[name];
    expect(imports).not.toContain("getAiLaunchKeys");
    expect(imports).not.toContain("listAiChallengesForAdmin");
  });

  it("only event/route.ts imports getAiSigningKey — the one per-challenge secret reader a route may call", () => {
    // Over the DISCOVERED set, so a new route that reaches for a challenge's
    // signing key fails here without anyone editing this assertion.
    expect(IMPORTS.event).toContain("getAiSigningKey");
    for (const name of DISCOVERED_ROUTES.filter((n) => n !== "event")) {
      expect(IMPORTS[name], name).not.toContain("getAiSigningKey");
    }
  });

  it("only event/route.ts imports releaseAiNonce — scoped to event mode challenges", () => {
    expect(IMPORTS.event).toContain("releaseAiNonce");
    for (const name of DISCOVERED_ROUTES.filter((n) => n !== "event")) {
      expect(IMPORTS[name], name).not.toContain("releaseAiNonce");
    }
  });
});
