// The webhook URL is a bearer secret (#590). sender.test.ts stubs
// errorLabel, so this file runs the real one to prove a fetch failure and a
// non-OK response never put the URL or its token in the log.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { postToDiscord } from "@/lib/announce/sender";

const URL = "https://discord.com/api/webhooks/1/aaaaaaaaaaaaaaaaaaaaaa";
const TOKEN = "aaaaaaaaaaaaaaaaaaaaaa";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postToDiscord log redaction", () => {
  it("never writes the webhook URL to the log on a rejected fetch or non-OK response", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.stubGlobal("fetch", vi.fn(async () => {
        throw new Error(`request to ${URL} failed`);
      }));
      await postToDiscord(URL, { embeds: [] });

      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
      await postToDiscord(URL, { embeds: [] });

      expect(spy.mock.calls.length).toBeGreaterThan(0);
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          expect(arg).not.toBeInstanceOf(Error);
        }
      }
      expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(URL);
    } finally {
      spy.mockRestore();
    }
  });

  it("redacts the URL before the label's length cap, so no partial token survives truncation", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.stubGlobal("fetch", vi.fn(async () => {
        throw new Error(`${"x".repeat(150)}${URL}`);
      }));
      await postToDiscord(URL, { embeds: [] });

      expect(spy.mock.calls.length).toBeGreaterThan(0);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
      expect(JSON.stringify(spy.mock.calls)).not.toContain("aaaaaaaa");
    } finally {
      spy.mockRestore();
    }
  });
});
