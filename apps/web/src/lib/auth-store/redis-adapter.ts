import "server-only";

// better-auth's database adapter over the app's Redis (issue #736). Each model
// is one hash of id -> row JSON (`rowsKey`), with index sets for the fields in
// INDEXED_FIELDS. Every write is a compare-and-set against the JSON the
// adapter just read (scripts.ts), so a row and its index entries change
// atomically and two writers that read the same row cannot both win.
//
// The factory serializes for us: with supportsDates/supportsJSON off it hands
// `create`/`update` ISO strings and JSON strings, turns Date-valued where
// clauses on date fields into ISO strings, and parses rows back on the way
// out. Matching and sorting still compare date fields as instants (see
// `view`), so nothing depends on two ISO strings being formatted alike.

import { createAdapterFactory, type CleanedWhere } from "better-auth/adapters";
import { upstashPipeline } from "@/lib/upstash";
import { AUTH_PREFIX, INDEXED_FIELDS, indexKey, rowsKey } from "./keys";
import { DEL_ROW_SCRIPT, PUT_ROW_SCRIPT } from "./scripts";
import { indexLookup, matchesWhere, sortAndPage } from "./where";

type Row = Record<string, unknown>;
type Snapshot = { id: string; json: string; row: Row };

// Retries after a lost compare-and-set, per row. A row that keeps changing
// under us this often is contention the caller should see, not absorb.
const MAX_RETRIES = 3;

// The app never calls a provider API with the user's token, so the store
// never holds one: a leaked Redis dump must not hand out GitHub tokens.
const PROVIDER_TOKEN_FIELDS = ["accessToken", "refreshToken", "idToken"] as const;

