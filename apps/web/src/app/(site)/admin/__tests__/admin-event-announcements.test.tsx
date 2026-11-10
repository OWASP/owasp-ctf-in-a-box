// The Event tab's "Discord announcements" panel (#590). No DOM in this repo
// (see admin-support-tab.test.tsx's standing note), and the panel is
// fetch+state driven — a static render reaches only its loading state, so
// what renders here pins that the section exists in the tab's tree. The
// blur-save contract (no POST when nothing actually changed; the stored
// value restored when a save fails; the webhook URL never read back) is
// pinned through the exported pure helper and the source, the same way the
// sponsor dialog pins its no-DOM behaviour. The reload and Clear contracts
// are pinned the same way: a pure fold for what a fresh GET may overwrite,
// the source for which handler is allowed to send the destructive POST.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import AdminEventAnnouncements, { blurNeedsSave, clearWebhookConfirm, foldReloaded, mergePatched, type Load } from "../admin-event-announcements";
import type { DiscordPublicConfig } from "@/lib/discord-config";
import type { AnnounceStatus } from "@/lib/announce/store";

const source = (): string =>
  readFileSync(fileURLToPath(new URL("../admin-event-announcements.tsx", import.meta.url)), "utf8")
    // Comments first: the prose explains what the code does, and prose is
    // not what these assertions guard (same as sponsor-editor-dialog.test.tsx).
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const config = (over: Partial<DiscordPublicConfig> = {}): DiscordPublicConfig => ({
  webhookConfigured: false,
  firstBlood: false,
  launch: false,
  pause: false,
  milestones: false,
  marks: "",
  ...over,
});

const status = (over: Partial<AnnounceStatus> = {}): AnnounceStatus => ({
  posted: {},
  lastPostedAt: null,
  lastError: null,
  lastErrorAt: null,
  ...over,
});

describe("AdminEventAnnouncements", () => {
  it("renders the section with its loading state (config arrives via GET)", () => {
    const html = renderToStaticMarkup(<AdminEventAnnouncements setConfirm={() => {}} />);
    expect(html).toContain("Discord announcements");
    expect(html).toContain("Loading…");
  });
});

// A blur that only moves focus must not write: no POST, no audit entry.
// Whitespace around an unchanged value counts as unchanged.
describe("blurNeedsSave", () => {
  it("is false when the trimmed input is what the server already has", () => {
    expect(blurNeedsSave("1h, 15m", "1h, 15m")).toBe(false);
    expect(blurNeedsSave("  1h, 15m  ", "1h, 15m")).toBe(false);
    expect(blurNeedsSave("09:00", "09:00")).toBe(false);
    expect(blurNeedsSave("10", "10")).toBe(false);
  });

  it("is true only for a real edit", () => {
    expect(blurNeedsSave("2h", "1h")).toBe(true);
    expect(blurNeedsSave("", "1h")).toBe(true);
    expect(blurNeedsSave("1h, 15m, 1d", "1h, 15m")).toBe(true);
  });
});

// Two saves for DIFFERENT keys can be in flight at once; each response
// carries the full config as its writer saw it. Folding in only what that
// request wrote is what keeps the panel showing what is actually stored.
describe("mergePatched", () => {
  it("takes only the keys that request wrote — a stale copy of another key cannot clobber it", () => {
    // The displayed config already carries the OTHER save's newer
    // `launch: true`; this response was generated before that save
    // landed, so its copy of `launch` is stale and must be ignored.
    const displayed = config({ launch: true, firstBlood: true });
    const staleResponse = config({ launch: false, firstBlood: false });
    expect(mergePatched(displayed, ["firstBlood"], staleResponse)).toMatchObject({ launch: true, firstBlood: false });
    // The response IS authoritative for its own key, both ways round.
    expect(mergePatched(config({ firstBlood: true }), ["firstBlood"], staleResponse)).toMatchObject({ firstBlood: false });
    expect(mergePatched(config({ firstBlood: false }), ["firstBlood"], config({ firstBlood: true }))).toMatchObject({ firstBlood: true });
  });

  it("folds every key of a multi-key patch, and nothing else", () => {
    const merged = mergePatched(config({ launch: false, pause: false, marks: "" }), ["launch", "pause"], config({ launch: true, pause: true, firstBlood: true }));
    expect(merged).toMatchObject({ launch: true, pause: true });
    expect(merged.firstBlood).toBe(false);
  });

  it("ignores a key the response does not carry", () => {
    expect(mergePatched(config(), ["bogus"], config())).toHaveProperty("marks", "");
    expect("bogus" in mergePatched(config(), ["bogus"], config())).toBe(false);
  });
});

