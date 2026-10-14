// The Event tab's "Discord announcements" panel (#590). No DOM in this repo
// (see admin-support-tab.test.tsx's standing note), and the panel is
// fetch+state driven — a static render reaches only its loading state, so
// what renders here pins that the section exists in the tab's tree. The
// blur-save contract (no POST when nothing actually changed; the stored
// value restored when a save fails; the webhook URL never read back) is
// pinned through the exported pure helper and the source, the same way the
// sponsor dialog pins its no-DOM behaviour.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import AdminEventAnnouncements, { blurNeedsSave, mergePatched } from "../admin-event-announcements";
import type { DiscordPublicConfig } from "@/lib/discord-config";

const source = (): string =>
  readFileSync(fileURLToPath(new URL("../admin-event-announcements.tsx", import.meta.url)), "utf8")
    // Comments first: the prose explains what the code does, and prose is
    // not what these assertions guard (same as sponsor-editor-dialog.test.tsx).
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

describe("AdminEventAnnouncements", () => {
  it("renders the section with its loading state (config arrives via GET)", () => {
    const html = renderToStaticMarkup(<AdminEventAnnouncements />);
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
  const config = (over: Partial<DiscordPublicConfig> = {}): DiscordPublicConfig => ({
    webhookConfigured: false,
    firstBlood: false,
    launch: false,
    pause: false,
    milestones: false,
    marks: "",
    ...over,
  });

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