export function redisAdapter(opts: { prefix?: string } = {}) {
  const prefix = opts.prefix ?? AUTH_PREFIX;

  return createAdapterFactory({
    config: {
      adapterId: "ctf-redis",
      adapterName: "CTF Redis",
      usePlural: false,
      supportsJSON: false,
      supportsDates: false,
      supportsBooleans: true,
      supportsArrays: false,
      transaction: false,
    },
    adapter: ({ getFieldAttributes, getFieldName, getDefaultModelName }) => {
      const fail = (op: string, model: string, error: unknown): Error =>
        new Error(`auth store: ${op} ${model} failed: ${error instanceof Error ? error.message : String(error)}`);

      async function run(op: string, model: string, commands: (string | number)[][]): Promise<unknown[]> {
        let replies;
        try {
          replies = await upstashPipeline(commands);
        } catch (err) {
          throw fail(op, model, err);
        }
        return replies.map((r) => {
          if (r.error) throw fail(op, model, r.error);
          return r.result;
        });
      }

      const dateFields = new Map<string, boolean>();
      function isDateField(model: string, field: string): boolean {
        const key = `${model}\0${field}`;
        let hit = dateFields.get(key);
        if (hit === undefined) {
          try {
            hit = getFieldAttributes({ model, field }).type === "date";
          } catch {
            hit = false;
          }
          dateFields.set(key, hit);
        }
        return hit;
      }

      function asInstant(v: unknown): unknown {
        if (typeof v !== "string") return v;
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? v : d;
      }

      // The row as matching and sorting see it: date fields as Date objects.
      function view(model: string, row: Row): Row {
        const out: Row = { ...row };
        for (const field of Object.keys(out)) {
          if (isDateField(model, field)) out[field] = asInstant(out[field]);
        }
        return out;
      }

      function viewWhere(model: string, where: CleanedWhere[]): CleanedWhere[] {
        return where.map((c) => {
          if (!isDateField(model, c.field)) return c;
          const value = Array.isArray(c.value) ? c.value.map(asInstant) : asInstant(c.value);
          return { ...c, value } as CleanedWhere;
        });
      }

      function parseRow(op: string, model: string, json: string): Row {
        let row: unknown;
        try {
          row = JSON.parse(json);
        } catch {
          throw fail(op, model, "stored row is not JSON");
        }
        if (!row || typeof row !== "object" || Array.isArray(row)) throw fail(op, model, "stored row is not a JSON object");
        return row as Row;
      }

      function pairs(reply: unknown): [string, string][] {
        if (Array.isArray(reply)) {
          const out: [string, string][] = [];
          for (let i = 0; i + 1 < reply.length; i += 2) out.push([String(reply[i]), String(reply[i + 1])]);
          return out;
        }
        if (reply && typeof reply === "object") {
          return Object.entries(reply as Record<string, unknown>).map(([k, v]) => [k, String(v)]);
        }
        return [];
      }

      async function load(op: string, model: string, where: CleanedWhere[]): Promise<[string, string][]> {
        const hit = indexLookup(model, where);
        if (!hit) {
          const [all] = await run(op, model, [["HGETALL", rowsKey(prefix, model)]]);
          return pairs(all);
        }
        const [members] = await run(op, model, [["SMEMBERS", indexKey(prefix, model, hit.field, hit.value)]]);
        const ids = Array.isArray(members) ? members.map(String) : [];
        if (ids.length === 0) return [];
        const [values] = await run(op, model, [["HMGET", rowsKey(prefix, model), ...ids]]);
        const list = Array.isArray(values) ? values : [];
        // An id whose row is gone is a stale index entry; it matches nothing.
        return ids.flatMap((id, i) => (typeof list[i] === "string" ? [[id, list[i] as string] as [string, string]] : []));
      }

      async function read(
        op: string,
        model: string,
        where: CleanedWhere[] = [],
        page: { sortBy?: { field: string; direction: "asc" | "desc" }; offset?: number; limit?: number } = {},
      ): Promise<Snapshot[]> {
        const clauses = viewWhere(model, where);
        const byView = new Map<Row, Snapshot>();
        for (const [id, json] of await load(op, model, where)) {
          const row = parseRow(op, model, json);
          const v = view(model, row);
          if (matchesWhere(v, clauses)) byView.set(v, { id, json, row });
        }
        return sortAndPage([...byView.keys()], page).map((v) => byView.get(v)!);
      }

      function trim(row: Row, select?: string[]): Row {
        if (!select?.length) return row;
        return Object.fromEntries(Object.entries(row).filter(([k]) => select.includes(k)));
      }

      function scrub(model: string, row: Row): Row {
        if (getDefaultModelName(model) !== "account") return row;
        const out = { ...row };
        for (const field of PROVIDER_TOKEN_FIELDS) out[getFieldName({ model: "account", field })] = null;
        return out;
      }

      const csv = (model: string) => (INDEXED_FIELDS[model] ?? []).join(",");

      async function cas(op: string, model: string, snap: Snapshot | null, id: string, next: Row | null): Promise<boolean> {
        const command =
          next === null
            ? ["EVAL", DEL_ROW_SCRIPT, 1, rowsKey(prefix, model), prefix, model, id, snap?.json ?? "", csv(model)]
            : ["EVAL", PUT_ROW_SCRIPT, 1, rowsKey(prefix, model), prefix, model, id, snap?.json ?? "", JSON.stringify(next), csv(model)];
        const [result] = await run(op, model, [command]);
        if (result === 1) return true;
        if (result === 0) return false;
        throw fail(op, model, `unexpected script reply ${JSON.stringify(result)}`);
      }

      // Applies `change` to every snapshot by compare-and-set. A lost race
      // re-reads the row: if it no longer matches `where` it is dropped,
      // otherwise the change is retried against the fresh snapshot.
      async function writeEach(
        op: string,
        model: string,
        where: CleanedWhere[],
        snaps: Snapshot[],
        change: (row: Row) => Row | null,
      ): Promise<Row[]> {
        const clauses = viewWhere(model, where);
        const written: Row[] = [];
        for (const first of snaps) {
          let snap = first;
          for (let attempt = 0; ; attempt++) {
            const next = change(snap.row);
            if (await cas(op, model, snap, snap.id, next)) {
              written.push(next ?? snap.row);
              break;
            }
            if (attempt === MAX_RETRIES) throw fail(op, model, `row ${snap.id} kept changing (compare-and-set lost ${attempt + 1} times)`);
            const [json] = await run(op, model, [["HGET", rowsKey(prefix, model), snap.id]]);
            if (typeof json !== "string") break;
            const row = parseRow(op, model, json);
            if (!matchesWhere(view(model, row), clauses)) break;
            snap = { id: snap.id, json, row };
          }
        }
        return written;
      }

      const patch = (model: string, update: Row) => (row: Row) => scrub(model, { ...row, ...update, id: row.id });

      return {
        async create({ model, data, select }) {
          const row = scrub(model, data as Row);
          const id = row.id;
          if (typeof id !== "string" && typeof id !== "number") throw fail("create", model, "row has no id");
          if (!(await cas("create", model, null, String(id), row))) throw fail("create", model, `row ${String(id)} already exists`);
          return trim(row, select) as typeof data;
        },

        async findOne({ model, where, select }) {
          const [first] = await read("findOne", model, where, { limit: 1 });
          return (first ? trim(first.row, select) : null) as never;
        },

        async findMany({ model, where, limit, select, sortBy, offset }) {
          const rows = await read("findMany", model, where, { sortBy, offset, limit });
          return rows.map((s) => trim(s.row, select)) as never[];
        },

        async count({ model, where }) {
          return (await read("count", model, where)).length;
        },

        async update({ model, where, update }) {
          const snaps = await read("update", model, where);
          const [first] = await writeEach("update", model, where, snaps, patch(model, update as Row));
          return (first ?? null) as never;
        },

        async updateMany({ model, where, update }) {
          const snaps = await read("updateMany", model, where);
          return (await writeEach("updateMany", model, where, snaps, patch(model, update))).length;
        },

        async delete({ model, where }) {
          const snaps = await read("delete", model, where);
          await writeEach("delete", model, where, snaps, () => null);
        },

        async deleteMany({ model, where }) {
          const snaps = await read("deleteMany", model, where);
          return (await writeEach("deleteMany", model, where, snaps, () => null)).length;
        },
      };
    },
  });
}
