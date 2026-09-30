// Read paths for the ai store — and above all, the secrecy boundary. Four
// SECRET hashes hang off this module (`ctf:ai:flag`, `ctf:ai:flagnorm`,
// `ctf:ai:hints`, `ctf:ai:signkey`) plus one secret string
// (`ctf:ai:launchkey`), and the launch key's PRIVATE half is the worst of the
// five to leak: an event signing key lets its holder assert solves on one
// challenge for players who already hold a box-minted token, but the launch
// private key mints identity itself and can name anybody. The contestant path
// must issue no command that even NAMES those keys.
//
// Authoring (upsert/rotate/delete) lives in ai-store.authoring.test.ts and
// grading in ai-store.grade.test.ts — the latter needs a partial
// `@/lib/admin-store` mock, and forcing all three into one file would mean a
// compromised mock for all of them.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upstashEval: vi.fn(), upstashPipeline: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashEval: mocks.upstashEval, upstashPipeline: mocks.upstashPipeline }));

import {
  claimAiNonce,
  getAiLaunchKeys,
  getAiLaunchPublicKey,
  getAiSigningKey,
  getAiSolveCounts,
  getAiTotals,
  getTeamAiTotalsBatch,
  getViewerAi,
  listAiCategories,
  listAiChallenges,
  listAiChallengesForAdmin,
  releaseAiNonce,
} from "@/lib/ai-store";
import { AI_NONCE_TTL_SEC } from "@/lib/ai-defaults";

const pipelineCalls = (): (string | number)[][][] =>
  mocks.upstashPipeline.mock.calls.map((call) => call[0] as (string | number)[][]);

/** Every key name a contestant-facing read must never touch. */
const SECRET_KEYS = ["ctf:ai:flag", "ctf:ai:flagnorm", "ctf:ai:hints", "ctf:ai:signkey", "ctf:ai:launchkey"];

/** A stand-in for the launch private key, in the poisoned-record tests. Any
 *  contestant payload containing this string is a critical bug. */
const LEAKED_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----leak-----END PRIVATE KEY-----";

const CHALLENGE = {
  id: "prompt-leak-ab12cd",
  title: "Prompt leak",
  category: "Injection",
  description: "Make it spill.",
  points: 300,
  order: 1,
  mode: "both",
  urlTemplate: "https://game.example.com/play?t={token}",
};

beforeEach(() => {
  mocks.upstashPipeline.mockReset();
  mocks.upstashEval.mockReset();
});

describe("listAiChallenges", () => {
  it("returns public-safe records in board order and touches no secret key", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      {
        result: [
          "guardrail-cd34ef",
          JSON.stringify({ ...CHALLENGE, id: "guardrail-cd34ef", title: "Guardrail", points: 400, order: 2 }),
          CHALLENGE.id,
          JSON.stringify(CHALLENGE),
        ],
      },
    ]);

    const rows = await listAiChallenges();

    expect(rows.map((c) => c.id)).toEqual(["prompt-leak-ab12cd", "guardrail-cd34ef"]);
    expect(rows[0]).toEqual(CHALLENGE);
    const named = JSON.stringify(pipelineCalls());
    for (const key of SECRET_KEYS) expect(named).not.toContain(key);
  });

  it("strips secrets that were stored INSIDE the challenge record — the poisoned-record leak test", async () => {
    // Naming no secret key proves the outgoing commands are clean; it says
    // nothing about the returned payload. Someone simplifying parseChallenge to
    // `return parsed as AiChallenge` (the type checks above it look redundant)
    // would flow a poisoned record straight into /ai's payload with every other
    // test still green. This is the test that notices.
    const poisoned = JSON.stringify({
      ...CHALLENGE,
      flag: "CTF{leak}",
      flagnorm: "ctf{leak}",
      hint: "Try asking twice.",
      signingKey: "aik_secret",
      launchPrivateKey: LEAKED_PRIVATE_KEY,
    });
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: [CHALLENGE.id, poisoned] }]);

    const rows = await listAiChallenges();

    expect(rows).toEqual([CHALLENGE]);
    expect(Object.keys(rows[0]).sort()).toEqual(Object.keys(CHALLENGE).sort());
    const payload = JSON.stringify(rows);
    for (const secret of ["CTF{leak}", "ctf{leak}", "aik_secret", "Try asking twice.", LEAKED_PRIVATE_KEY]) {
      expect(payload).not.toContain(secret);
    }
  });

  it("drops an unparseable or mode-less record rather than rendering a broken tile", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: ["bad-1", "{not json", "bad-2", JSON.stringify({ ...CHALLENGE, mode: "nope" }), CHALLENGE.id, JSON.stringify(CHALLENGE)] },
    ]);
    expect((await listAiChallenges()).map((c) => c.id)).toEqual([CHALLENGE.id]);
  });
});

