// @vitest-environment happy-dom
// The Support tab's account controls, driven through the rendered component:
// a destructive request goes out only from the confirmation's onConfirm, and
// a replacement reset code clears the one on screen before it is requested.
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import AdminSupportTab, { type UserDetail } from "@/app/(site)/admin/admin-support-tab";
import type { ConfirmState } from "@/app/(site)/admin/types";
import ConfirmModal from "@/components/confirm-modal";

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
  hasUsername: true,
  hasPassword: true,
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

/** The tab under the real confirmation dialog, wired as admin-controls.tsx
 *  wires it: Confirm runs the action then closes, Cancel drops the state. */
function WithConfirm() {
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  return (
    <>
      <AdminSupportTab setConfirm={setConfirm} />
      {confirm && (
        <ConfirmModal
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          requireType={confirm.requireType}
          danger={confirm.danger}
          onConfirm={() => void Promise.resolve(confirm.onConfirm()).finally(() => setConfirm(null))}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
}

describe("Unlink GitHub", () => {
  it("sends nothing when the confirmation opens or is cancelled, and one request on confirm", async () => {
    const posts = stubFetch(async () => json({ login: "octocat" }));
    render(<WithConfirm />);
    fireEvent.change(screen.getByLabelText("Name or GitHub login"), { target: { value: "octo" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: /octocat/ }));
    const control = await screen.findByRole("button", { name: "Unlink GitHub" });

    fireEvent.click(control);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Unlink GitHub" })).toBeTruthy();
    expect(posts).toEqual([]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Unlink GitHub" }));
    const reopened = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(reopened).getByRole("button", { name: "Unlink GitHub" }));
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts).toEqual([{ id: OCTO, action: "unlink-github" }]);
  });

  it("stays disabled, with the reason beside it, when the player has no password", async () => {
    const blocked = { ...detail, hasPassword: false };
    const posts = stubFetch(async () => json({}));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)) as Post);
          return json({});
        }
        if (url.startsWith("/api/admin/players")) return json({ players: [{ id: OCTO, name: "octocat", image: null }] });
        return json(blocked);
      }),
    );
    render(<WithConfirm />);
    fireEvent.change(screen.getByLabelText("Name or GitHub login"), { target: { value: "octo" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: /octocat/ }));
    const control = await screen.findByRole("button", { name: "Unlink GitHub" });
    expect((control as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain("give them a reset code so they can set a password");
    fireEvent.click(control);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts).toEqual([]);
  });

  it("shows a refusal beside Unlink and clears it when an adjustment is sent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST" && String(url).includes("/api/admin/ops/user")) {
          return json({ error: "This player cannot sign in without GitHub. First give them a reset code so they can set a password." }, false);
        }
        if (init?.method === "POST" && String(url).includes("/api/admin/adjustments")) {
          return json({ error: "No team \"red-team\"" }, false);
        }
        if (String(url).startsWith("/api/admin/players")) return json({ players: [{ id: OCTO, name: "octocat", image: null }] });
        if (String(url).startsWith("/api/admin/adjustments")) return json({ adjustments: [] });
        return json(detail);
      }),
    );
    render(<WithConfirm />);
    fireEvent.change(screen.getByLabelText("Name or GitHub login"), { target: { value: "octo" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: /octocat/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Unlink GitHub" }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Unlink GitHub" }));
    });
    await screen.findByText(/cannot sign in without GitHub/);

    const slug = screen.getAllByLabelText("Team slug").find((el) => el.getAttribute("placeholder") === "team slug");
    if (!slug) throw new Error("adjustment slug field missing");
    fireEvent.change(slug, { target: { value: "red-team" } });
    fireEvent.change(screen.getByLabelText("Points (negative for a penalty)"), { target: { value: "-10" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "late flag" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add adjustment" }));
    });
    await waitFor(() => expect(document.body.textContent).not.toContain("cannot sign in without GitHub"));
    expect(document.body.textContent).toContain("No team");
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