describe("the blur-save contract, at source", () => {
  // No DOM to fire a real blur through: these pin the two halves of the
  // behaviour that a regression would silently break.
  it("routes the one text field (marks) through the guarded save", () => {
    const code = source();
    expect(code).toContain('saveOnBlur("marks"');
    expect(code.match(/saveOnBlur\(/g)).toHaveLength(1);
  });

  it("puts the STORED value back when the save fails — an input never keeps a value that is not in effect", () => {
    expect(source()).toContain("if (!ok) el.value = stored;");
  });

  // The webhook URL is write-only: the server never returns it, so the field
  // is bound to local state (cleared after each save), never to the config.
  it("never reads the webhook URL back out of the loaded config", () => {
    const code = source();
    expect(code).not.toContain("config?.webhookUrl");
    expect(code).toContain("value={webhookInput}");
    expect(code).toContain('setWebhookInput("")');
  });
});

// Send test re-reads config + status, but only the STATUS is its business: a
// config save can commit between that GET being served and its response
// arriving, and putting the response's config back would show a switch that
// is not what is stored. The response's config is taken only when nothing is
// loaded yet.
describe("foldReloaded", () => {
  it("keeps the config already on screen and refreshes only the status", () => {
    const displayed: Load = { state: "ready", config: config({ launch: true }), status: status({ lastError: "boom" }) };
    const fresh = { config: config({ launch: false }), status: status({ lastPostedAt: "2026-10-15T10:00:00.000Z" }) };
    const next = foldReloaded(displayed, fresh);
    expect(next.state).toBe("ready");
    if (next.state !== "ready") throw new Error("expected a ready state");
    expect(next.config).toMatchObject({ launch: true });
    expect(next.status.lastPostedAt).toBe("2026-10-15T10:00:00.000Z");
    expect(next.status.lastError).toBeNull();
  });

  it("takes both halves from the response when no ready state exists", () => {
    const fresh = { config: config({ firstBlood: true }), status: status({ lastPostedAt: "2026-10-15T10:00:00.000Z" }) };
    const fromLoading: Load = { state: "loading" };
    const fromFailure: Load = { state: "failed", message: "Request failed (503)." };
    expect(foldReloaded(fromLoading, fresh)).toEqual({ state: "ready", config: fresh.config, status: fresh.status });
    expect(foldReloaded(fromFailure, fresh)).toEqual({ state: "ready", config: fresh.config, status: fresh.status });
  });

  it("folds the GET through foldReloaded — reload never replaces the whole state", () => {
    expect(source()).toContain("setLoad((prev) => foldReloaded(prev, body))");
  });
});

// Clear deletes the only copy of the webhook URL the box keeps: no API
// returns it, so nothing in the panel can put it back. The button therefore
// only ASKS — through the panel's shared confirm dialog — and nothing is
// sent until onConfirm runs.
describe("Clear asks first", () => {
  it("offers the shared confirmation copy, dangerous and write-only aware", () => {
    const c = clearWebhookConfirm();
    expect(c.danger).toBe(true);
    expect(c.title).toMatch(/webhook/i);
    expect(c.confirmLabel).toMatch(/clear/i);
    expect(String(c.body)).toMatch(/write-only/i);
  });

  it("sends nothing until onConfirm runs — the Clear button never posts directly", () => {
    const code = source();
    expect(code).not.toMatch(/onClick=\{clearWebhook\}/);
    expect(code).not.toMatch(/onClick=\{\(\) => clearWebhook\(\)\}/);
    expect(code).toMatch(/onConfirm:\s*\(\)\s*=>\s*clearWebhook\(\)/);
    // The destructive POST exists in exactly one place — inside clearWebhook
    // — and that function is reached only from the confirmation: its own
    // declaration plus the single onConfirm call, nothing else.
    expect(code.match(/webhookUrl: null/g)).toHaveLength(1);
    expect(code.match(/clearWebhook\(\)/g)).toHaveLength(2);
  });
});
