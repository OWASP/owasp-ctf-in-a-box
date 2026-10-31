// @vitest-environment happy-dom
// The list-plus-editor state the quiz, classic and ai admin panels share.
// This suite runs under happy-dom so `renderHook` can mount the hook with
// effects and asynchronous state updates. The transport functions
// (`loadResource`, `postRow`, `writeBackReorder`) are proven directly against
// a stubbed `fetch`, the initial state through a static probe, and remove()
// through mounted hooks that observe editor, rows and error state.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { act, renderHook } from "@testing-library/react";
import { describeAdminError } from "@/components/admin/fetch";
import type { RowAccessors } from "@/components/admin/ordered-rows";
import { closesOnDelete, loadResource, postRow, useAdminResource, writeBackReorder } from "@/components/admin/use-admin-resource";

type Item = { id: string; title: string; order: number };
type Row = { item: Item; secret: string };
type Editor = { id: string; title: string };
type Payload = { id: string; title: string; order: number };

const rows: RowAccessors<Row> = {
  id: (r) => r.item.id,
  order: (r) => r.item.order,
  withOrder: (r, order) => ({ ...r, item: { ...r.item, order } }),
};

const describeError = (status: number, message?: string) => describeAdminError(status, message, "fallback");

const config = {
  endpoint: "/api/admin/thing",
  describeError,
  rows,
  parseList: (data: Record<string, unknown>) => ({
    rows: Array.isArray(data.things) ? (data.things as Row[]) : [],
    categories: Array.isArray(data.categories) ? (data.categories as string[]) : [],
  }),
  loadErrorMessage: "Couldn't load things — check your connection and try again.",
  parseUpsert: (data: Record<string, unknown>, payload: Payload): Row | null =>
    data.item ? { item: data.item as Item, secret: (data.secret as string | undefined) ?? payload.title } : null,
  toPayload: (e: Editor): Payload => ({ id: e.id, title: e.title, order: 1 }),
  initialRows: [] as Row[],
  initialCategories: [] as string[],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadResource", () => {
  it("GETs the endpoint and returns the rows sorted by order with the categories", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        things: [
          { item: { id: "b", title: "B", order: 2 }, secret: "sb" },
          { item: { id: "a", title: "A", order: 1 }, secret: "sa" },
        ],
        categories: ["Web"],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await loadResource(config);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/thing");
    expect(result.ok && result.rows.map((r) => r.item.id)).toEqual(["a", "b"]);
    expect(result.ok && result.categories).toEqual(["Web"]);
  });

  it("describes a non-2xx reply through the module's mapper", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(503, { error: "redis down" })));
    await expect(loadResource(config)).resolves.toEqual({ ok: false, message: "Store unavailable — redis down" });
  });

  it("returns the module's load sentence for a network failure, never throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(loadResource(config)).resolves.toEqual({ ok: false, message: config.loadErrorMessage });
  });
});

describe("postRow", () => {
  it("POSTs the payload and returns the STORED row the route echoes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { item: { id: "a", title: "A (trimmed)", order: 1 }, secret: "stored" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await postRow(config, { id: "a", title: "A ", order: 1 });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify({ id: "a", title: "A ", order: 1 }) });
    expect(result).toEqual({ ok: true, row: { item: { id: "a", title: "A (trimmed)", order: 1 }, secret: "stored" } });
  });

  it("treats a 2xx body without the record as a failure described with that status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { error: "odd" })));
    await expect(postRow(config, { id: "a", title: "A", order: 1 })).resolves.toEqual({ ok: false, message: "odd" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, {})));
    await expect(postRow(config, { id: "a", title: "A", order: 1 })).resolves.toEqual({ ok: false, message: "fallback" });
  });

  it("surfaces a 400 as the store's own message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "title required" })));
    await expect(postRow(config, { id: "a", title: "", order: 1 })).resolves.toEqual({ ok: false, message: "title required" });
  });
});

// #283: the reorder write-back POSTs each moved row separately. If a later
// POST fails, earlier rows are already stored with their new order, so
// restoring the pre-move list locally would show an arrangement the store no
// longer has. The store is re-read instead and the reorder's error kept.
describe("writeBackReorder", () => {
  const rowPayload = (r: Row): Payload => ({ id: r.item.id, title: r.item.title, order: r.item.order });
  const a: Row = { item: { id: "a", title: "A", order: 1 }, secret: "" };
  const b: Row = { item: { id: "b", title: "B", order: 2 }, secret: "" };

  it("posts every changed row in order and reports success without touching the store", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(jsonResponse(200, { item: JSON.parse(String(init?.body)) })),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(writeBackReorder(config, [a, b], rowPayload)).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls.map((c) => (c[1] as RequestInit | undefined)?.method ?? "GET")).toEqual(["POST", "POST"]);
  });

  it("on the first failed POST, stops, re-reads the list from the store and returns both the error and the fresh rows", async () => {
    const stored = [{ item: { id: "b", title: "B", order: 1 }, secret: "" }, a];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { item: a.item }))
      .mockResolvedValueOnce(jsonResponse(503, { error: "redis down" }))
      .mockResolvedValueOnce(jsonResponse(200, { things: stored }));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await writeBackReorder(config, [a, b, { ...b, item: { ...b.item, id: "c" } }], rowPayload);
    expect(fetchMock.mock.calls.map((c) => (c[1] as RequestInit | undefined)?.method ?? "GET")).toEqual(["POST", "POST", "GET"]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toBe("Store unavailable — redis down");
    expect(outcome.fresh.ok && outcome.fresh.rows.map((r) => r.item.id)).toEqual(["a", "b"]);
  });

  it("still reports the reorder's own error when the re-read fails too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(jsonResponse(400, { error: "order must be an integer" })).mockRejectedValueOnce(new TypeError("fetch failed")),
    );
    const outcome = await writeBackReorder(config, [a], rowPayload);
    expect(outcome).toMatchObject({ ok: false, message: "order must be an integer", fresh: { ok: false, message: config.loadErrorMessage } });
  });
});

