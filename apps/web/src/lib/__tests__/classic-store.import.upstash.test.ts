import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { liveConfigured } from "./live-redis";

vi.mock("server-only", () => ({}));
// Only key names change: the parser, stores, REST client and Lua run normally.
// Run-unique keys keep the import's whole-board reads isolated from other suites.
vi.mock("@/lib/classic-keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/classic-keys")>();
  const { liveKey } = await import("./live-redis");
  return {
    ...actual,
    CLASSIC_CATEGORIES_KEY: liveKey("classic-import", "categories"),
    CLASSIC_CHALLENGES_KEY: liveKey("classic-import", "challenges"),
    CLASSIC_FLAG_KEY: liveKey("classic-import", "flags"),
    CLASSIC_FLAGNORM_KEY: liveKey("classic-import", "flagnorm"),
    CLASSIC_HINTS_KEY: liveKey("classic-import", "hints"),
    CLASSIC_STORIES_KEY: liveKey("classic-import", "stories"),
  };
});
vi.mock("@/lib/attachments-keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/attachments-keys")>();
  const { liveKey } = await import("./live-redis");
  return {
    ...actual,
    ATTACHMENTS_META_KEY: liveKey("classic-import", "attachment-meta"),
    ATTACHMENTS_INDEX_KEY: liveKey("classic-import", "attachment-index"),
    ATTACHMENTS_BLOB_KEY: liveKey("classic-import", "attachment-blob"),
    ATTACHMENTS_BYTES_KEY: liveKey("classic-import", "attachment-bytes"),
  };
});
vi.mock("@/lib/admin-audit-keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-audit-keys")>();
  const { liveKey } = await import("./live-redis");
  return { ...actual, ADMIN_AUDIT_KEY: liveKey("classic-import", "audit") };
});

import {
  CLASSIC_CATEGORIES_MAX,
  CLASSIC_CATEGORIES_KEY,
  CLASSIC_CHALLENGES_KEY,
  CLASSIC_FLAG_KEY,
  CLASSIC_FLAGNORM_KEY,
  CLASSIC_HINTS_KEY,
  CLASSIC_STORIES_KEY,
} from "@/lib/classic-keys";
import { ATTACHMENTS_META_KEY, ATTACHMENTS_INDEX_KEY, ATTACHMENTS_BLOB_KEY, ATTACHMENTS_BYTES_KEY } from "@/lib/attachments-keys";
import { ADMIN_AUDIT_KEY } from "@/lib/admin-audit-keys";
import { parseBundle, serializeBundle, type ClassicBundle, type ClassicBundleChallenge } from "@/lib/classic-io";
import { ClassicValidationError, exportBundle, importBundle, listCategories, listChallengesForAdmin, setCategories } from "@/lib/classic-store";
import { exportAttachmentFiles, importClassicBundle } from "@/lib/attachment-files-store";
import { importBundleResponse } from "@/app/api/admin/classic/import-response";
import { assertPipelineOk, upstashPipeline } from "@/lib/upstash";

const keys = [CLASSIC_CATEGORIES_KEY, CLASSIC_CHALLENGES_KEY, CLASSIC_FLAG_KEY, CLASSIC_FLAGNORM_KEY,
  CLASSIC_HINTS_KEY, CLASSIC_STORIES_KEY, ATTACHMENTS_META_KEY, ATTACHMENTS_INDEX_KEY,
  ATTACHMENTS_BLOB_KEY, ATTACHMENTS_BYTES_KEY, ADMIN_AUDIT_KEY];
const categories = (count: number, prefix = "Existing") => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);
const challenge = (id: string, category: string): ClassicBundleChallenge => ({
  id, title: id, category, description: "Original description", points: 25, order: 0,
  flag: "Flag{Original}", hint: "Original hint",
});
function parsed(bundle: ClassicBundle): ClassicBundle {
  const result = parseBundle(serializeBundle(bundle));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.bundle;
}
async function commands(batch: (string | number)[][]) {
  return assertPipelineOk(await upstashPipeline(batch), "classic import test").map((row) => row.result);
}
const clear = () => commands([["DEL", ...keys]]);

// Hash field order may change on re-encoding; values and every other Redis type
// must stay identical. TYPE also lets the read-error test snapshot a wrong type.
async function snapshot() {
  const types = await commands(keys.map((key) => ["TYPE", key]));
  const values = await commands(keys.map((key, i) => {
    switch (types[i]) {
      case "hash": return ["HGETALL", key];
      case "list": return ["LRANGE", key, 0, -1];
      case "string": return ["GET", key];
      case "none": return ["EXISTS", key];
      default: throw new Error(`Unexpected Redis type: ${types[i]}`);
    }
  }));
  return Object.fromEntries(keys.map((key, i) => {
    const raw = values[i];
    const value = types[i] === "hash"
      ? Object.fromEntries((raw as string[]).reduce<[string, string][]>((pairs, field, n, all) => n % 2 === 0 ? [...pairs, [field, all[n + 1]]] : pairs, []).sort(([a], [b]) => a.localeCompare(b)))
      : raw;
    return [key, { type: types[i], value }];
  }));
}
async function roundTrip() {
  const exported = await exportBundle();
  expect(parsed(exported)).toEqual(exported);
  return exported;
}

