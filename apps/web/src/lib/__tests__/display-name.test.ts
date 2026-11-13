// The display rule shared by server code and the client nav, which reads it
// off the session user (id, GitHub login, profile name).
import { describe, expect, it } from "vitest";

import { displayNameOf, unnamed } from "@/lib/display-name";

const ID = "3f2b8c1e-9a4d-4e6f-8b7a-0c1d2e3f4a5b";

describe("displayNameOf on a session user", () => {
  it("shows the GitHub login over the profile name", () => {
    expect(displayNameOf({ id: ID, login: "octocat", name: "The Octocat", email: "o@example.com" } as never)).toBe("octocat");
  });
  it("falls back to the profile name, then the short id", () => {
    expect(displayNameOf({ id: ID, login: null, name: "The Octocat" })).toBe("The Octocat");
    expect(displayNameOf({ id: ID, login: null, name: "" })).toBe("player 3f2b8c1e");
  });
});

describe("unnamed", () => {
  it("gives the id fallback and no image", () => {
    expect(unnamed(ID)).toEqual({ name: "player 3f2b8c1e", image: null });
  });
});
