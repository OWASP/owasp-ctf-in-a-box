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

const REMOVED = "Removed −10 from red-team.";

describe("action results that outlive their control", () => {
  it("keeps a removal's success beside the controls after the row is gone", async () => {
    const row = { id: "a1", slug: "red-team", points: -10, reason: "late", by: "admin", at: "2026-11-24T00:00:00.000Z" };
    let removed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).startsWith("/api/admin/adjustments")) {
          if (init?.method === "DELETE") {
            removed = true;
            return json({});
          }
          return json({ adjustments: removed ? [] : [row] });
        }
        if (String(url).startsWith("/api/admin/players")) return json({ players: [{ id: OCTO, name: "octocat", image: null }] });
        if (String(url).startsWith("/api/admin/sd/held")) return json({ entries: [] });
        return json(detail);
      }),
    );
    await pickOcto();
    await screen.findByRole("button", { name: "Remove adjustment for red-team" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove adjustment for red-team" }));
    });
    await screen.findByText(REMOVED);
    expect(screen.queryByRole("button", { name: "Remove adjustment for red-team" })).toBeNull();
    expect(document.body.textContent).toContain(REMOVED);
  });

  it("puts a failed delete beside Delete contestant and a successful one by the search", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return json({ error: "They captain a team" }, false);
      if (String(url).startsWith("/api/admin/players")) return json({ players: [{ id: OCTO, name: "octocat", image: null }] });
      if (String(url).startsWith("/api/admin/sd/held")) return json({ entries: [] });
      if (String(url).startsWith("/api/admin/adjustments")) return json({ adjustments: [] });
      return json(detail);
    });
    vi.stubGlobal("fetch", fetchMock);
    const confirms = await pickOcto();
    fireEvent.click(screen.getByRole("button", { name: "Delete contestant" }));
    await act(async () => {
      await confirms.at(-1)!.onConfirm();
    });
    const failure = await screen.findByText("They captain a team");
    const deleter = screen.getByRole("button", { name: "Delete contestant" });
    expect(deleter.parentElement?.contains(failure)).toBe(true);
    expect(screen.getByLabelText("Name or GitHub login").parentElement?.contains(failure)).toBe(false);

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return json({});
      if (String(url).startsWith("/api/admin/players")) return json({ players: [{ id: OCTO, name: "octocat", image: null }] });
      if (String(url).startsWith("/api/admin/sd/held")) return json({ entries: [] });
      if (String(url).startsWith("/api/admin/adjustments")) return json({ adjustments: [] });
      return json(detail);
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete contestant" }));
    await act(async () => {
      await confirms.at(-1)!.onConfirm();
    });
    const success = await screen.findByText("Deleted octocat.");
    expect(screen.queryByRole("button", { name: "Delete contestant" })).toBeNull();
    expect(screen.getByLabelText("Name or GitHub login").parentElement?.contains(success)).toBe(true);
  });

  it("drops an adjustment result that lands after a later action", async () => {
    let release: (response: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST" && String(url).includes("/api/admin/adjustments")) return held;
        if (init?.method === "POST") return json({ code: "aaaa-1111", expiresAt: "2026-11-17T12:15:00.000Z" });
        if (String(url).startsWith("/api/admin/players")) return json({ players: [{ id: OCTO, name: "octocat", image: null }] });
        if (String(url).startsWith("/api/admin/sd/held")) return json({ entries: [] });
        if (String(url).startsWith("/api/admin/adjustments")) return json({ adjustments: [] });
        return json(detail);
      }),
    );
    const confirms = await pickOcto();
    const slug = screen.getAllByLabelText("Team slug").find((el) => el.getAttribute("placeholder") === "team slug");
    if (!slug) throw new Error("adjustment slug field missing");
    fireEvent.change(slug, { target: { value: "red-team" } });
    fireEvent.change(screen.getByLabelText("Points (negative for a penalty)"), { target: { value: "-10" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "late flag" } });
    fireEvent.click(screen.getByRole("button", { name: "Add adjustment" }));

    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    await act(async () => {
      await confirms.at(-1)!.onConfirm();
    });
    await screen.findByText("Issued a reset code for octocat.");

    await act(async () => {
      release(json({}));
    });
    await waitFor(() => expect(document.body.textContent).toContain("Issued a reset code for octocat."));
    expect(document.body.textContent).not.toContain("Added");
  });

  it("keeps an adjustment result when an older reset answer arrives later", async () => {
    let releaseReset: (response: Response) => void = () => {};
    const heldReset = new Promise<Response>((resolve) => {
      releaseReset = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST" && String(url).includes("/api/admin/ops/user")) return heldReset;
        if (init?.method === "POST" && String(url).includes("/api/admin/adjustments")) return json({});
        if (String(url).startsWith("/api/admin/players")) return json({ players: [{ id: OCTO, name: "octocat", image: null }] });
        if (String(url).startsWith("/api/admin/sd/held")) return json({ entries: [] });
        if (String(url).startsWith("/api/admin/adjustments")) return json({ adjustments: [] });
        return json(detail);
      }),
    );
    const confirms = await pickOcto();
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    const reset = confirms.at(-1)!.onConfirm();
    await act(async () => {
      await Promise.resolve();
    });

    const slug = screen.getAllByLabelText("Team slug").find((el) => el.getAttribute("placeholder") === "team slug");
    if (!slug) throw new Error("adjustment slug field missing");
    fireEvent.change(slug, { target: { value: "red-team" } });
    fireEvent.change(screen.getByLabelText("Points (negative for a penalty)"), { target: { value: "-10" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "late flag" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add adjustment" }));
    });
    await screen.findByText("Added −10 to red-team.");

    await act(async () => {
      releaseReset(json({ code: "aaaa-1111", expiresAt: "2026-11-17T12:15:00.000Z" }));
      await reset;
    });
    expect(document.body.textContent).toContain("Added −10 to red-team.");
    expect(document.body.textContent).not.toContain("Issued a reset code");
    expect(document.body.textContent).not.toContain("aaaa-1111");
  });

  it("drops a deleted contestant's card when a newer adjustment owns the notice", async () => {
    let releaseDelete: (response: Response) => void = () => {};
    const heldDelete = new Promise<Response>((resolve) => {
      releaseDelete = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") return heldDelete;
        if (init?.method === "POST" && String(url).includes("/api/admin/adjustments")) return json({});
        if (String(url).startsWith("/api/admin/players")) {
          return json({
            players: [
              { id: OCTO, name: "octocat", image: null },
              { id: "b0b00000-0000-4000-8000-000000000002", name: "bob", image: null },
            ],
          });
        }
        if (String(url).startsWith("/api/admin/sd/held")) return json({ entries: [] });
        if (String(url).startsWith("/api/admin/adjustments")) return json({ adjustments: [] });
        return json(detail);
      }),
    );
    const confirms = await pickOcto();
    fireEvent.click(screen.getByRole("button", { name: "Delete contestant" }));
    const deleting = confirms.at(-1)!.onConfirm();
    await act(async () => {
      await Promise.resolve();
    });

    const slug = screen.getAllByLabelText("Team slug").find((el) => el.getAttribute("placeholder") === "team slug");
    if (!slug) throw new Error("adjustment slug field missing");
    fireEvent.change(slug, { target: { value: "red-team" } });
    fireEvent.change(screen.getByLabelText("Points (negative for a penalty)"), { target: { value: "-10" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "late flag" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add adjustment" }));
    });
    await screen.findByText("Added −10 to red-team.");

    await act(async () => {
      releaseDelete(json({}));
      await deleting;
    });
    expect(screen.queryByRole("button", { name: "Delete contestant" })).toBeNull();
    expect(screen.queryByRole("button", { name: /octocat/ })).toBeNull();
    expect(screen.getByRole("button", { name: /bob/ })).toBeTruthy();
    expect(document.body.textContent).toContain("Added −10 to red-team.");
    expect(document.body.textContent).not.toContain("Deleted octocat.");
  });

  it("refreshes a superseded unlink and leaves the newer notice", async () => {
    let releaseUnlink: (response: Response) => void = () => {};
    const heldUnlink = new Promise<Response>((resolve) => {
      releaseUnlink = resolve;
    });
    let unlinked = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST" && String(url).includes("/api/admin/ops/user")) return heldUnlink;
        if (init?.method === "POST" && String(url).includes("/api/admin/adjustments")) return json({});
        if (String(url).startsWith("/api/admin/players")) return json({ players: [{ id: OCTO, name: "octocat", image: null }] });
        if (String(url).startsWith("/api/admin/sd/held")) return json({ entries: [] });
        if (String(url).startsWith("/api/admin/adjustments")) return json({ adjustments: [] });
        if (String(url).startsWith("/api/admin/ops/user")) return json(unlinked ? { ...detail, github: null } : detail);
        return json(detail);
      }),
    );
    const confirms = await pickOcto();
    expect(document.body.textContent).toContain("GitHub login octocat");
    fireEvent.click(screen.getByRole("button", { name: "Unlink GitHub" }));
    const unlinking = confirms.at(-1)!.onConfirm();
    await act(async () => {
      await Promise.resolve();
    });

    const slug = screen.getAllByLabelText("Team slug").find((el) => el.getAttribute("placeholder") === "team slug");
    if (!slug) throw new Error("adjustment slug field missing");
    fireEvent.change(slug, { target: { value: "red-team" } });
    fireEvent.change(screen.getByLabelText("Points (negative for a penalty)"), { target: { value: "-10" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "late flag" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add adjustment" }));
    });
    await screen.findByText("Added −10 to red-team.");

    unlinked = true;
    await act(async () => {
      releaseUnlink(json({}));
      await unlinking;
    });
    expect(document.body.textContent).toContain("Added −10 to red-team.");
    expect(document.body.textContent).not.toContain("Unlinked GitHub");
    expect(document.body.textContent).not.toContain("GitHub login octocat");
  });
});