describe("listAiChallengesForAdmin", () => {
  it("returns the flag, hint and signing key in their own fields, nested off the public record", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: [CHALLENGE.id, JSON.stringify(CHALLENGE)] },
      { result: [CHALLENGE.id, "CTF{leak}"] },
      { result: [CHALLENGE.id, "Try asking twice."] },
      { result: [CHALLENGE.id, "aik_secret"] },
    ]);

    const rows = await listAiChallengesForAdmin();

    expect(rows).toEqual([
      { challenge: CHALLENGE, flag: "CTF{leak}", hint: "Try asking twice.", signingKey: "aik_secret" },
    ]);
    // Reads every hash in ONE pipeline, so the four come from one instant.
    expect(pipelineCalls()).toHaveLength(1);
  });

  it("reports a challenge with no key or flag rather than inventing either", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: [CHALLENGE.id, JSON.stringify(CHALLENGE)] },
      { result: [] },
      { result: [] },
      { result: [] },
    ]);
    expect(await listAiChallengesForAdmin()).toEqual([
      { challenge: CHALLENGE, flag: "", hint: null, signingKey: "" },
    ]);
  });
});

describe("getAiSigningKey", () => {
  it("reads ONE field of ONE hash — never the other three secrets", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "aik_secret" }]);

    expect(await getAiSigningKey(CHALLENGE.id)).toBe("aik_secret");

    // The whole point of this function over listAiChallengesForAdmin: a route
    // that needs one key must not pull every flag and every key in the event
    // into a request handler that answers the public internet.
    expect(pipelineCalls()).toEqual([[["HGET", "ctf:ai:signkey", CHALLENGE.id]]]);
    const named = JSON.stringify(pipelineCalls());
    for (const key of ["ctf:ai:flag", "ctf:ai:flagnorm", "ctf:ai:hints", "ctf:ai:challenges", "ctf:ai:launchkey"]) {
      expect(named).not.toContain(key);
    }
  });

  it("returns null — never '' — for a missing row, a non-string reply or a bad id", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: null }]);
    expect(await getAiSigningKey(CHALLENGE.id)).toBeNull();

    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }]);
    expect(await getAiSigningKey(CHALLENGE.id)).toBeNull();

    // An empty stored key is a KEYLESS row, not a usable key: ai-token.ts
    // throws on "" precisely because an empty HMAC key is guessable.
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "" }]);
    expect(await getAiSigningKey(CHALLENGE.id)).toBeNull();

    expect(await getAiSigningKey("bad id!")).toBeNull();
    expect(pipelineCalls()).toHaveLength(3); // the bad id cost no round trip
  });
});

