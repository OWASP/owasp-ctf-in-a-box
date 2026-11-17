// @vitest-environment happy-dom
// The Support tab's account controls, driven through the rendered component:
// a destructive request goes out only from the confirmation's onConfirm, and
// a replacement reset code clears the one on screen before it is requested.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import AdminSupportTab, { type UserDetail } from "@/app/(site)/admin/admin-support-tab";
import type { ConfirmState } from "@/app/(site)/admin/types";

const OCTO = "0c7aca70-0000-4000-8000-00000000000a";
const detail: UserDetail = {
  id: OCTO,
  name: "octocat",
  team: null,
  firstTeamAt: null,
  quiz: { answered: 0, points: 0, attempts: 0 },
  classic: { solved: 0, points: 0, attempts: 0 },
  secureDev: { solves: 0 },
  hints: { bought: 0, spent: 0 },
  known: true,
  github: { login: "octocat", linkedAt: 1 },
};

const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

type Post = { action?: string; id?: string };

/** Routes the tab's requests: the search, the lookup, and every POST, whose
 *  answer `onPost` decides. Returns the POST bodies sent so far. */
function stubFetch(onPost: (body: Post) => Promise<Response>) {
  const posts: Post[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Post;
        posts.push(body);
        return onPost(body);
      }
      if (url.startsWith("/api/admin/players")) return json({ players: [{ id: OCTO, name: "octocat", image: null }] });
      return json(detail);
    }),
  );
  return posts;
}

/** Renders the tab and picks octocat, so the card and its controls show. */
async function pickOcto() {
  const confirms: (ConfirmState | null)[] = [];
  render(<AdminSupportTab setConfirm={(c) => confirms.push(c)} />);
  fireEvent.change(screen.getByLabelText("Name or GitHub login"), { target: { value: "octo" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  const row = await screen.findByRole("button", { name: /octocat/ });
  fireEvent.click(row);
  await screen.findByRole("button", { name: "Unlink GitHub" });
  return confirms;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Unlink GitHub", () => {
  it("sends nothing when the confirmation opens or is cancelled, and one request on confirm", async () => {
    const posts = stubFetch(async () => json({ login: "octocat" }));
    const confirms = await pickOcto();

    fireEvent.click(screen.getByRole("button", { name: "Unlink GitHub" }));
    const opened = confirms.at(-1);
    expect(opened?.confirmLabel).toBe("Unlink GitHub");
    expect(posts).toEqual([]);

    // Cancelling is the modal dropping the state: onConfirm never runs.
    fireEvent.click(screen.getByRole("button", { name: "Unlink GitHub" }));
    expect(posts).toEqual([]);

    await act(async () => {
      await opened!.onConfirm();
    });
    expect(posts).toEqual([{ id: OCTO, action: "unlink-github" }]);
  });
});

describe("Reset password", () => {
  it("clears the code on screen before requesting a replacement, and shows none if that answer is lost", async () => {
    let issued = 0;
    const posts = stubFetch(async () => {
      issued += 1;
      if (issued === 1) return json({ code: "aaaa-1111", expiresAt: "2026-11-17T12:15:00.000Z" });
      throw new TypeError("Failed to fetch");
    });
    const confirms = await pickOcto();

    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    await act(async () => {
      await confirms.at(-1)!.onConfirm();
    });
    expect(document.body.textContent).toContain("aaaa-1111");

    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    await act(async () => {
      await confirms.at(-1)!.onConfirm();
    });
    expect(posts).toHaveLength(2);
    await waitFor(() => expect(document.body.textContent).toContain("Request failed"));
    expect(document.body.textContent).not.toContain("aaaa-1111");
  });
});
