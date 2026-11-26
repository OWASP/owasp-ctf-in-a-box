import { describe, expect, it } from "vitest";
import { describeDiscordFailure } from "@/lib/announce/discord-failure";

describe("describeDiscordFailure", () => {
  it.each([401, 403, 404])("names a %i as a wrong or deleted webhook", (httpStatus) => {
    expect(describeDiscordFailure({ httpStatus })).toBe(
      `Discord rejected the webhook (${httpStatus}): the URL is wrong or the webhook was deleted`,
    );
  });

  it("puts a 5xx on Discord's side", () => {
    expect(describeDiscordFailure({ httpStatus: 503 })).toBe("Discord answered 503: a problem on Discord's side; try again shortly");
  });

  it("names any other refusal by its status", () => {
    expect(describeDiscordFailure({ httpStatus: 400 })).toBe("Discord rejected the post (400)");
  });

  it("says Discord could not be reached when there was no answer", () => {
    expect(describeDiscordFailure({})).toBe("Could not reach Discord (network error or timeout)");
  });
});
