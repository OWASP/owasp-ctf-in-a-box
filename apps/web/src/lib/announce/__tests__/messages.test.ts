// Discord message builders (#590). Pure — no mocks. The two structural
// invariants are what these pin: every message suppresses mentions, and the
// escape layer neutralises control characters and mention syntax in
// organizer/contestant-supplied text.

import { describe, expect, it } from "vitest";
import {
  buildDailyMessage,
  buildFirstBloodMessage,
  buildLeaderMessage,
  buildLifecycleMessage,
  buildReleaseMessage,
  buildTestMessage,
  type DiscordMessage,
} from "@/lib/announce/messages";

const all = (): DiscordMessage[] => [
  buildTestMessage("Test Event"),
  buildReleaseMessage({ title: "T", category: "C", points: 100, url: "https://x/flags/t" }),
  buildFirstBloodMessage({ challengeTitle: "T", points: 100, who: "who", url: "https://x/flags/t" }),
  buildLeaderMessage({ scope: "first", leader: { name: "a", points: 1 } }),
  buildLeaderMessage({ scope: "top3", leader: { name: "a", points: 1 }, runnersUp: [{ name: "b", points: 0 }] }),
  buildLifecycleMessage({ kind: "launch", eventName: "E" }),
  buildLifecycleMessage({ kind: "pause", eventName: "E" }),
  buildLifecycleMessage({ kind: "resume", eventName: "E" }),
  buildLifecycleMessage({ kind: "registration-closed", eventName: "E" }),
  buildLifecycleMessage({ kind: "milestone", eventName: "E", timeLeft: "1h 0m" }),
  buildDailyMessage({ day: "Oct 14", topTeams: [], solves: 0, releases: 0, timeLeft: null }),
];

describe("builders", () => {
  it("every message suppresses ALL mentions, structurally", () => {
    for (const message of all()) {
      expect(message.allowed_mentions).toEqual({ parse: [] });
    }
  });

  it("every message carries at least one embed", () => {
    for (const message of all()) expect(message.embeds.length).toBeGreaterThan(0);
  });
});

describe("escapeForDiscord", () => {
  it("neutralises @everyone and @here with a zero-width space", () => {
    const m = buildFirstBloodMessage({ challengeTitle: "@everyone look", points: 1, who: "@here", url: "u" });
    const text = JSON.stringify(m);
    expect(text).not.toMatch(/@everyone/);
    expect(text).not.toMatch(/@here/);
  });

  it("neutralises raw user/role/channel mention syntax", () => {
    const m = buildFirstBloodMessage({ challengeTitle: "hi <@123> <#456> <@&789>", points: 1, who: "w", url: "u" });
    const text = JSON.stringify(m);
    expect(text).not.toContain("<@123>");
    expect(text).not.toContain("<#456>");
    expect(text).not.toContain("<@&789>");
  });

  it("strips control characters and caps length", () => {
    const nul = String.fromCharCode(0);
    const m = buildReleaseMessage({ title: `a${nul}b${"x".repeat(300)}`, category: "c", points: 1, url: "u" });
    const desc = m.embeds[0].description ?? "";
    expect(desc).not.toContain(nul);
    expect(desc.length).toBeLessThanOrEqual(121);
  });
});

describe("daily builder", () => {
  it("renders an empty board honestly and keeps the counts", () => {
    const m = buildDailyMessage({ day: "Oct 14", topTeams: [], solves: 3, releases: 1, timeLeft: "2h 0m" });
    expect(m.embeds[0].description).toContain("No teams");
    expect(m.embeds[0].fields?.map((f) => f.value)).toEqual(["3", "1", "2h 0m"]);
  });
});
