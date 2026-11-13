import "server-only";

// better-auth's database adapter over the app's Redis. Each model
// is one hash of id -> row JSON (`rowsKey`), with index sets for the fields in
// INDEXED_FIELDS. Every write is a compare-and-set against the JSON the
// adapter just read (scripts.ts), so a row and its index entries change
// atomically and two writers that read the same row cannot both win. A write
// that would give a UNIQUE_FIELDS value (a user's email, an account's
// provider+accountId) to a second row fails instead.
//
// Every reply is checked for shape: a short pipeline reply, or a read reply
// that is not the array Redis sends, throws rather than reading as "no rows",
// because "no user with this email" is what makes the caller create one.
//
// The factory serializes for us: with supportsDates/supportsJSON off it hands
// `create`/`update` ISO strings and JSON strings, turns Date-valued where
// clauses on date fields into ISO strings, and parses rows back on the way
// out. Matching and sorting still compare date fields as instants (see
// `view`), so nothing depends on two ISO strings being formatted alike.
//
// Redis has no multi-command rollback here, so `transaction` compensates
// instead: the callback runs against an adapter that records every row it
// creates, and if the callback throws those rows are deleted again before the
// error is rethrown. createOAuthUser writes the user and then the account
// inside one transaction; without this, a failed account write would leave a
// user row that owns the email but no account, and every later sign-in would
// find it by email and answer "account not linked" (implicit linking is off).
// Only creates are undone: an update or delete inside a failed transaction
// stays applied.

import type { BetterAuthOptions } from "better-auth";
import { createAdapterFactory, type CleanedWhere } from "better-auth/adapters";
import { upstashPipeline } from "@/lib/upstash";
import { AUTH_PREFIX, INDEXED_FIELDS, UNIQUE_FIELDS, indexKey, rowsKey } from "./keys";
import { DEL_ROW_SCRIPT, PUT_ROW_SCRIPT } from "./scripts";
import { idLookup, indexLookup, matchesWhere, sortAndPage } from "./where";

type Row = Record<string, unknown>;
type Snapshot = { id: string; json: string; row: Row };
// A row a transaction created, by better-auth's default model name.
type Created = { model: string; id: string };

// Retries after a lost compare-and-set, per row. A row that keeps changing
// under us this often is contention the caller should see, not absorb.
const MAX_RETRIES = 3;

// The app never calls a provider API with the user's token, so the store
// never holds one: a leaked Redis dump must not hand out GitHub tokens.
const PROVIDER_TOKEN_FIELDS = ["accessToken", "refreshToken", "idToken"] as const;

/**
 * Builds the better-auth database adapter over the app's Redis, with every key under `opts.prefix` (default `AUTH_PREFIX`).
 */
