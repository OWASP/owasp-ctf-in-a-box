"use client";

// The Attachments section of the /admin classic challenge form (#186). Each
// change is its own immediate write to /api/admin/attachments — not part of
// the challenge draft's Save — because bytes are large and a file belongs to
// a challenge that already exists. A challenge not saved yet has no id to
// attach to, so the section says so instead.
//
// Shows each upload's name, size and sha256 (computed by the server, so an
// organizer can check a file against the one they meant to ship), and
// labels every external link with what it is: a public URL no lock covers.

import { useEffect, useState } from "react";
import {
  ATTACHMENTS_PER_ITEM_MAX,
  ATTACHMENT_MAX_BYTES,
  type Attachment,
  formatBytes,
} from "@/lib/attachments-keys";
import { INPUT_CLASS } from "@/components/admin/editor-fields";

type Item = Omit<Attachment, "chunks">;

const BUTTON =
  "rounded-md border border-[#2563eb]/45 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/[0.06] disabled:opacity-50";
const LINK_WARNING = "Publicly reachable by anyone with the URL: not covered by launch or story locks.";
const ENDPOINT = "/api/admin/attachments";

async function errorOf(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? `That didn't work (HTTP ${res.status}) — try again.`;
}

export default function AdminAttachments({
  itemId,
  initialItems,
}: {
  /** The saved challenge's id, or null while it is still a new draft. */
  itemId: string | null;
  /** Seeds the list (tests, first paint); otherwise it is read on mount. */
  initialItems?: Item[];
}) {
  const [items, setItems] = useState<Item[] | null>(initialItems ?? null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkName, setLinkName] = useState("");
  const [linkUrl, setLinkUrl] = useState("");

  useEffect(() => {
    if (!itemId || initialItems) return;
    let cancelled = false;
    (async () => {
      const res = await fetch(`${ENDPOINT}?module=classic&item=${encodeURIComponent(itemId)}`).catch(() => null);
      if (cancelled) return;
      if (!res?.ok) return setError(res ? await errorOf(res) : "Couldn't load the files — check your connection.");
      setItems(((await res.json()) as { attachments: Item[] }).attachments);
    })();
    return () => {
      cancelled = true;
    };
  }, [itemId, initialItems]);

  if (!itemId) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-sm text-white">Files</span>
        <p className="text-sm text-muted">Save the challenge first, then attach files or links to it.</p>
      </div>
    );
  }

  async function run(request: () => Promise<Response>, apply: (data: { attachment?: Item }) => void) {
    setPending(true);
    setError(null);
    try {
      const res = await request();
      if (!res.ok) return setError(await errorOf(res));
      apply((await res.json().catch(() => ({}))) as { attachment?: Item });
    } catch {
      setError("That didn't reach the server — check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  const add = (att?: Item) => att && setItems((cur) => [...(cur ?? []), att]);
  const id = itemId;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-sm text-white">Files</span>
        <span className="text-xs text-muted">
          Uploads up to {formatBytes(ATTACHMENT_MAX_BYTES)} each, {ATTACHMENTS_PER_ITEM_MAX} per challenge, served only
          to whoever can see the challenge.
        </span>
      </div>
      {error && <p className="text-sm text-[#e53e3e]">{error}</p>}
      {items === null ? (
        <p className="text-sm text-muted">Checking…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">No files yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((a) => (
            <li key={a.id} className="flex flex-col gap-0.5 rounded border border-white/10 px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-white">{a.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  disabled={pending}
                  onClick={() =>
                    void run(
                      () => fetch(`${ENDPOINT}?id=${a.id}`, { method: "DELETE" }),
                      () => setItems((cur) => (cur ?? []).filter((x) => x.id !== a.id)),
                    )
                  }
                  className="rounded px-1.5 py-0.5 text-xs text-zinc-300 hover:bg-white/[0.08] hover:text-white disabled:opacity-30"
                >
                  <span aria-hidden="true">✕</span>
                </button>
              </div>
              {a.kind === "upload" ? (
                <>
                  <span className="text-xs text-muted">
                    {formatBytes(a.size ?? 0)} · sha256 <span className="break-all font-mono">{a.sha256}</span>
                  </span>
                  {a.missing && (
                    <span className="text-xs text-[#d4a017]">
                      Missing on this box — re-upload {a.name} (sha256 {a.sha256}). Contestants don&rsquo;t see it until then.
                    </span>
                  )}
                </>
              ) : (
                <>
                  <span className="break-all text-xs text-muted">{a.url}</span>
                  <span className="text-xs text-[#d4a017]">{LINK_WARNING}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <label className="flex flex-col gap-1 text-sm text-zinc-300">
        Upload a file
        <input
          type="file"
          disabled={pending}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            if (file.size > ATTACHMENT_MAX_BYTES) {
              setError(`A file can be at most ${formatBytes(ATTACHMENT_MAX_BYTES)} — this one is ${formatBytes(file.size)}`);
              return;
            }
            void run(
              () =>
                fetch(`${ENDPOINT}?module=classic&item=${encodeURIComponent(id)}&name=${encodeURIComponent(file.name)}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/octet-stream" },
                  body: file,
                }),
              (data) => add(data.attachment),
            );
          }}
          className="text-sm text-zinc-300 file:mr-3 file:rounded-md file:border file:border-white/15 file:bg-transparent file:px-3 file:py-1 file:text-white"
        />
      </label>
      <div className="flex flex-col gap-1">
        <span className="text-sm text-zinc-300">Or link a file hosted elsewhere (any size)</span>
        <div className="flex flex-wrap gap-2">
          <input
            value={linkName}
            placeholder="Name, e.g. disk.img"
            disabled={pending}
            onChange={(e) => setLinkName(e.target.value)}
            className={`w-40 ${INPUT_CLASS}`}
          />
          <input
            value={linkUrl}
            placeholder="https://…"
            disabled={pending}
            onChange={(e) => setLinkUrl(e.target.value)}
            className={`flex-1 ${INPUT_CLASS}`}
          />
          <button
            type="button"
            disabled={pending || !linkName.trim() || !linkUrl.trim()}
            onClick={() =>
              void run(
                () =>
                  fetch(ENDPOINT, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ module: "classic", item: id, link: { name: linkName, url: linkUrl } }),
                  }),
                (data) => {
                  add(data.attachment);
                  setLinkName("");
                  setLinkUrl("");
                },
              )
            }
            className={BUTTON}
          >
            Add link
          </button>
        </div>
        <span className="text-xs text-muted">{LINK_WARNING}</span>
      </div>
    </div>
  );
}
