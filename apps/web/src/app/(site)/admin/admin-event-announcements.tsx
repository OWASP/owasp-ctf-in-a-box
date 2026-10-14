"use client";

// The Event tab's "Discord announcements" section (#590). Self-contained on
// purpose — the config and the webhook URL live in their own Redis keys,
// not in ctf:admin:settings, so this section owns its GET and writes rather
// than threading them through admin-controls.tsx's settings state (the same
// split admin-event-images.tsx follows).
//
// The webhook URL is write-only from this component's point of view: the
// server never returns it, only a `webhookConfigured` flag, so the field is
// always blank and shows "configured" state text instead. Send test is a
// direct POST whose result is the point; it never touches the switch state.
// Every save is immediate (one field per request), like the image pickers.

import { useCallback, useEffect, useRef, useState } from "react";
import AdminSwitch from "@/components/admin-switch";
import { FieldStatusLine, type FieldStatus } from "@/components/admin-number-field";
import type { AnnouncementKind, DiscordPublicConfig } from "@/lib/discord-config";
import type { AnnounceStatus } from "@/lib/announce/store";
import type { DiscordMessage } from "@/lib/announce/messages";

type Load = { state: "loading" } | { state: "ready"; config: DiscordPublicConfig; status: AnnounceStatus } | { state: "failed"; message: string };

type PreviewState = { kind: AnnouncementKind; message: DiscordMessage } | null;

const SWITCHES: { key: keyof DiscordPublicConfig; id: string; label: string; help: string; kind: AnnouncementKind }[] = [
  { key: "releases", id: "ann-releases", label: "Challenge releases", help: "Post when a challenge becomes publicly visible.", kind: "release" },
  { key: "firstBlood", id: "ann-first-blood", label: "First blood", help: "Post the first solve of each challenge.", kind: "first-blood" },
  { key: "leaders", id: "ann-leaders", label: "Leaderboard changes", help: "Post when the top of the board changes.", kind: "leader" },
  { key: "launch", id: "ann-launch", label: "Event launch", help: "Post when the event goes live.", kind: "launch" },
  { key: "pause", id: "ann-pause", label: "Scoring paused / resumed", help: "Post both edges of a scoring freeze.", kind: "pause" },
  { key: "registration", id: "ann-registration", label: "Registration closed", help: "Post when team registration closes for good.", kind: "registration-closed" },
  { key: "milestones", id: "ann-milestones", label: "Remaining-time checks", help: "Post at each configured mark before scoring closes.", kind: "milestone" },
  { key: "daily", id: "ann-daily", label: "Daily summary", help: "Post once a day at the configured time.", kind: "daily" },
];

/** The server"s refusal text, or a fixed status-coded fallback when the
 *  body is not JSON or carries no error string. */
