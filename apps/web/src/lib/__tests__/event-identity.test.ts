import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVENT_IDENTITY, EVENT_CONTACT_MAX, EVENT_DISCORD_MAX, EVENT_IDENTITY_KEYS, EVENT_LOCATION_MAX,
  EVENT_NAME_MAX, EVENT_THEME_MAX, checkEventIdentityValue, isEventIdentityKey,
} from "@/lib/event-identity";

describe("event identity contract", () => {
  it("names exactly the five spec fields, in order", () => {
    expect([...EVENT_IDENTITY_KEYS]).toEqual(["eventName", "eventTheme", "eventLocation", "eventContact", "eventDiscord"]);
  });
  it("defaults to OWASP CTF in a Box and nothing else", () => {
    expect(DEFAULT_EVENT_IDENTITY).toEqual({ eventName: "OWASP CTF in a Box", eventTheme: "", eventLocation: "", eventContact: "", eventDiscord: "" });
  });
  it("pins the spec limits", () => {
    expect([EVENT_NAME_MAX, EVENT_THEME_MAX, EVENT_LOCATION_MAX, EVENT_CONTACT_MAX, EVENT_DISCORD_MAX]).toEqual([80, 160, 160, 254, 200]);
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
});
