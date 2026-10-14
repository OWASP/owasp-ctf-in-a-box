// Discord announcement config validation (#590). Pure leaf, so these run
// without mocks — the point is that the SSRF boundary (Discord hosts only,
// https only, webhook path shape) and every field limit are pinned exactly
// as the store and the /admin section rely on them.

import { describe, expect, it } from "vitest";
import {
  DISCORD_DEFAULTS,
  ANNOUNCEMENT_KINDS,
  checkDailyAt,
  checkDailyTopN,
  checkDiscordWebhookUrl,
  checkLeaderScope,
  isAnnouncementKind,
  kindEnabled,
  parseMarks,
  type DiscordPublicConfig,
} from "@/lib/discord-config";

const config = (over: Partial<DiscordPublicConfig> = {}): DiscordPublicConfig => ({
  webhookConfigured: false,
  releases: false,
  firstBlood: false,
  leaders: false,
  leaderScope: "first",
  launch: false,
  pause: false,
  registration: false,
  milestones: false,
  marks: DISCORD_DEFAULTS.marks,
  daily: false,
  dailyAt: DISCORD_DEFAULTS.dailyAt,
  dailyTopN: DISCORD_DEFAULTS.dailyTopN,
  ...over,
});

describe("checkDiscordWebhookUrl", () => {
  const valid = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz012345";

  it("accepts a discord.com webhook URL", () => {
    const r = checkDiscordWebhookUrl(valid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.startsWith("https://discord.com/api/webhooks/")).toBe(true);
  });

  it("accepts the discordapp.com and ptb/canary hosts", () => {
    expect(checkDiscordWebhookUrl(valid.replace("discord.com", "discordapp.com")).ok).toBe(true);
    expect(checkDiscordWebhookUrl(valid.replace("discord.com", "ptb.discord.com")).ok).toBe(true);
    expect(checkDiscordWebhookUrl(valid.replace("discord.com", "canary.discord.com")).ok).toBe(true);
  });

  it("refuses a non-Discord host (the SSRF boundary)", () => {
    const r = checkDiscordWebhookUrl("https://evil.example/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz012345");
    expect(r.ok).toBe(false);
  });

  it("refuses plain http", () => {
    expect(checkDiscordWebhookUrl(valid.replace("https://", "http://")).ok).toBe(false);
  });

  it("refuses an invite or channel URL", () => {
    expect(checkDiscordWebhookUrl("https://discord.com/channels/1/2/3").ok).toBe(false);
    expect(checkDiscordWebhookUrl("https://discord.gg/abcdef").ok).toBe(false);
  });

  it("refuses credentials, query strings and fragments", () => {
    expect(checkDiscordWebhookUrl(`https://user:pass@discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz012345`).ok).toBe(false);
    expect(checkDiscordWebhookUrl(`${valid}?wait=true`).ok).toBe(false);
    expect(checkDiscordWebhookUrl(`${valid}#x`).ok).toBe(false);
  });

  it("refuses control characters and over-long values", () => {
    expect(checkDiscordWebhookUrl(`${valid}\n`).ok).toBe(false);
    expect(checkDiscordWebhookUrl("https://discord.com/api/webhooks/123456789012345678/".padEnd(1100, "a")).ok).toBe(false);
  });

  it("refuses non-strings and empties", () => {
    expect(checkDiscordWebhookUrl(undefined).ok).toBe(false);
    expect(checkDiscordWebhookUrl(42).ok).toBe(false);
    expect(checkDiscordWebhookUrl("").ok).toBe(false);
  });
});

describe("parseMarks", () => {
  it("accepts an empty marks field as no marks", () => {
    expect(parseMarks("")).toEqual({ ok: true, marks: [] });
    expect(parseMarks("  ")).toEqual({ ok: true, marks: [] });
  });

  it("parses, dedupes and sorts marks", () => {
    expect(parseMarks("2h, 15m, 2h, 1d")).toEqual({ ok: true, marks: [900_000, 7_200_000, 86_400_000] });
  });

  it("refuses malformed, too-small, too-large and too-many marks", () => {
    expect(parseMarks("soon").ok).toBe(false);
    expect(parseMarks("30s").ok).toBe(false);
    expect(parseMarks("8d").ok).toBe(false);
    expect(parseMarks(Array.from({ length: 11 }, () => "1m").join(",")).ok).toBe(false);
  });
});

describe("checkDailyAt / checkDailyTopN / checkLeaderScope", () => {
  it("accepts HH:MM and refuses everything else", () => {
    expect(checkDailyAt("09:00")).toEqual({ ok: true, value: "09:00" });
    expect(checkDailyAt("9:00").ok).toBe(false);
    expect(checkDailyAt("24:00").ok).toBe(false);
  });

  it("bounds top N to [1, 50]", () => {
    expect(checkDailyTopN(10)).toEqual({ ok: true, value: 10 });
    expect(checkDailyTopN(0).ok).toBe(false);
    expect(checkDailyTopN(51).ok).toBe(false);
    expect(checkDailyTopN(1.5).ok).toBe(false);
  });

  it("accepts first/top3 only", () => {
    expect(checkLeaderScope("first")).toEqual({ ok: true, value: "first" });
    expect(checkLeaderScope("top3")).toEqual({ ok: true, value: "top3" });
    expect(checkLeaderScope("all").ok).toBe(false);
  });
});

describe("kindEnabled / isAnnouncementKind", () => {
  it("maps every kind to its own switch, with pause covering resume", () => {
    const on = config({ releases: true, firstBlood: true, leaders: true, launch: true, pause: true, registration: true, milestones: true, daily: true });
    for (const kind of ANNOUNCEMENT_KINDS) expect(kindEnabled(on, kind)).toBe(true);
    const off = config();
    for (const kind of ANNOUNCEMENT_KINDS) expect(kindEnabled(off, kind)).toBe(false);
    expect(kindEnabled(config({ pause: true }), "resume")).toBe(true);
  });

  it("recognises exactly the known kinds", () => {
    expect(isAnnouncementKind("release")).toBe(true);
    expect(isAnnouncementKind("nope")).toBe(false);
    expect(isAnnouncementKind(7)).toBe(false);
  });
});