describe("closesOnDelete", () => {
  it("closes when editing the same item being deleted", () => {
    expect(closesOnDelete({ id: "a", title: "A" }, "a")).toBe(true);
    expect(closesOnDelete({ mode: "edit", id: "a" }, "a")).toBe(true);
  });

  it("stays open when editing a different item", () => {
    expect(closesOnDelete({ id: "b", title: "B" }, "a")).toBe(false);
    expect(closesOnDelete({ mode: "edit", id: "b" }, "a")).toBe(false);
  });

  it("stays open for a new-mode draft without an id", () => {
    expect(closesOnDelete({ mode: "new", order: 1 }, "a")).toBe(false);
  });

  it("returns false when no editor is open", () => {
    expect(closesOnDelete(null, "a")).toBe(false);
  });
});

describe("useAdminResource — initial state", () => {
  function Probe({ seed, seedCategories }: { seed: Row[]; seedCategories: string[] }) {
    const r = useAdminResource<Row, Item, Editor, Payload>({ ...config, initialRows: seed, initialCategories: seedCategories });
    return (
      <p>
        rows={r.rows.map((x) => x.item.id).join(",")} categories={r.categories.join(",")} next={r.nextOrder} loaded={String(r.loaded)}{" "}
        editing={String(r.editing)} deleting={String(r.deleteTarget)} error={String(r.listError)}
      </p>
    );
  }

  it("seeds the rows sorted, the categories, and the next position; nothing open, nothing loaded yet", () => {
    const html = renderToStaticMarkup(
      <Probe
        seed={[
          { item: { id: "b", title: "B", order: 5 }, secret: "" },
          { item: { id: "a", title: "A", order: 1 }, secret: "" },
        ]}
        seedCategories={["Web"]}
      />,
    );
    expect(html).toContain("rows=a,b");
    expect(html).toContain("categories=Web");
    expect(html).toContain("next=6");
    expect(html).toContain("loaded=false");
    expect(html).toContain("editing=null");
    expect(html).toContain("deleting=null");
    expect(html).toContain("error=null");
  });

  it("starts an empty seed at position 1", () => {
    expect(renderToStaticMarkup(<Probe seed={[]} seedCategories={[]} />)).toContain("next=1");
  });

  it("openEditor opens clean editor immediately and returns true", () => {
    let result: boolean | undefined;
    function OpenProbe() {
      const r = useAdminResource<Row, Item, Editor, Payload>({ ...config, initialRows: [], initialCategories: [] });
      if (result === undefined) {
        result = r.openEditor({ id: "a", title: "A" });
      }
      return <div>{r.editing?.id}</div>;
    }
    const html = renderToStaticMarkup(<OpenProbe />);
    expect(result).toBe(true);
    expect(html).toContain("a");
  });
});

describe("useAdminResource — remove and closesOnDelete interaction", () => {
  it("deleting the currently open challenge closes its editor", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return Promise.resolve(jsonResponse(200, { ok: true }));
      }
      return Promise.resolve(
        jsonResponse(200, {
          things: [
            { item: { id: "a", title: "A", order: 1 }, secret: "" },
            { item: { id: "b", title: "B", order: 2 }, secret: "" },
          ],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useAdminResource<Row, Item, Editor, Payload>({
        ...config,
        initialRows: [
          { item: { id: "a", title: "A", order: 1 }, secret: "" },
          { item: { id: "b", title: "B", order: 2 }, secret: "" },
        ],
      }),
    );

    act(() => {
      result.current.openEditor({ id: "a", title: "A" });
    });
    expect(result.current.editing).toEqual({ id: "a", title: "A" });

    await act(async () => {
      await result.current.remove("a");
    });

    expect(result.current.editing).toBeNull();
  });

  it("deleting a different challenge leaves the current editor open", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return Promise.resolve(jsonResponse(200, { ok: true }));
      }
      return Promise.resolve(
        jsonResponse(200, {
          things: [
            { item: { id: "a", title: "A", order: 1 }, secret: "" },
            { item: { id: "b", title: "B", order: 2 }, secret: "" },
          ],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useAdminResource<Row, Item, Editor, Payload>({
        ...config,
        initialRows: [
          { item: { id: "a", title: "A", order: 1 }, secret: "" },
          { item: { id: "b", title: "B", order: 2 }, secret: "" },
        ],
      }),
    );

    act(() => {
      result.current.openEditor({ id: "a", title: "A" });
    });
    expect(result.current.editing).toEqual({ id: "a", title: "A" });

    await act(async () => {
      await result.current.remove("b");
    });

    expect(result.current.editing).toEqual({ id: "a", title: "A" });
    expect(result.current.rows.map((row) => row.item.id)).not.toContain("b");
    expect(result.current.deleteError).toBeNull();
  });
});
