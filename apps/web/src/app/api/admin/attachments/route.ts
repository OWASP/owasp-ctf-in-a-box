import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { adminErrorLabel, writeAdminAudit } from "@/lib/admin-store";
import { ATTACHMENT_MAX_BYTES, type Attachment, type AttachmentModule } from "@/lib/attachments-keys";
import { AttachmentError, addLink, addUpload, listAttachments, removeAttachment } from "@/lib/attachments-store";
import { readBoundedBytes } from "@/lib/bounded-body";
import { listChallengeIds } from "@/lib/classic-store";

/**
 * Organizer authoring for challenge attachments (#186). `requireAdmin` is the
 * first statement of every handler.
 *
 * - `GET ?module=classic&item=<id>` — the item's attachments.
 * - `POST ?module=classic&item=<id>&name=<name>` with a raw
 *   `application/octet-stream` body — an upload. The body is read bounded at
 *   the 5 MiB cap (a declared `Content-Length` over it is refused before
 *   reading); size and sha256 are computed by the store from the bytes read.
 * - `POST` `application/json` exactly `{ module, item, link: { name, url } }`
 *   — an external link.
 * - `DELETE ?id=<attachmentId>` — removes one.
 *
 * Only `classic` adopts attachments today; the item must exist. A cap or
 * shape refusal is a 400 carrying the store's sentence; a Redis failure a 503.
 * Audit lines carry the item, kind, name and size — never bytes or a URL.
 */

const MODULES = new Set<AttachmentModule>(["classic"]);
const LINK_KEYS = new Set(["module", "item", "link"]);

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** What the admin UI sees: chunk bookkeeping stays in the store. */
function view({ chunks: _chunks, ...att }: Attachment): Omit<Attachment, "chunks"> {
  return att;
}

function failure(err: unknown): Response {
  if (err instanceof AttachmentError) return bad(err.message);
  console.error("[admin/attachments] store failed:", adminErrorLabel(err));
  return bad("attachments store failed", 503);
}

async function itemExists(module: AttachmentModule, item: string): Promise<boolean> {
  return module === "classic" && (await listChallengeIds()).has(item);
}

export async function GET(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });
  const q = new URL(request.url).searchParams;
  const owner = q.get("module") as AttachmentModule;
  const item = q.get("item") ?? "";
  if (!MODULES.has(owner) || !item) return bad("module and item are required");
  try {
    return NextResponse.json({ attachments: (await listAttachments(owner, item)).map(view) });
  } catch (err) {
    return failure(err);
  }
}

export async function POST(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  if ((request.headers.get("content-type") ?? "").startsWith("application/json")) {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const link = body?.link as Record<string, unknown> | undefined;
    if (
      !body ||
      typeof body !== "object" ||
      Object.keys(body).some((k) => !LINK_KEYS.has(k)) ||
      !MODULES.has(body.module as AttachmentModule) ||
      typeof body.item !== "string" ||
      !link ||
      typeof link !== "object" ||
      Object.keys(link).some((k) => k !== "name" && k !== "url") ||
      typeof link.name !== "string" ||
      typeof link.url !== "string"
    ) {
      return bad("expected exactly { module, item, link: { name, url } }");
    }
    const owner = body.module as AttachmentModule;
    try {
      if (!(await itemExists(owner, body.item))) return bad(`No challenge with id ${body.item}`);
      const att = await addLink(owner, body.item, link.name, link.url);
      await writeAdminAudit(gate.login, "attachment-add", { item: body.item, kind: "link", name: att.name });
      return NextResponse.json({ attachment: view(att) });
    } catch (err) {
      return failure(err);
    }
  }

  const q = new URL(request.url).searchParams;
  const owner = q.get("module") as AttachmentModule;
  const item = q.get("item") ?? "";
  const name = q.get("name") ?? "";
  if (!MODULES.has(owner) || !item || !name) return bad("module, item and name are required");
  const tooLarge = () => bad(`A file can be at most ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB`, 413);
  if (Number(request.headers.get("content-length") ?? 0) > ATTACHMENT_MAX_BYTES) return tooLarge();
  try {
    if (!(await itemExists(owner, item))) return bad(`No challenge with id ${item}`);
  } catch (err) {
    return failure(err);
  }
  const read = await readBoundedBytes(request, ATTACHMENT_MAX_BYTES);
  if (!read.ok) return read.reason === "too_large" ? tooLarge() : bad("could not read the upload");
  try {
    const att = await addUpload(owner, item, name, read.bytes);
    await writeAdminAudit(gate.login, "attachment-add", { item, kind: "upload", name: att.name, size: att.size });
    return NextResponse.json({ attachment: view(att) });
  } catch (err) {
    return failure(err);
  }
}

export async function DELETE(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  try {
    if (!(await removeAttachment(id))) return bad("no such attachment", 404);
  } catch (err) {
    return failure(err);
  }
  await writeAdminAudit(gate.login, "attachment-remove", { id });
  return NextResponse.json({ ok: true });
}
