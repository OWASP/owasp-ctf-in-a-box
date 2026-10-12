// Shared HTTP plumbing for the ai module's four cross-origin routes. The
// CORS headers and the raw-body cap are pinned here rather than in each
// route's own test, so a route cannot drift from the contract by copying an
// older sibling.
import { describe, expect, it, vi } from "vitest";

import { AI_CORS_HEADERS, aiAwardResponse, aiJson, aiPreflight, aiRoute, readRawBody } from "@/lib/ai-http";
import { AI_EVENT_BODY_MAX } from "@/lib/ai-defaults";

const post = (body: string) => new Request("http://x/api/ai/event", { method: "POST", body });

const enc = new TextEncoder();

/** A `Request` stand-in exposing only what `readRawBody` touches: the headers
 *  and the body stream. Built by hand rather than with `new Request(...)`
 *  because the assertions below are about WHETHER the stream was read and how
 *  far — which a real undici body will not tell us — and because
 *  `Content-Length` cannot be set independently of the body on a real
 *  `Request`, so the "declared length lies" case is unreachable there. */
const fakeRequest = (body: ReadableStream<Uint8Array> | null, headers: Record<string, string> = {}) =>
  ({ headers: new Headers(headers), body }) as unknown as Request;

/** A body stream that records how many times `read()` was called and whether
 *  the reader was cancelled — the two facts the cap's cost is measured in. */
function readerSpy(chunks: Uint8Array[]) {
  const spy = {
    reads: 0,
    cancelled: false,
    stream: null as unknown as ReadableStream<Uint8Array>,
  };
  let i = 0;
  spy.stream = {
    getReader: () => ({
      read: async () => {
        spy.reads += 1;
        return i < chunks.length
          ? { done: false as const, value: chunks[i++] }
          : { done: true as const, value: undefined };
      },
      cancel: async () => {
        spy.cancelled = true;
      },
    }),
  } as unknown as ReadableStream<Uint8Array>;
  return spy;
}