async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Request failed (${res.status}).`;
}

/** Whether a blur-save should POST at all: only when the trimmed input
 *  differs from what the server already has (a blur with no edit must not
 *  write an audit entry). Exported so the suite can pin it — there is no DOM
 *  in this repo's tests. */
export function blurNeedsSave(value: string, stored: string): boolean {
  return value.trim() !== stored;
}

/** Folds ONE request's config response into the currently displayed config.
 *  Only the keys that request wrote are taken from the response: a
 *  concurrent save for a different key may have landed after this request
 *  read Redis, and this response's copy of THAT key would be stale —
 *  replacing the whole config would show the other control out of step with
 *  what is actually stored. `keysWritten` names what this response is
 *  authoritative for. Exported so the suite can pin it without a DOM. */
export function mergePatched(config: DiscordPublicConfig, keysWritten: readonly string[], fresh: DiscordPublicConfig): DiscordPublicConfig {
  const next = { ...config } as Record<string, unknown>;
  const source = fresh as Record<string, unknown>;
  for (const key of keysWritten) {
    if (key in source) next[key] = source[key];
  }
  return next as DiscordPublicConfig;
}

/** The Event tab"s self-contained Discord announcements panel: webhook
 *  (write-only), per-type switches, previews, Send test and the delivery
 *  status line. */
export default function AdminEventAnnouncements({ timeZone }: { timeZone: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [fieldStatus, setFieldStatus] = useState<Partial<Record<string, FieldStatus>>>({});
  const [webhookInput, setWebhookInput] = useState("");
  const [webhookBusy, setWebhookBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewState>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const inFlight = useRef<Set<string>>(new Set());

  /** One GET of the config + status, with NO setState in it — so the mount
   *  effect can call it synchronously and only settle state inside the
   *  promise callbacks (the same shape admin-event-images.tsx uses). */
  const readConfig = useCallback(
    () =>
      fetch("/api/admin/announcements", { cache: "no-store" }).then(async (res) => {
        if (!res.ok) throw new Error(await errorOf(res));
        return (await res.json()) as { config: DiscordPublicConfig; status: AnnounceStatus };
      }),
    [],
  );

  /** Re-reads config + status after an action whose own response is not the
   *  fresh config (Send test). */
  const reload = useCallback(async () => {
    try {
      const body = await readConfig();
      setLoad({ state: "ready", config: body.config, status: body.status });
    } catch (err) {
      setLoad({ state: "failed", message: err instanceof Error ? err.message : "Could not read the announcement settings." });
    }
  }, [readConfig]);

  useEffect(() => {
    let cancelled = false;
    readConfig().then(
      (body) => {
        if (!cancelled) setLoad({ state: "ready", config: body.config, status: body.status });
      },
      (err: unknown) => {
        if (!cancelled) setLoad({ state: "failed", message: err instanceof Error ? err.message : "Could not read the announcement settings." });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [readConfig]);

  const config = load.state === "ready" ? load.config : null;
  const status = load.state === "ready" ? load.status : null;
  const busy = load.state !== "ready" || webhookBusy || testBusy || previewBusy;

  /** Records one field"s status line (pending/saved/rejected). */
  function report(key: string, s: FieldStatus) {
    setFieldStatus((prev) => ({ ...prev, [key]: s }));
  }

  /** Saves one field (or switch) to the config endpoint. Returns whether the
   *  value is NOW IN EFFECT: true only when the server accepted and returned
   *  the new config; false on a rejection, a network failure, or a save that
   *  was skipped because one for the same key is already in flight. The
   *  text/time/number inputs use this to restore the stored value after a
   *  failed save — an input must never keep showing a value that is not in
   *  effect. */
  async function savePatch(patch: Record<string, unknown>, key: string): Promise<boolean> {
    if (inFlight.current.has(key)) return false;
    inFlight.current.add(key);
    report(key, { state: "pending" });
    try {
      const res = await fetch("/api/admin/announcements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        report(key, { state: "rejected", message: await errorOf(res) });
        return false;
      }
      const body = (await res.json()) as { config: DiscordPublicConfig };
      setLoad((prev) => (prev.state === "ready" ? { ...prev, config: mergePatched(prev.config, Object.keys(patch), body.config) } : prev));
      report(key, { state: "saved" });
      return true;
    } catch {
      report(key, { state: "rejected", message: "Request failed — check the connection and try again." });
      return false;
    } finally {
      inFlight.current.delete(key);
    }
  }

  /** On blur: save the field only when it actually differs from the stored
   *  config (a blur with no edit must not POST and write an audit entry),
   *  and put the stored value back when the save fails. `currentTarget` is
   *  captured synchronously — it is null by the time the promise settles. */
  function saveOnBlur<K extends "marks" | "dailyAt" | "dailyTopN">(key: K, el: HTMLInputElement, stored: string, toPatch: (value: string) => Record<string, unknown>) {
    if (!blurNeedsSave(el.value, stored)) return;
    void savePatch(toPatch(el.value), key).then((ok) => {
      if (!ok) el.value = stored;
    });
  }

  /** Saves the pasted webhook URL; the response replaces the input with a
   *  blank one (the URL is never round-tripped). */
  async function saveWebhook() {
    if (webhookBusy) return;
    setWebhookBusy(true);
    report("webhook", { state: "pending" });
    try {
      const res = await fetch("/api/admin/announcements/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ webhookUrl: webhookInput.trim() }),
      });
      if (!res.ok) {
        report("webhook", { state: "rejected", message: await errorOf(res) });
        return;
      }
      const body = (await res.json()) as { config: DiscordPublicConfig };
      setLoad((prev) => (prev.state === "ready" ? { ...prev, config: mergePatched(prev.config, ["webhookConfigured"], body.config) } : prev));
      setWebhookInput("");
      report("webhook", { state: "saved" });
    } catch {
      report("webhook", { state: "rejected", message: "Request failed — check the connection and try again." });
    } finally {
      setWebhookBusy(false);
    }
  }

  /** Clears the stored webhook (POST webhookUrl: null). */
  async function clearWebhook() {
    if (webhookBusy) return;
    setWebhookBusy(true);
    report("webhook", { state: "pending" });
    try {
      const res = await fetch("/api/admin/announcements/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ webhookUrl: null }),
      });
      if (!res.ok) {
        report("webhook", { state: "rejected", message: await errorOf(res) });
        return;
      }
      const body = (await res.json()) as { config: DiscordPublicConfig };
      setLoad((prev) => (prev.state === "ready" ? { ...prev, config: mergePatched(prev.config, ["webhookConfigured"], body.config) } : prev));
      report("webhook", { state: "saved" });
    } catch {
      report("webhook", { state: "rejected", message: "Request failed — check the connection and try again." });
    } finally {
      setWebhookBusy(false);
    }
  }

  /** Posts the Send-test message server-side and refreshes the status. */
  async function sendTest() {
    if (testBusy) return;
    setTestBusy(true);
    report("test", { state: "pending" });
    try {
      const res = await fetch("/api/admin/announcements/test", { method: "POST" });
      if (!res.ok) {
        report("test", { state: "rejected", message: await errorOf(res) });
        return;
      }
      report("test", { state: "saved" });
      await reload();
    } catch {
      report("test", { state: "rejected", message: "Request failed — check the connection and try again." });
    } finally {
      setTestBusy(false);
    }
  }

  /** Renders what ONE kind would post — built server-side by the very same
   *  builders the announcer uses, so a preview is byte-identical to a live
   *  message. Never sends anything; no webhook is read. */
  async function showPreview(kind: AnnouncementKind) {
    if (previewBusy) return;
    setPreviewBusy(true);
    report("preview", { state: "pending" });
    try {
      const res = await fetch("/api/admin/announcements/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      if (!res.ok) {
        report("preview", { state: "rejected", message: await errorOf(res) });
        return;
      }
      const body = (await res.json()) as { message: DiscordMessage };
      setPreview({ kind, message: body.message });
      report("preview", { state: "saved" });
    } catch {
      report("preview", { state: "rejected", message: "Request failed — check the connection and try again." });
    } finally {
      setPreviewBusy(false);
    }
  }

  if (load.state === "loading") {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-white">Discord announcements</h3>
        <p className="text-sm text-muted">Loading…</p>
      </div>
    );
  }
  if (load.state === "failed") {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-white">Discord announcements</h3>
        <p role="alert" className="text-xs text-[#e53e3e]">
          Could not read the announcement settings: {load.message}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="discord-announcements">
      <div>
        <h3 className="text-white">Discord announcements</h3>
        <p className="text-sm text-muted">
          Post event activity to a Discord channel via a webhook. Nothing is configured by default; each type below is its own opt-in. The webhook
          URL is stored in its own Redis key — never in the settings hash, never returned by any API, and never logged.
        </p>
      </div>

      {/* Webhook URL: write-only. The server never returns it, so the field
          stays blank and the state text says whether one is configured. */}
      <div className="flex flex-col gap-1">
        <label htmlFor="ann-webhook-url" className="text-sm text-white">
          Webhook URL
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="ann-webhook-url"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={config?.webhookConfigured ? "A webhook is configured — paste a new URL to replace it" : "https://discord.com/api/webhooks/…"}
            value={webhookInput}
            disabled={busy}
            onChange={(e) => setWebhookInput(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-[#1a1a2e] px-2.5 py-1.5 font-mono text-xs text-white placeholder:text-muted"
            aria-describedby="ann-webhook-help ann-webhook-status"
          />
          <button
            type="button"
            onClick={saveWebhook}
            disabled={busy || webhookInput.trim() === ""}
            className="rounded-md border border-[#2563eb]/45 px-2.5 py-1.5 font-mono text-xs text-white hover:border-[#2563eb] disabled:opacity-40"
          >
            Save
          </button>
          <button
            type="button"
            onClick={clearWebhook}
            disabled={busy || !config?.webhookConfigured}
            className="rounded-md border border-white/10 px-2.5 py-1.5 font-mono text-xs text-zinc-300 hover:border-[#e53e3e]/45 hover:text-white disabled:opacity-40"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={sendTest}
            disabled={busy || !config?.webhookConfigured}
            className="rounded-md border border-white/10 px-2.5 py-1.5 font-mono text-xs text-zinc-300 hover:border-[#2563eb]/45 hover:text-white disabled:opacity-40"
          >
            Send test
          </button>
        </div>
        <p id="ann-webhook-help" className="text-xs text-muted">
          {config?.webhookConfigured ? "A webhook is configured." : "No webhook configured — nothing is posted until one is saved."} Must be a
          discord.com webhook URL (Server Settings → Integrations → Webhooks). Challenges already public are never replayed when you save.
        </p>
        <FieldStatusLine id="ann-webhook-status" status={fieldStatus.webhook ?? { state: "idle" }} />
        <FieldStatusLine id="ann-test-status" status={fieldStatus.test ?? { state: "idle" }} />
      </div>

      {SWITCHES.map((row) => (
        <div key={row.key} className="flex flex-col gap-1">
          <AdminSwitch
            id={row.id}
            label={row.label}
            help={row.help}
            checked={Boolean(config?.[row.key])}
            disabled={busy}
            status={fieldStatus[row.key] ?? { state: "idle" }}
            onChange={(next) => void savePatch({ [row.key]: next }, row.key)}
          />
          {Boolean(config?.[row.key]) && (
            <div className="ml-1">
              <button
                type="button"
                onClick={() => void showPreview(row.kind)}
                disabled={busy}
                className="rounded-md border border-white/10 px-2 py-1 font-mono text-xs text-zinc-300 hover:border-[#2563eb]/45 hover:text-white disabled:opacity-40"
              >
                Preview
              </button>
            </div>
          )}
          {row.key === "leaders" && config?.leaders && (
            <div className="ml-1 flex items-center gap-2">
              <label htmlFor="ann-leader-scope" className="text-xs text-muted">
                Scope
              </label>
              <select
                id="ann-leader-scope"
                value={config?.leaderScope ?? "first"}
                disabled={busy}
                onChange={(e) => void savePatch({ leaderScope: e.target.value }, "leaderScope")}
                className="rounded-md border border-white/10 bg-[#1a1a2e] px-2 py-1 font-mono text-xs text-white"
              >
                <option value="first">New #1 only</option>
                <option value="top3">Any top-three change</option>
              </select>
              <FieldStatusLine id="ann-leader-scope-status" status={fieldStatus.leaderScope ?? { state: "idle" }} />
            </div>
          )}
          {row.key === "milestones" && config?.milestones && (
            <div className="ml-1 flex items-center gap-2">
              <label htmlFor="ann-marks" className="text-xs text-muted">
                Marks before close
              </label>
              <input
                id="ann-marks"
                type="text"
                defaultValue={config?.marks ?? ""}
                disabled={busy}
                placeholder="1h, 15m"
                onBlur={(e) => saveOnBlur("marks", e.currentTarget, config?.marks ?? "", (value) => ({ marks: value }))}
                className="w-40 rounded-md border border-white/10 bg-[#1a1a2e] px-2 py-1 font-mono text-xs text-white"
                aria-describedby="ann-marks-status"
              />
              <span className="text-xs text-muted">e.g. 1h, 15m — each at most 7 days, at least 1m</span>
              <FieldStatusLine id="ann-marks-status" status={fieldStatus.marks ?? { state: "idle" }} />
            </div>
          )}
          {row.key === "daily" && config?.daily && (
            <div className="ml-1 flex flex-wrap items-center gap-2">
              <label htmlFor="ann-daily-at" className="text-xs text-muted">
                Post at
              </label>
              <input
                id="ann-daily-at"
                type="time"
                defaultValue={config?.dailyAt ?? "09:00"}
                disabled={busy}
                onBlur={(e) => saveOnBlur("dailyAt", e.currentTarget, config?.dailyAt ?? "09:00", (value) => ({ dailyAt: value }))}
                className="rounded-md border border-white/10 bg-[#1a1a2e] px-2 py-1 font-mono text-xs text-white"
                aria-describedby="ann-daily-at-status"
              />
              <span className="text-xs text-muted">on the event clock ({timeZone})</span>
              <FieldStatusLine id="ann-daily-at-status" status={fieldStatus.dailyAt ?? { state: "idle" }} />
              <label htmlFor="ann-daily-topn" className="ml-2 text-xs text-muted">
                Top
              </label>
              <input
                id="ann-daily-topn"
                type="number"
                min={1}
                max={50}
                defaultValue={config?.dailyTopN ?? 10}
                disabled={busy}
                onBlur={(e) => saveOnBlur("dailyTopN", e.currentTarget, String(config?.dailyTopN ?? 10), (value) => ({ dailyTopN: Number(value) }))}
                className="w-20 rounded-md border border-white/10 bg-[#1a1a2e] px-2 py-1 font-mono text-xs text-white"
                aria-describedby="ann-daily-topn-status"
              />
              <span className="text-xs text-muted">teams in the summary</span>
              <FieldStatusLine id="ann-daily-topn-status" status={fieldStatus.dailyTopN ?? { state: "idle" }} />
            </div>
          )}
        </div>
      ))}

      {/* The preview: the server builds it with the SAME builders a live
          announcement goes through, so what is rendered here is exactly what
          would be posted — nothing is sent, and no webhook is read. */}
      {preview && (
        <div className="rounded-md border border-white/10 bg-[#1a1a2e] p-3" data-testid="ann-preview">
          <p className="text-xs text-muted">
            Preview of “{SWITCHES.find((row) => row.kind === preview.kind)?.label ?? preview.kind}” — exactly what would be posted
            (nothing was sent):
          </p>
          {preview.message.embeds.map((embed, i) => (
            <div key={i} className="mt-2 flex flex-col gap-0.5">
              {embed.title && <p className="text-sm font-semibold text-white">{embed.title}</p>}
              {embed.url && (
                <a href={embed.url} className="text-xs text-[#60a5fa] underline" rel="noreferrer noopener">
                  {embed.url}
                </a>
              )}
              {embed.description && <p className="text-sm text-zinc-200">{embed.description}</p>}
              {embed.fields?.map((field) => (
                <p key={field.name} className="text-xs text-muted">
                  <span className="text-white">{field.name}:</span> {field.value}
                </p>
              ))}
            </div>
          ))}
        </div>
      )}
      <FieldStatusLine id="ann-preview-status" status={fieldStatus.preview ?? { state: "idle" }} />

      {status && (
        <p className="text-xs text-muted" data-testid="ann-status">
          {status.lastPostedAt ? `Last post: ${new Date(status.lastPostedAt).toLocaleString()}` : "Nothing posted yet."}
          {status.lastError ? ` — last failure: ${status.lastError}${status.lastErrorAt ? ` (${new Date(status.lastErrorAt).toLocaleString()})` : ""}` : ""}
        </p>
      )}
    </div>
  );
}