export function redisAdapter(opts: { prefix?: string } = {}) {
  const prefix = opts.prefix ?? AUTH_PREFIX;
  // The options better-auth built the adapter with, reused for each transaction's adapter.
  let authOptions: BetterAuthOptions | null = null;

  /**
   * Builds the adapter factory. `journal` is null outside a transaction; inside
   * one it is that transaction's own list, so concurrent transactions never
   * see or undo each other's rows.
   */
  const build = (journal: Created[] | null) => createAdapterFactory({
    config: {
      adapterId: "ctf-redis",
      adapterName: "CTF Redis",
      usePlural: false,
      supportsJSON: false,
      supportsDates: false,
      supportsBooleans: true,
      supportsArrays: false,
      transaction: async (callback) => {
        if (!authOptions) throw new Error("auth store: transaction before the adapter was initialised");
        const created: Created[] = [];
        const trx = build(created)(authOptions);
        let result;
        try {
          result = await callback(trx);
        } catch (err) {
          await undo(trx, created);
          throw err;
        }
        // A nested transaction's rows belong to the enclosing one from here on,
        // so a later failure there undoes them too.
        journal?.push(...created);
        return result;
      },
    },
    adapter: ({ options, getFieldAttributes, getFieldName, getDefaultModelName }) => {
      authOptions = options;
      /**
       * Builds the error thrown for a failed store operation.
       */
      const fail = (op: string, model: string, error: unknown): Error =>
        new Error(`auth store: ${op} ${model} failed: ${error instanceof Error ? error.message : String(error)}`);

      /**
       * Runs one pipeline and returns each reply's result, throwing on a transport error, a short reply or any per-command error.
       */
      async function run(op: string, model: string, commands: (string | number)[][]): Promise<unknown[]> {
        let replies;
        try {
          replies = await upstashPipeline(commands);
        } catch (err) {
          throw fail(op, model, err);
        }
        if (!Array.isArray(replies) || replies.length !== commands.length) {
          throw fail(op, model, `expected ${commands.length} replies, got ${Array.isArray(replies) ? replies.length : typeof replies}`);
        }
        return replies.map((r) => {
          if (!r || typeof r !== "object") throw fail(op, model, "malformed reply");
          if (r.error) throw fail(op, model, r.error);
          return r.result;
        });
      }

      const dateFields = new Map<string, boolean>();
      /**
       * Whether `field` of `model` is a date in the better-auth schema (memoized).
       */
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

      /**
       * Parses an ISO string into a Date so dates compare as instants; other values pass through.
       */
      function asInstant(v: unknown): unknown {
        if (typeof v !== "string") return v;
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? v : d;
      }

      /**
       * The row as matching and sorting see it: date fields as Date objects.
       */
      function view(model: string, row: Row): Row {
        const out: Row = { ...row };
        for (const field of Object.keys(out)) {
          if (isDateField(model, field)) out[field] = asInstant(out[field]);
        }
        return out;
      }

      /**
       * The where clauses with Date-field values converted the same way as `view`.
       */
      function viewWhere(model: string, where: CleanedWhere[]): CleanedWhere[] {
        return where.map((c) => {
          if (!isDateField(model, c.field)) return c;
          const value = Array.isArray(c.value) ? c.value.map(asInstant) : asInstant(c.value);
          return { ...c, value } as CleanedWhere;
        });
      }

      /**
       * Parses a stored row JSON, throwing when it is not a JSON object.
       */
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

      /**
       * Reads an HGETALL reply into [field, value] pairs. It accepts the flat array or
       * the object form some REST proxies send; anything else is a broken reply, not
       * an empty hash.
       */
      function pairs(op: string, model: string, reply: unknown): [string, string][] {
        const out: [string, string][] = [];
        if (Array.isArray(reply)) {
          if (reply.length % 2 !== 0) throw fail(op, model, "HGETALL reply has an odd length");
          for (let i = 0; i < reply.length; i += 2) {
            if (typeof reply[i] !== "string" || typeof reply[i + 1] !== "string") throw fail(op, model, "HGETALL reply holds a non-string");
            out.push([reply[i], reply[i + 1]]);
          }
          return out;
        }
        if (reply && typeof reply === "object") {
          for (const [k, v] of Object.entries(reply as Record<string, unknown>)) {
            if (typeof v !== "string") throw fail(op, model, "HGETALL reply holds a non-string");
            out.push([k, v]);
          }
          return out;
        }
        throw fail(op, model, `HGETALL reply is ${reply === null ? "null" : typeof reply}, not an array`);
      }

      /**
       * Checks that a reply is an array of strings.
       */
      function stringList(op: string, model: string, command: string, reply: unknown): string[] {
        if (!Array.isArray(reply) || reply.some((m) => typeof m !== "string")) {
          throw fail(op, model, `${command} reply is not an array of strings`);
        }
        return reply as string[];
      }

      /**
       * HMGET: the [id, json] pairs for the ids that exist, in request order.
       */
      async function fetchRows(op: string, model: string, ids: string[]): Promise<[string, string][]> {
        if (ids.length === 0) return [];
        const [values] = await run(op, model, [["HMGET", rowsKey(prefix, model), ...ids]]);
        if (!Array.isArray(values) || values.length !== ids.length) {
          throw fail(op, model, `HMGET reply is not ${ids.length} values`);
        }
        const out: [string, string][] = [];
        values.forEach((v, i) => {
          if (v === null) return; // no such row, or a stale index entry: it matches nothing
          if (typeof v !== "string") throw fail(op, model, "HMGET reply holds a non-string");
          out.push([ids[i], v]);
        });
        return out;
      }

      /**
       * HGET: the row JSON, or null when there is no such row.
       */
      async function fetchRow(op: string, model: string, id: string): Promise<string | null> {
        const [json] = await run(op, model, [["HGET", rowsKey(prefix, model), id]]);
        if (json !== null && typeof json !== "string") throw fail(op, model, "HGET reply is not a string or null");
        return json;
      }

      /**
       * Fetches the candidate rows for a where clause by id, by index or by full scan, narrowest first.
       */
      async function load(op: string, model: string, where: CleanedWhere[]): Promise<[string, string][]> {
        const ids = idLookup(where);
        if (ids) {
          if (ids.length !== 1) return fetchRows(op, model, ids);
          const json = await fetchRow(op, model, ids[0]);
          return json === null ? [] : [[ids[0], json]];
        }
        const hit = indexLookup(model, where);
        if (!hit) {
          const [all] = await run(op, model, [["HGETALL", rowsKey(prefix, model)]]);
          return pairs(op, model, all);
        }
        const [members] = await run(op, model, [["SMEMBERS", indexKey(prefix, model, hit.field, hit.value)]]);
        return fetchRows(op, model, stringList(op, model, "SMEMBERS", members));
      }

      /**
       * Loads, filters, sorts and pages the rows matching `where`, keeping each row's JSON for compare-and-set.
       */
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

      /**
       * Restricts a row to the `select`ed fields.
       */
      function trim(row: Row, select?: string[]): Row {
        if (!select?.length) return row;
        return Object.fromEntries(Object.entries(row).filter(([k]) => select.includes(k)));
      }

      /**
       * Nulls the provider token fields of an account row so no token reaches Redis.
       */
      function scrub(model: string, row: Row): Row {
        if (getDefaultModelName(model) !== "account") return row;
        const out = { ...row };
        for (const field of PROVIDER_TOKEN_FIELDS) out[getFieldName({ model: "account", field })] = null;
        return out;
      }

      /**
       * The model's indexed fields as the CSV the scripts take.
       */
      const csv = (model: string) => (INDEXED_FIELDS[model] ?? []).join(",");
      /**
       * The model's unique fields.
       */
      const uniques = (model: string) => UNIQUE_FIELDS[model] ?? [];

      /**
       * Writes `next` (or deletes the row when null) only if the stored row still equals `snap`.
       * Returns false on a lost race. A taken unique value fails the write instead of
       * retrying: when a GitHub email moves to another contestant's account, the
       * sign-in that would copy it onto a second user row fails until the first row
       * stops holding it.
       */
      async function cas(op: string, model: string, snap: Snapshot | null, id: string, next: Row | null): Promise<boolean> {
        const command =
          next === null
            ? ["EVAL", DEL_ROW_SCRIPT, 1, rowsKey(prefix, model), prefix, model, id, snap?.json ?? "", csv(model)]
            : [
                "EVAL",
                PUT_ROW_SCRIPT,
                1,
                rowsKey(prefix, model),
                prefix,
                model,
                id,
                snap?.json ?? "",
                JSON.stringify(next),
                csv(model),
                uniques(model).join(","),
              ];
        const [result] = await run(op, model, [command]);
        if (result === 1) return true;
        if (result === 0) return false;
        if (result === 2 && next !== null) throw fail(op, model, `unique ${uniques(model).join(", ")} taken`);
        throw fail(op, model, `unexpected script reply ${JSON.stringify(result)}`);
      }

      /**
       * Applies `change` to every snapshot by compare-and-set. A lost race re-reads
       * the row: if it no longer matches `where` it is dropped, otherwise the change
       * is retried against the fresh snapshot.
       */
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
            const json = await fetchRow(op, model, snap.id);
            if (json === null) break;
            const row = parseRow(op, model, json);
            if (!matchesWhere(view(model, row), clauses)) break;
            snap = { id: snap.id, json, row };
          }
        }
        return written;
      }

      /**
       * Builds a row change that merges `update` over the row, keeping its id and scrubbing tokens.
       */
      const patch = (model: string, update: Row) => (row: Row) => scrub(model, { ...row, ...update, id: row.id });

      return {
        async create({ model, data, select }) {
          const row = scrub(model, data as Row);
          const id = row.id;
          if (typeof id !== "string" && typeof id !== "number") throw fail("create", model, "row has no id");
          if (!(await cas("create", model, null, String(id), row))) throw fail("create", model, `row ${String(id)} already exists`);
          journal?.push({ model: getDefaultModelName(model), id: String(id) });
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

  /**
   * Deletes a failed transaction's rows, newest first, through the adapter's own
   * delete so each row's index entries go with it. Best effort: a row that cannot
   * be deleted is logged by model only (never its id or contents) and the rest
   * are still tried, so the caller sees the transaction's own error.
   */
  async function undo(trx: { delete: (args: { model: string; where: { field: string; value: string }[] }) => Promise<void> }, created: Created[]) {
    for (const { model, id } of [...created].reverse()) {
      try {
        await trx.delete({ model, where: [{ field: "id", value: id }] });
      } catch (err) {
        console.error(`auth store: could not undo a ${model} row a failed transaction created`, err instanceof Error ? err.name : "non-Error throw");
      }
    }
  }

  return build(null);
}