describe("CORS", () => {
  it("allows any origin without ever allowing credentials", () => {
    // `Allow-Origin: *` together with `Allow-Credentials: true` is rejected by
    // browsers AND would invite a cookie these routes deliberately never read.
    expect(AI_CORS_HEADERS["Access-Control-Allow-Origin"]).toBe("*");
    expect(AI_CORS_HEADERS["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  it("advertises the headers a signed event actually sends", () => {
    const allowed = AI_CORS_HEADERS["Access-Control-Allow-Headers"].toLowerCase();
    for (const header of ["content-type", "authorization", "x-ctf-timestamp", "x-ctf-signature"]) {
      expect(allowed).toContain(header);
    }
  });

  it("exposes Retry-After, and nothing else, to cross-origin JS", () => {
    // Retry-After is not CORS-safelisted, so without this a browser reads
    // `null` off a 429/503 and gets no backoff hint despite the header being
    // on the wire. Pinned to exactly one value: a growing expose list is a
    // capability creeping onto a CORS `*` endpoint.
    expect(AI_CORS_HEADERS["Access-Control-Expose-Headers"]).toBe("Retry-After");
  });

  it("puts the CORS headers on every JSON response, error responses included", () => {
    const res = aiJson({ error: "invalid-token" }, 401);
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers a preflight with 204 and the allowed methods", async () => {
    const res = aiPreflight("POST, OPTIONS");
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(await res.text()).toBe("");
  });
});

describe("readRawBody", () => {
  it("returns the raw bytes alongside the parsed object", async () => {
    const raw = '{"token":"abc","flag":"CTF{x}"}';
    const res = await readRawBody(post(raw));
    expect(res).toEqual({ ok: true, raw, parsed: { token: "abc", flag: "CTF{x}" } });
  });

  it("preserves the raw bytes EXACTLY, whitespace and key order included", async () => {
    // The event route HMACs these bytes. Re-serializing the parsed object
    // would change them and break every real integrator's signature.
    const raw = '{ "b":2,\n  "a":1 }';
    const res = await readRawBody(post(raw));
    expect(res.ok && res.raw).toBe(raw);
  });

  it("refuses a body over the cap before parsing it", async () => {
    const raw = JSON.stringify({ token: "x".repeat(AI_EVENT_BODY_MAX) });
    expect(await readRawBody(post(raw))).toEqual({ ok: false, error: "too-large" });
  });

  it("measures the cap in BYTES, not characters", async () => {
    // A multi-byte body just under the cap in characters can be over it in
    // bytes; Redis and the HMAC both see bytes.
    const raw = JSON.stringify({ token: "€".repeat(Math.ceil(AI_EVENT_BODY_MAX / 2)) });
    expect(raw.length).toBeLessThan(AI_EVENT_BODY_MAX);
    expect(await readRawBody(post(raw))).toEqual({ ok: false, error: "too-large" });
  });

  it("accepts a body sitting EXACTLY on the cap", async () => {
    // The cap is a maximum, not an exclusive bound — an integrator who sized
    // a payload to the documented limit must not be refused. Pinned because
    // both gates below compare against it and an off-by-one in either turns
    // the documented size into a rejection.
    const raw = `{"token":"${"x".repeat(AI_EVENT_BODY_MAX - 12)}"}`;
    expect(Buffer.byteLength(raw, "utf8")).toBe(AI_EVENT_BODY_MAX);
    const res = await readRawBody(post(raw));
    expect(res.ok && res.raw).toBe(raw);
  });

  it("refuses an oversized Content-Length WITHOUT reading the stream", async () => {
    // This runs before the token check and before the rate limiter, so it is
    // the one thing an unauthenticated stranger can reach at will. A declared
    // length over the cap must cost nothing: no read, no buffer, no
    // allocation proportional to what was claimed.
    const spy = readerSpy([enc.encode("{}")]);
    const res = await readRawBody(
      fakeRequest(spy.stream, { "content-length": String(AI_EVENT_BODY_MAX + 1) }),
    );
    expect(res).toEqual({ ok: false, error: "too-large" });
    expect(spy.reads).toBe(0);
  });

  it("does NOT refuse a Content-Length sitting exactly on the cap", async () => {
    // The header gate's boundary, checked separately from the streaming one:
    // a real `new Request(...)` in Node exposes no `content-length` at all
    // (only a request off the wire does), so without a hand-built request
    // this comparison is never exercised and an off-by-one here would turn
    // the documented maximum into a refusal in production only.
    const raw = `{"token":"${"x".repeat(AI_EVENT_BODY_MAX - 12)}"}`;
    const spy = readerSpy([enc.encode(raw)]);
    const res = await readRawBody(
      fakeRequest(spy.stream, { "content-length": String(AI_EVENT_BODY_MAX) }),
    );
    expect(res.ok && res.raw).toBe(raw);
  });

  it("still measures a body whose Content-Length lies about being small", async () => {
    // The header is the caller's claim. A declared 2 bytes in front of a
    // 16KB stream must be caught by the streaming gate, not waved through.
    const chunk = enc.encode("x".repeat(1024));
    const spy = readerSpy(Array.from({ length: 16 }, () => chunk));
    const res = await readRawBody(fakeRequest(spy.stream, { "content-length": "2" }));
    expect(res).toEqual({ ok: false, error: "too-large" });
    expect(spy.cancelled).toBe(true);
  });

  it("refuses a chunked body with NO Content-Length once it crosses the cap mid-stream", async () => {
    // `Content-Length` is the caller's claim and a chunked request need not
    // make one, so the header gate alone is not a cap. The refusal must land
    // while the body is still arriving — the reader cancelled, the rest never
    // pulled — rather than after the whole thing is in memory.
    const chunk = enc.encode("x".repeat(1024));
    const spy = readerSpy(Array.from({ length: 32 }, () => chunk));
    const res = await readRawBody(fakeRequest(spy.stream));
    expect(res).toEqual({ ok: false, error: "too-large" });
    expect(spy.cancelled).toBe(true);
    // Nine reads: eight chunks fill the 8192-byte cap exactly, the ninth
    // crosses it. The remaining 23 are never pulled.
    expect(spy.reads).toBe(AI_EVENT_BODY_MAX / 1024 + 1);
  });

  it("still reports too-large when reader.cancel() itself rejects", async () => {
    // `cancel()` can reject per the Web Streams spec. An unguarded await on
    // it would send that rejection to the catch block below the cap check
    // and misreport a too-large body as invalid-json instead.
    const chunk = enc.encode("x".repeat(1024));
    let reads = 0;
    const stream = {
      getReader: () => ({
        read: async () => {
          const i = reads++;
          return i < 32
            ? { done: false as const, value: chunk }
            : { done: true as const, value: undefined };
        },
        cancel: async () => {
          throw new Error("cancel rejected");
        },
      }),
    } as unknown as ReadableStream<Uint8Array>;
    expect(await readRawBody(fakeRequest(stream))).toEqual({ ok: false, error: "too-large" });
  });

  it("refuses a body whose stream throws mid-read", async () => {
    // The old implementation caught `request.text()` rejecting; the streaming
    // read must refuse the same way rather than escaping as a throw the route
    // would have to turn into a 503.
    const stream = {
      getReader: () => ({
        read: async () => {
          throw new Error("socket reset");
        },
        cancel: async () => {},
      }),
    } as unknown as ReadableStream<Uint8Array>;
    expect(await readRawBody(fakeRequest(stream))).toEqual({ ok: false, error: "invalid-json" });
  });

  it("refuses a request with no body stream at all", async () => {
    expect(await readRawBody(fakeRequest(null))).toEqual({ ok: false, error: "invalid-json" });
  });

  it("refuses malformed JSON and a non-object body", async () => {
    expect(await readRawBody(post("{not json"))).toEqual({ ok: false, error: "invalid-json" });
    expect(await readRawBody(post('"a string"'))).toEqual({ ok: false, error: "invalid-json" });
    expect(await readRawBody(post("null"))).toEqual({ ok: false, error: "invalid-json" });
  });
});

describe("aiAwardResponse", () => {
  it("maps a wrong-mode refusal to 409, the same status the routes use for their own pre-check", async () => {
    // `AWARD_SCRIPT` refuses a signed event against a flag-only challenge on
    // its own, even if a route's mode check missed it — this is that path
    // reaching the wire.
    const res = aiAwardResponse({ ok: false, reason: "wrong-mode" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "wrong-mode" });
  });

  it("maps a spent attempt budget to 403 exhausted — no retry time, nothing about the flag", async () => {
    const res = aiAwardResponse({ ok: false, reason: "exhausted" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "exhausted" });
  });

  it("carries dryRun through a correct-solve result without altering its status", async () => {
    const res = aiAwardResponse({ ok: true, correct: true, points: 0, dryRun: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ correct: true, points: 0, already: false, dryRun: true });
  });
});

describe("aiRoute", () => {
  it("passes a handler's own response through untouched", async () => {
    // The wrapper converts THROWN errors only. A handler that decided is a
    // handler whose decision reaches the wire byte for byte.
    const handler = vi.fn(async () => aiJson({ error: "invalid-token" }, 401));
    const res = await aiRoute(handler)();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid-token" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("forwards every argument to the handler", async () => {
    const handler = vi.fn(async (request: Request) => aiJson({ url: request.url }));
    const request = new Request("http://x/api/ai/state");
    const res = await aiRoute(handler)(request);
    expect(handler).toHaveBeenCalledWith(request);
    expect(await res.json()).toEqual({ url: "http://x/api/ai/state" });
  });

  it("turns a thrown store failure into 503 unavailable WITH the CORS headers", async () => {
    // `upstashPipeline` throws on any non-2xx or transport failure. Uncaught,
    // Next answers 500 with no CORS headers at all — so a browser integrator's
    // fetch fails at the CORS layer with no readable status and the outage
    // reads as "your CORS is broken".
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await aiRoute(async () => {
        throw new Error("Upstash pipeline failed: 500");
      })();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "unavailable" });
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("catches a synchronous throw and a non-Error rejection alike", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sync = await aiRoute((): Response => {
        throw new Error("boom");
      })();
      expect(sync.status).toBe(503);

      // A rejected promise can be an arbitrary value, not an `Error`.
      const nonError = await aiRoute(() => Promise.reject("CTF{thrown-string}"))();
      expect(nonError.status).toBe(503);
      expect(await nonError.json()).toEqual({ error: "unavailable" });
    } finally {
      spy.mockRestore();
    }
  });

  it("logs a redacted label — never the error object, whose fields can carry the flag", async () => {
    // Same danger as `ai-store.ts`'s `errorLabel`: the award path's Redis ARGV
    // carries the submitted flag AND its comparison form, so a driver that
    // decorates its rejection with the failed request turns one
    // `console.error(err)` into the event's flags in the log.
    const FLAG = "CTF{do-not-log-me}";
    const decorated = Object.assign(new Error("Upstash pipeline failed: ERR timeout"), {
      command: ["EVAL", "...", FLAG],
      cause: new Error(`while sending ${FLAG}`),
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await aiRoute(async () => Promise.reject(decorated))()).status).toBe(503);

      // Anti-vacuous: the failure really did reach the logger, and said so.
      expect(spy).toHaveBeenCalledTimes(1);
      const logged = spy.mock.calls[0] as unknown[];
      expect(String(logged[0])).toContain("ai route: unhandled failure");
      expect(logged.some((arg) => arg instanceof Error)).toBe(false);
      const rendered = logged.map((arg) => JSON.stringify(arg)).join(" ");
      expect(rendered).not.toContain(FLAG);
      // What IS kept: enough to tell one failure from another.
      expect(rendered).toContain("ERR timeout");
    } finally {
      spy.mockRestore();
    }
  });

  it("never renders a thrown STRING, which could itself be the flag", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await aiRoute(() => Promise.reject("CTF{a-thrown-flag}"))();
      const rendered = (spy.mock.calls[0] as unknown[]).map((arg) => JSON.stringify(arg)).join(" ");
      expect(rendered).not.toContain("CTF{a-thrown-flag}");
      expect(rendered).toContain("non-Error throw");
    } finally {
      spy.mockRestore();
    }
  });
});