describe("getAiLaunchKeys", () => {
  const PAIR = { publicKey: "-----BEGIN PUBLIC KEY-----stored", privateKey: "-----BEGIN PRIVATE KEY-----stored" };

  /** Replies to the first `GET ctf:ai:launchkey`. */
  function storedReply(result: unknown) {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result }]);
  }
  /** Replies to the mint pipeline: `SET ... NX` then `GET`, in that order.
   *  `persisted` is what the GET reads back — the value that actually WON,
   *  which may not be this caller's candidate. `null` means this caller's own
   *  SET NX won, so the GET echoes the candidate it just planted; a real
   *  pipeline runs both commands against the same key in order, and a fixture
   *  that replied `null` there would model a Redis that forgets a write it just
   *  accepted — letting a caller-side fallback pass for correct. */
  function mintReply(persisted: string | null) {
    mocks.upstashPipeline.mockImplementationOnce(async (commands: (string | number)[][]) => [
      { result: persisted === null ? "OK" : null },
      { result: persisted ?? String(commands[0][2]) },
    ]);
  }

  it("returns a stored pair without minting or writing anything", async () => {
    storedReply(JSON.stringify(PAIR));

    expect(await getAiLaunchKeys()).toEqual(PAIR);

    // ONE round trip, and no SET anywhere in it. A read that rewrote the key
    // would rotate the module's identity on every page render.
    expect(pipelineCalls()).toEqual([[["GET", "ctf:ai:launchkey"]]]);
  });

  it("mints an Ed25519 pair on first use with SET NX, and returns the PERSISTED value", async () => {
    storedReply(null);
    mintReply(null);

    const pair = await getAiLaunchKeys();

    expect(pair.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(pair.publicKey).toContain("BEGIN PUBLIC KEY");
    const [, mint] = pipelineCalls();
    // NX in the SAME pipeline as the read-back: claim-or-lose in one round
    // trip, then read whichever pair actually won.
    expect(mint[0][0]).toBe("SET");
    expect(mint[0][1]).toBe("ctf:ai:launchkey");
    expect(mint[0][3]).toBe("NX");
    expect(mint[1]).toEqual(["GET", "ctf:ai:launchkey"]);
    expect(JSON.parse(String(mint[0][2]))).toEqual(pair);
  });

  it("converges on the WINNER's pair when two mints race, never on its own candidate", async () => {
    // The losing racer: its SET NX was a no-op, and the pair it generated
    // locally was never persisted. Returning that candidate would have the box
    // minting tokens signed with a private key whose public half it does not
    // publish — every one of them failing verification, with nothing saying why.
    const winner = { publicKey: "-----BEGIN PUBLIC KEY-----winner", privateKey: "-----BEGIN PRIVATE KEY-----winner" };
    storedReply(null);
    mintReply(JSON.stringify(winner));

    const pair = await getAiLaunchKeys();

    expect(pair).toEqual(winner);
    // And specifically NOT the candidate this call generated and offered.
    const candidate = JSON.parse(String(pipelineCalls()[1][0][2])) as typeof winner;
    expect(candidate.privateKey).not.toBe(pair.privateKey);
  });

  it("throws rather than returning a pair the read-back could not confirm", async () => {
    storedReply(null);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "OK" }, { error: "ERR down" }]);
    await expect(getAiLaunchKeys()).rejects.toThrow(/GET failed/i);

    storedReply(null);
    mintReply("{not json");
    await expect(getAiLaunchKeys()).rejects.toThrow(/no usable ai launch keypair/i);

    // A half-record is no better than none: a pair missing either half cannot
    // both mint and be verified against.
    storedReply(null);
    mintReply(JSON.stringify({ publicKey: PAIR.publicKey }));
    await expect(getAiLaunchKeys()).rejects.toThrow(/no usable ai launch keypair/i);
  });

  it("refuses to overwrite a stored-but-corrupt record", async () => {
    // Minting over it would invalidate every launch token already sitting in a
    // contestant's browser, mid-event, silently.
    storedReply("{not json");
    await expect(getAiLaunchKeys()).rejects.toThrow(/refusing to overwrite/i);
    expect(pipelineCalls()).toHaveLength(1);
  });

  it("surfaces a failed initial read instead of minting a second keypair over it", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "ERR down" }]);
    await expect(getAiLaunchKeys()).rejects.toThrow(/GET failed/i);
    expect(pipelineCalls()).toHaveLength(1);
  });
});

describe("getAiLaunchPublicKey", () => {
  it("hands back the public half ALONE — the private half never leaves the store", async () => {
    const PAIR = { publicKey: "-----BEGIN PUBLIC KEY-----ok", privateKey: "-----BEGIN PRIVATE KEY-----secret" };
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(PAIR) }]);

    const published = await getAiLaunchPublicKey();

    // A future route serves this verbatim, so the assertion is on the returned
    // VALUE, not on a field name: returning the whole record (or the private
    // key by mistake) is the failure this catches.
    expect(published).toBe(PAIR.publicKey);
    expect(typeof published).toBe("string");
    expect(published).not.toContain("PRIVATE");
    expect(published).not.toContain(PAIR.privateKey);
  });
});

