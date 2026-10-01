import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVENT_IDENTITY, EVENT_CONTACT_MAX, EVENT_DISCORD_MAX, EVENT_IDENTITY_KEYS, EVENT_LOCATION_MAX, EVENT_LOGO_URL_MAX, EVENT_TIME_ZONE_MAX,
  EVENT_NAME_MAX, EVENT_THEME_MAX, checkEventIdentityValue, isEventIdentityKey,
} from "@/lib/event-identity";

describe("event identity contract", () => {
  it("names exactly the spec fields, in order (#545 adds the logo link last)", () => {
    expect([...EVENT_IDENTITY_KEYS]).toEqual(["eventName", "eventTheme", "eventLocation", "eventTimeZone", "eventContact", "eventDiscord", "eventLogoUrl"]);
  });
  it("defaults to OWASP CTF in a Box and nothing else", () => {
    expect(DEFAULT_EVENT_IDENTITY).toEqual({ eventName: "OWASP CTF in a Box", eventTheme: "", eventLocation: "", eventTimeZone: "", eventContact: "", eventDiscord: "", eventLogoUrl: "" });
  });
  it("pins the spec limits", () => {
    expect([EVENT_NAME_MAX, EVENT_THEME_MAX, EVENT_LOCATION_MAX, EVENT_CONTACT_MAX, EVENT_DISCORD_MAX, EVENT_LOGO_URL_MAX, EVENT_TIME_ZONE_MAX]).toEqual([80, 160, 160, 254, 200, 2048, 64]);
  });
  it("recognises its keys and nothing else", () => {
    expect(isEventIdentityKey("eventName")).toBe(true);
    expect(isEventIdentityKey("moduleTitle:quiz")).toBe(false);
    expect(isEventIdentityKey("eventname")).toBe(false);
  });
});

describe("checkEventIdentityValue", () => {
  it("trims and accepts a plain name", () => {
    expect(checkEventIdentityValue("eventName", "  Demo CTF ")).toEqual({ ok: true, value: "Demo CTF" });
  });
  it("returns an empty value for whitespace-only input (the caller clears)", () => {
    expect(checkEventIdentityValue("eventTheme", "   ")).toEqual({ ok: true, value: "" });
  });
  it("rejects non-strings", () => {
    expect(checkEventIdentityValue("eventName", 42)).toMatchObject({ ok: false });
    expect(checkEventIdentityValue("eventName", null)).toMatchObject({ ok: false });
  });
  it("rejects control and bidi characters", () => {
    expect(checkEventIdentityValue("eventName", "Demo‮CTF")).toMatchObject({ ok: false });
    expect(checkEventIdentityValue("eventLocation", "Line\nbreak")).toMatchObject({ ok: false });
  });
  it("enforces each field's max after trimming", () => {
    expect(checkEventIdentityValue("eventName", "x".repeat(80))).toMatchObject({ ok: true });
    expect(checkEventIdentityValue("eventName", "x".repeat(81))).toMatchObject({ ok: false, message: expect.stringContaining("80") });
    expect(checkEventIdentityValue("eventTheme", "x".repeat(161))).toMatchObject({ ok: false, message: expect.stringContaining("160") });
    expect(checkEventIdentityValue("eventLocation", " " + "x".repeat(160) + " ")).toMatchObject({ ok: true });
  });
  it("accepts an e-mail or empty for eventContact, nothing else", () => {
    expect(checkEventIdentityValue("eventContact", "organizers@example.org")).toEqual({ ok: true, value: "organizers@example.org" });
    expect(checkEventIdentityValue("eventContact", "")).toEqual({ ok: true, value: "" });
    expect(checkEventIdentityValue("eventContact", "organizers@")).toMatchObject({ ok: false, message: expect.stringContaining("e-mail") });
    expect(checkEventIdentityValue("eventContact", "two words@example.org")).toMatchObject({ ok: false });
  });
  it("accepts an https URL or empty for eventDiscord, nothing else", () => {
    expect(checkEventIdentityValue("eventDiscord", "https://discord.gg/abc")).toEqual({ ok: true, value: "https://discord.gg/abc" });
    expect(checkEventIdentityValue("eventDiscord", "")).toEqual({ ok: true, value: "" });
    expect(checkEventIdentityValue("eventDiscord", "http://discord.gg/abc")).toMatchObject({ ok: false, message: expect.stringContaining("https") });
    expect(checkEventIdentityValue("eventDiscord", "https://")).toMatchObject({ ok: false });
    expect(checkEventIdentityValue("eventDiscord", "discord.gg/abc")).toMatchObject({ ok: false });
  });
  // #545: the hero logo links here, so only a plain https page is accepted —
  // the same rule as a sponsor's URL (no credentials smuggled in userinfo).
  // #547: an IANA zone Intl knows, stored in its canonical spelling; blank = UTC.
  it("accepts an IANA zone or empty for eventTimeZone, nothing else", () => {
    expect(checkEventIdentityValue("eventTimeZone", " America/Argentina/Buenos_Aires ")).toEqual({ ok: true, value: "America/Argentina/Buenos_Aires" });
    expect(checkEventIdentityValue("eventTimeZone", "utc")).toEqual({ ok: true, value: "UTC" });
    expect(checkEventIdentityValue("eventTimeZone", "")).toEqual({ ok: true, value: "" });
    expect(checkEventIdentityValue("eventTimeZone", "Mars/Olympus")).toMatchObject({ ok: false, message: expect.stringContaining("time zone") });
    expect(checkEventIdentityValue("eventTimeZone", "x".repeat(65))).toMatchObject({ ok: false, message: expect.stringContaining("64") });
  });

  it("accepts an https URL or empty for eventLogoUrl, nothing else", () => {
    expect(checkEventIdentityValue("eventLogoUrl", " https://redteamspace.team/ctf ")).toEqual({ ok: true, value: "https://redteamspace.team/ctf" });
    expect(checkEventIdentityValue("eventLogoUrl", "")).toEqual({ ok: true, value: "" });
    expect(checkEventIdentityValue("eventLogoUrl", "http://redteamspace.team")).toMatchObject({ ok: false, message: expect.stringContaining("https") });
    expect(checkEventIdentityValue("eventLogoUrl", "javascript:alert(1)")).toMatchObject({ ok: false });
    expect(checkEventIdentityValue("eventLogoUrl", "https://user:pass@redteamspace.team/")).toMatchObject({ ok: false });
    expect(checkEventIdentityValue("eventLogoUrl", "https://")).toMatchObject({ ok: false });
    expect(checkEventIdentityValue("eventLogoUrl", "redteamspace.team")).toMatchObject({ ok: false });
    expect(checkEventIdentityValue("eventLogoUrl", "https://a.example/\u0007")).toMatchObject({ ok: false });
    expect(checkEventIdentityValue("eventLogoUrl", "https://a.example/" + "x".repeat(2048))).toMatchObject({ ok: false, message: expect.stringContaining("2048") });
  });
});
