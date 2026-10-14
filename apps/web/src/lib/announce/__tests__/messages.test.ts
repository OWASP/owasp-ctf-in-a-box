// Discord message builders (#590). Pure — no mocks. The structural
// invariants are what these pin: every message suppresses mentions, and the
// escape layer neutralises control characters, mention syntax AND Markdown
// (masked links included) in organizer/contestant-supplied text.

import { describe, expect, it } from "vitest";
import {
  buildDailyMessage,
  buildFirstBloodMessage,
  buildLeaderMessage,
  buildLifecycleMessage,
  buildReleaseMessage,
  buildTestMessage,
  escapeForDiscord,
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

  it("neutralises a masked link: a team named [text](https://…) cannot render as a clickable link", () => {
    const m = buildFirstBloodMessage({
      challengeTitle: "web-1",
      points: 10,
      who: "[Claim your prize](https://evil.example)",
      url: "https://example.test/flags/web-1",
    });
    const desc = m.embeds[0].description ?? "";
    // No Markdown link target survives, and the URL is unlinked outright.
    expect(desc).not.toMatch(/\[[^\]]*\]\(https?:\/\//);
    expect(desc).not.toMatch(/https?:\/\//);
    // The bracket/paren characters themselves are backslash-escaped, so even
    // the literal text cannot re-form a link after Discord renders it.
    expect(desc).toContain("\\[");
    expect(desc).toContain("\\]\\(");
  });

  it("backslash-escapes Markdown so untrusted text cannot reformat the announcement", () => {
    const escaped = escapeForDiscord("**bold** ||spoiler|| `code` ~~strike~~ >quote #hdr |pipe|");
    expect(escaped).toBe("\\*\\*bold\\*\\* \\|\\|spoiler\\|\\| \\`code\\` \\~\\~strike\\~\\~ \\>quote \\#hdr \\|pipe\\|");
  });

  it("does not leave half an escape pair when truncating", () => {
    // Every character escapes to two, so a naive slice lands on a backslash.
    const escaped = escapeForDiscord("*".repeat(300), 120);
    expect(escaped.length).toBeLessThanOrEqual(120);
    expect(escaped.endsWith("\\…")).toBe(false);
    expect(escaped.endsWith("…")).toBe(true);
  });

  it("leaves ordinary text (a normal team name) readable — no gratuitous escapes", () => {
    expect(escapeForDiscord("Team One")).toBe("Team One");
  });
});

describe("daily builder", () => {
  it("renders an empty board honestly and keeps the counts", () => {
    const m = buildDailyMessage({ day: "Oct 14", topTeams: [], solves: 3, releases: 1, timeLeft: "2h 0m" });
    expect(m.embeds[0].description).toContain("No teams");
    expect(m.embeds[0].fields?.map((f) => f.value)).toEqual(["3", "1", "2h 0m"]);
  });
});
