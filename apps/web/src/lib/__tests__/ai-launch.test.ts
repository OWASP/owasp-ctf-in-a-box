// The mint — the ONLY place a launch token is created, and therefore the
// place the gate-at-mint contract and the jti/replay-guard agreement both
// live. The jti assertion below is a MANDATORY carry-over from PR 2's review:
// the event route refuses any jti failing AI_JTI_RE, so a mint that drifts
// from the pattern presents as "every event is a replay" with no other
// symptom.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AI_PROGRESS_MAX, AI_TOKEN_TTL_SEC } from "@/lib/ai-defaults";
import { AI_JTI_RE } from "@/lib/ai-keys";
import { buildLaunchClaims } from "@/lib/ai-launch";
import { generateLaunchKeyPair, signLaunchToken, verifyLaunchToken } from "@/lib/ai-token";
import type { AiChallenge } from "@/lib/ai-store";

const NOW = 1_756_720_800; // 2026-09-01T11:20:00Z

const challenge = (over: Partial<AiChallenge> = {}): AiChallenge => ({
  id: "prompt-leak-ab12cd",
  title: "Prompt leak",
  category: "Injection",
  description: "Make it spill.",
  points: 300,
  order: 1,
  mode: "both",
  urlTemplate: "https://game.example.com/play?t={token}",
  ...over,
});

const viewer = (solved: Record<string, { points: number; at: string; source: "flag" | "event" }> = {}) => ({
  solved,
  attempts: {},
});

function claims(over: Parameters<typeof buildLaunchClaims>[0] extends infer T ? Partial<T> : never = {}) {
  return buildLaunchClaims({
    origin: "https://ctf.example.com",
    login: "alice",
    challenge: challenge(),
    challenges: [challenge(), challenge({ id: "guardrail-cd34ef", points: 400, order: 2 })],
    viewer: viewer({ "prompt-leak-ab12cd": { points: 300, at: "2026-09-01T10:00:00.000Z", source: "flag" } }),
    nowSec: NOW,
    ...over,
  });
}

describe("buildLaunchClaims", () => {
  it("names the box, the player and the challenge, with the spec TTL", () => {
    const c = claims();
    expect(c.iss).toBe("https://ctf.example.com");
    expect(c.sub).toBe("alice");
    expect(c.aud).toBe("prompt-leak-ab12cd");
    expect(c.iat).toBe(NOW);
    expect(c.exp).toBe(NOW + AI_TOKEN_TTL_SEC);
  });

  it("mints a jti the event route's replay guard will accept — MANDATORY", () => {
    const c = claims();
    expect(AI_JTI_RE.test(c.jti)).toBe(true);
    // And fresh per mint, or two launches share a replay slot.
    expect(claims().jti).not.toBe(c.jti);
  });

  it("carries the whole module's progress with solve-time detail", () => {
    expect(claims().ctf).toMatchObject({
      module: "ai",
      challenge: { id: "prompt-leak-ab12cd", title: "Prompt leak", points: 300 },
      points: 300,
      progress: [
        { id: "prompt-leak-ab12cd", points: 300, solved: true, solvedAt: "2026-09-01T10:00:00.000Z" },
        { id: "guardrail-cd34ef", points: 400, solved: false, solvedAt: null },
      ],
    });
    expect(claims().ctf.truncated).toBeUndefined();
  });

  it("caps progress at AI_PROGRESS_MAX, solved entries first, and says so", () => {
    const many = Array.from({ length: AI_PROGRESS_MAX + 10 }, (_, i) =>
      challenge({ id: `c-${String(i).padStart(3, "0")}`, order: i }),
    );
    const lastId = many[many.length - 1].id;
    const c = claims({
      challenge: many[0],
      challenges: many,
      viewer: viewer({ [lastId]: { points: 300, at: "2026-09-01T10:00:00.000Z", source: "event" } }),
    });
    expect(c.ctf.progress).toHaveLength(AI_PROGRESS_MAX);
    expect(c.ctf.truncated).toBe(true);
    // The one solved challenge survives the cut even though it sorts last.
    expect(c.ctf.progress.some((p) => p.id === lastId && p.solved)).toBe(true);
  });

  it("carries nothing secret — no flag, template, key or mode fields ride along", () => {
    const text = JSON.stringify(claims());
    for (const marker of ["flag", "urlTemplate", "signingKey", "privateKey", "mode"]) {
      expect(text).not.toContain(`"${marker}"`);
    }
  });

  it("round-trips through the real crypto and the real verifier", () => {
    const pair = generateLaunchKeyPair();
    const token = signLaunchToken(claims(), pair.privateKey);
    const verified = verifyLaunchToken(token, pair.publicKey, {
      audience: "prompt-leak-ab12cd",
      nowSec: NOW,
    });
    expect(verified.ok).toBe(true);
  });
});

describe("the preview claim (#464)", () => {
  it("is present only on a token minted for an admin preview", () => {
    expect(claims({ preview: true }).ctf.preview).toBe(true);
    expect("preview" in claims().ctf).toBe(false);
  });
});