describe.skipIf(!liveConfigured)("Classic bundle category union against real Redis", () => {
  beforeEach(clear);
  afterAll(clear);

  it("accepts 49 plus 1, and the complete 50-category export parses", async () => {
    const existing = categories(CLASSIC_CATEGORIES_MAX - 1);
    await setCategories(existing);
    const bundle = parsed({ version: 2, categories: ["New"], challenges: [challenge("new-challenge", "New")] });
    await expect(importBundle(bundle)).resolves.toMatchObject({ created: 1, updated: 0 });
    expect(await listCategories()).toEqual([...existing, "New"]);
    expect((await roundTrip()).categories).toHaveLength(CLASSIC_CATEGORIES_MAX);
  });

  it.each([[50, 1], [49, 2], [30, 30]])("rejects %i plus %i before writing and preserves a parseable export", async (held, adding) => {
    await setCategories(categories(held));
    const incoming = categories(adding, "Incoming");
    const bundle = parsed({ version: 2, categories: incoming, challenges: [challenge("new-challenge", incoming[0])] });
    const before = await snapshot();
    const outcome = await importBundle(bundle).catch((error: unknown) => error);
    expect(await snapshot()).toEqual(before);
    expect(outcome).toBeInstanceOf(ClassicValidationError);
    expect(outcome).toMatchObject({ field: "categories" });
    expect((await roundTrip()).categories).toEqual(categories(held));
  });

  it("keeps Web's spelling and position when importing web at the cap", async () => {
    const existing = ["Web", ...categories(CLASSIC_CATEGORIES_MAX - 1)];
    await setCategories(existing);
    await importBundle(parsed({ version: 2, categories: ["web"], challenges: [challenge("web-challenge", "web")] }));
    expect(await listCategories()).toEqual(existing);
    expect((await roundTrip()).challenges[0].category).toBe("Web");
  });

  it("reimports a valid export idempotently without changing challenges or values", async () => {
    await setCategories(categories(CLASSIC_CATEGORIES_MAX - 1));
    const bundle = parsed({ version: 2, categories: ["New"], challenges: [challenge("new-challenge", "New")], stories: [] });
    await importBundle(bundle);
    const before = await snapshot();
    await expect(importBundle(bundle)).resolves.toMatchObject({ created: 0, updated: 1 });
    expect(await snapshot()).toEqual(before);
    await importBundle(parsed(await roundTrip()));
    expect(await snapshot()).toEqual(before);
    expect((await listChallengesForAdmin())[0]).toMatchObject({ flag: "Flag{Original}", hint: "Original hint", challenge: { points: 25 } });
  });

  it("returns categories/400 without changing any content, file bytes or audit entry", async () => {
    const existing = categories(CLASSIC_CATEGORIES_MAX);
    const bytes = Buffer.from("existing uploaded bytes");
    const sha = createHash("sha256").update(bytes).digest("hex");
    await setCategories(existing);
    await importClassicBundle(parsed({
      version: 3, categories: [existing[0]],
      challenges: [{ ...challenge("existing-challenge", existing[0]), attachments: [{ name: "original.bin", size: bytes.length, sha256: sha }] }],
      stories: [{ id: "original-story", title: "Original story", intro: "Original intro", steps: ["existing-challenge"] }],
      attachmentFiles: [{ item: "existing-challenge", sha256: sha, bytes: bytes.toString("base64") }],
    }));
    await commands([["LPUSH", ADMIN_AUDIT_KEY, "existing audit entry"]]);
    const extraBytes = Buffer.from("new uploaded bytes");
    const extraSha = createHash("sha256").update(extraBytes).digest("hex");
    const incoming = parsed({
      version: 3, categories: [existing[0], "New"],
      challenges: [
        { ...challenge("existing-challenge", existing[0]), title: "Changed title", points: 100, flag: "changed-flag", hint: "Changed hint", attachments: [{ name: "new link", url: "https://example.org/new" }] },
        { ...challenge("new-challenge", "New"), attachments: [{ name: "new.bin", size: extraBytes.length, sha256: extraSha }] },
      ],
      stories: [
        { id: "original-story", title: "Changed story", intro: "Changed intro", steps: ["existing-challenge"] },
        { id: "new-story", title: "New story", intro: "", steps: ["new-challenge"] },
      ],
      attachmentFiles: [{ item: "new-challenge", sha256: extraSha, bytes: extraBytes.toString("base64") }],
    });
    const before = await snapshot();
    const exported = await roundTrip();
    const files = await exportAttachmentFiles();
    expect(files).toEqual([{ item: "existing-challenge", sha256: sha, bytes: bytes.toString("base64") }]);
    const response = await importBundleResponse(serializeBundle(incoming), "organizer");
    expect(await snapshot()).toEqual(before);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: "categories", error: expect.stringMatching(/categories/) });
    expect(await roundTrip()).toEqual(exported);
    expect(await exportAttachmentFiles()).toEqual(files);
  });

  it("refuses a real Redis category read error without writing challenges or replacing the bad key", async () => {
    await commands([["HSET", CLASSIC_CATEGORIES_KEY, "wrong", "type"]]);
    const bundle = parsed({ version: 2, categories: ["New"], challenges: [challenge("new-challenge", "New")] });
    const before = await snapshot();
    await expect(importBundle(bundle)).rejects.toThrow(/Upstash read failed before import:.*WRONGTYPE/);
    expect(await snapshot()).toEqual(before);
  });
});