describe("claimAiNonce", () => {
  // This is the single check between a captured signed request and unlimited
  // re-awards, so it fails CLOSED — the deliberate opposite of the pause gate.
  it("claims a fresh jti atomically with SET NX EX", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "OK" }]);

    expect(await claimAiNonce("jti-1")).toBe(true);

    const [[cmd]] = pipelineCalls();
    expect(cmd[0]).toBe("SET");
    expect(cmd[1]).toBe("ctf:ai:nonce:jti-1");
    // NX (claim-or-lose in ONE round trip; a GET-then-SET would let two copies
    // of the same captured request both see "not seen yet") and a TTL.
    expect(cmd.slice(3)).toEqual(["NX", "EX", AI_NONCE_TTL_SEC]);
  });

  it("refuses a replay — a null reply means someone else already claimed it", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: null }]);
    expect(await claimAiNonce("jti-1")).toBe(false);
  });

  it("fails CLOSED when Redis throws", async () => {
    mocks.upstashPipeline.mockRejectedValueOnce(new Error("redis down"));
    expect(await claimAiNonce("jti-1")).toBe(false);
  });

  it("fails CLOSED on a per-command error", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "ERR syntax" }]);
    expect(await claimAiNonce("jti-1")).toBe(false);
  });

  it("fails CLOSED on any reply it does not recognise", async () => {
    for (const result of [1, "ok", true, {}, [], undefined]) {
      mocks.upstashPipeline.mockResolvedValueOnce([{ result }]);
      expect(await claimAiNonce("jti-1")).toBe(false);
    }
  });

  it("refuses an empty or non-string jti without a round trip", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await claimAiNonce("")).toBe(false);
      expect(await claimAiNonce(undefined as unknown as string)).toBe(false);
      expect(pipelineCalls()).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a jti that is not a plain short token, before any Redis call", async () => {
    // The jti arrives inside a request body and becomes part of a Redis key
    // name. Unbounded input there is an unbounded key.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const bad of ["", "x".repeat(129), "has space", "colon:sep", "sl/ash"]) {
        expect(await claimAiNonce(bad)).toBe(false);
      }
      expect(pipelineCalls()).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("SAYS SO when it refuses a malformed jti, without logging the value", async () => {
    // If a future minter's jti alphabet ever drifts from `AI_JTI_RE`, the only
    // other symptom is "every event is a replay" with no diagnostic at all.
    // The value itself stays out of the log: it is caller-supplied.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await claimAiNonce("has space")).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
      const logged = spy.mock.calls[0] as unknown[];
      expect(String(logged[0])).toContain("malformed jti");
      expect(logged.map((arg) => JSON.stringify(arg)).join(" ")).not.toContain("has space");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("releaseAiNonce", () => {
  // Gives a claimed jti back when the award it guarded did NOT land. The nonce
  // only ever needed to stop the replay of an award that HAPPENED, and a spent
  // jti otherwise turns the integrator's retry — standard on a 5xx — into
  // `409 replay` forever, with one token per launch to spend.
  it("deletes exactly the nonce key for that jti", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }]);

    await releaseAiNonce("jti-1");

    expect(pipelineCalls()).toEqual([[["DEL", "ctf:ai:nonce:jti-1"]]]);
  });

  it("names no secret key while doing it", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }]);
    await releaseAiNonce("jti-1");
    const rendered = JSON.stringify(pipelineCalls());
    for (const key of SECRET_KEYS) expect(rendered).not.toContain(key);
  });

  it("NEVER throws — the caller is already answering a refusal", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.upstashPipeline.mockRejectedValueOnce(new Error("redis down"));
      await expect(releaseAiNonce("jti-1")).resolves.toBeUndefined();

      mocks.upstashPipeline.mockResolvedValueOnce([{ error: "ERR syntax" }]);
      await expect(releaseAiNonce("jti-1")).resolves.toBeUndefined();

      // Anti-vacuous: both failures really did reach the logger, and neither
      // handed it the error object — whose own fields carry the failed command.
      expect(spy).toHaveBeenCalledTimes(2);
      for (const call of spy.mock.calls as unknown[][]) {
        expect(String(call[0])).toContain("release failed");
        expect(call.some((arg) => arg instanceof Error)).toBe(false);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a malformed or non-string jti before any Redis call", async () => {
    // Same `AI_JTI_RE` guard as the claim, same reason: the value becomes part
    // of a key name, so an unbounded one is an unbounded key.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const bad of ["", "x".repeat(129), "has space", "colon:sep", "sl/ash"]) {
        await releaseAiNonce(bad);
      }
      await releaseAiNonce(undefined as unknown as string);
      expect(pipelineCalls()).toHaveLength(0);
      const rendered = spy.mock.calls.flat().map((arg) => JSON.stringify(arg)).join(" ");
      expect(rendered).not.toContain("has space");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("listAiCategories", () => {
  it("reads the organizer's order, and an absent value is an empty board", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Injection", "Jailbreak"]) }]);
    expect(await listAiCategories()).toEqual(["Injection", "Jailbreak"]);

    mocks.upstashPipeline.mockResolvedValueOnce([{ result: null }]);
    expect(await listAiCategories()).toEqual([]);
  });
});

