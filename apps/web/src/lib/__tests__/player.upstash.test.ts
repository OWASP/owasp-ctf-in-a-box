import { describe, expect, it, vi } from "vitest";
import type { BetterAuthOptions } from "better-auth";
import { authOptions } from "@/lib/auth";
import { redisAdapter } from "@/lib/auth-store/redis-adapter";
import { PLAYER_ID_RE, findPlayers, getPlayerProfiles } from "@/lib/player";
import { freshId, liveConfigured, liveKey } from "./live-redis";

vi.mock("server-only", () => ({}));

vi.hoisted(() => {
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef";
  process.env.GITHUB_CLIENT_ID ??= "test-client-id";
  process.env.GITHUB_CLIENT_SECRET ??= "test-client-secret";
});

describe.skipIf(!liveConfigured)("getPlayerProfiles against a live SRH proxy", () => {
  it("reads rows the adapter wrote and omits unknown ids", async () => {
    const prefix = liveKey("player", freshId("p"));
    const db = redisAdapter({ prefix })(authOptions as unknown as BetterAuthOptions);
    const mk = (login: string) =>
      db.create<{ id: string }>({
        model: "user",
        data: { name: login, email: `${login}@example.test`, emailVerified: true, image: null, login, createdAt: new Date(), updatedAt: new Date() },
      });
    const a = await mk("octo");
    const b = await mk("hubot");
    expect(PLAYER_ID_RE.test(a.id)).toBe(true);
    const ghost = crypto.randomUUID();
    const map = await getPlayerProfiles([a.id, b.id, ghost], prefix);
    expect(map.get(a.id)?.name).toBe("octo");
    expect(map.get(b.id)?.githubLogin).toBe("hubot");
    expect(map.has(ghost)).toBe(false);
  });
});

describe.skipIf(!liveConfigured)("findPlayers against a live SRH proxy", () => {
  it("finds rows the adapter wrote by a case-insensitive piece of the login", async () => {
    const prefix = liveKey("player", freshId("find"));
    const db = redisAdapter({ prefix })(authOptions as unknown as BetterAuthOptions);
    const mk = (login: string) =>
      db.create<{ id: string }>({
        model: "user",
        data: { name: login, email: `${login}@example.test`, emailVerified: true, image: null, login, createdAt: new Date(), updatedAt: new Date() },
      });
    const octo = await mk("OctoCat");
    await mk("hubot");
    const found = await findPlayers("octo", 20, prefix);
    expect(found.map((p) => p.id)).toEqual([octo.id]);
    expect(found[0].githubLogin).toBe("OctoCat");
  });
});