describe("getViewerAi", () => {
  it("returns solves and attempts for one login, keeping the solve source", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: [CHALLENGE.id, JSON.stringify({ points: 300, at: "2026-08-31T11:00:00.000Z", source: "event" })] },
      { result: [CHALLENGE.id, JSON.stringify({ attempts: 2, lastAt: "2026-08-31T11:02:00.000Z" })] },
    ]);

    expect(await getViewerAi("alice")).toEqual({
      solved: { [CHALLENGE.id]: { points: 300, at: "2026-08-31T11:00:00.000Z", source: "event" } },
      attempts: { [CHALLENGE.id]: { attempts: 2, lastAt: "2026-08-31T11:02:00.000Z" } },
    });
    expect(pipelineCalls()[0]).toEqual([
      ["HGETALL", "ctf:ai:solves:alice"],
      ["HGETALL", "ctf:ai:attempts:alice"],
    ]);
  });

  it("strips secrets a poisoned solve or attempt row carries", async () => {
    // A solve row is written by AWARD_SCRIPT, but the archive import (#155)
    // writes them too, so a hand-edited bundle can plant extra fields here.
    mocks.upstashPipeline.mockResolvedValueOnce([
      {
        result: [
          CHALLENGE.id,
          JSON.stringify({
            points: 300,
            at: "2026-08-31T11:00:00.000Z",
            source: "event",
            flag: "CTF{leak}",
            launchPrivateKey: LEAKED_PRIVATE_KEY,
          }),
        ],
      },
      {
        result: [
          CHALLENGE.id,
          JSON.stringify({ attempts: 2, lastAt: "2026-08-31T11:02:00.000Z", signingKey: "aik_secret" }),
        ],
      },
    ]);

    const viewer = await getViewerAi("alice");

    expect(Object.keys(viewer.solved[CHALLENGE.id]).sort()).toEqual(["at", "points", "source"]);
    expect(Object.keys(viewer.attempts[CHALLENGE.id]).sort()).toEqual(["attempts", "lastAt"]);
    const payload = JSON.stringify(viewer);
    expect(payload).not.toContain("CTF{leak}");
    expect(payload).not.toContain("aik_secret");
    expect(payload).not.toContain(LEAKED_PRIVATE_KEY);
  });

  it("defaults a legacy solve row with no source to the graded path", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: [CHALLENGE.id, JSON.stringify({ points: 300, at: "2026-08-31T11:00:00.000Z" })] },
      { result: [] },
    ]);
    expect((await getViewerAi("alice")).solved[CHALLENGE.id].source).toBe("flag");
  });
});

describe("totals", () => {
  it("folds the two aggregate hashes into per-login totals", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: ["alice", "700", "bob", "300"] },
      { result: ["alice", "2", "bob", "1"] },
      { result: ["bob", "2026-10-01T12:00:00.000Z"] },
    ]);
    expect(await getAiTotals()).toEqual(
      new Map([
        ["alice", { points: 700, solved: 2, lastAt: null }],
        ["bob", { points: 300, solved: 1, lastAt: "2026-10-01T12:00:00.000Z" }],
      ]),
    );
    expect(mocks.upstashPipeline.mock.calls[0][0]).toContainEqual(["HGETALL", "ctf:ai:lastAt"]);
  });

  it("counts distinct solvers per challenge", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: [CHALLENGE.id, "4"] }]);
    expect(await getAiSolveCounts()).toEqual(new Map([[CHALLENGE.id, 4]]));
  });

  it("unions a team's solves instead of summing member aggregates", async () => {
    const solve = JSON.stringify({ points: 300, at: "2026-08-31T11:00:00.000Z" });
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: [CHALLENGE.id, solve] },
      { result: [CHALLENGE.id, solve] },
    ]);
    const [team] = await getTeamAiTotalsBatch([["alice", "bob"]]);
    expect(team.points).toBe(300);
    expect(team.solved).toBe(1);
  });

  it("costs zero round trips for an empty team list", async () => {
    expect(await getTeamAiTotalsBatch([[]])).toEqual([{ points: 0, solved: 0, lastAt: null, itemIds: [] }]);
    expect(pipelineCalls()).toHaveLength(0);
  });
});
