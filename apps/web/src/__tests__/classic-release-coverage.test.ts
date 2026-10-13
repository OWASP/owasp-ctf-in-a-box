// `listChallenges` and `readChallengeRecords` return HIDDEN Jeopardy
// challenges too (disabled, or not yet released): the store cannot know
// whether its caller is a contestant surface. So every CALL has to reach a
// filter from classic-release.ts, and a new reader that forgets would put a
// hidden challenge on some page. This test finds every call in the source
// tree (not a hand-kept list) and follows each one on its own, reading the
// code with the TypeScript compiler rather than as text, so a string, a
// template or a regex literal cannot move the verdict. A call is filtered
// when a list filter wraps it, when `.then` hands it to one, or when the
// variable its result is bound to is filtered later in the same function:
// resolved by the type checker, so another variable of the same name, or a
// filter inside a nested function, does not count. A call whose result
// reaches contestants only through another gate is listed in EXEMPT with the
// reason.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return entry === "__tests__" || entry === "node_modules" ? [] : walk(p);
    return /\.(ts|tsx)$/.test(entry) ? [p] : [];
  });
}

/** Calls that are allowed to stay unfiltered, by file, with how many and
 *  why. A count, so a second unfiltered call in the same file still fails. */
const EXEMPT: Record<string, { calls: number; reason: string }> = {
  "app/(site)/flags/[id]/page.tsx": {
    calls: 2,
    reason:
      "looks up the one challenge the URL names, and renders it or its metadata only after classicVisibility (which filters, and opens hidden ones to admins only) has answered visible",
  },
};

const READERS = new Set(["listChallenges", "readChallengeRecords"]);
/** The list filters from classic-release.ts, which take a list. */
const LIST_FILTERS = new Set(["visibleNow", "visibleChallenges"]);
/** The per-challenge predicate, for `.filter((c) => isChallengeVisible(c, …))`
 *  and a single record looked up from the list. */
const ITEM_FILTER = "isChallengeVisible";

/** One file parsed into a program of its own, so the type checker can resolve
 *  each identifier to its declaration (scope-aware: a shadowing variable of
 *  the same name is a different symbol). No lib and no imports are loaded:
 *  only local bindings need resolving. */
function analyze(source: string, fileName = "scan.tsx") {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === fileName ? sourceFile : undefined),
    writeFile: () => {},
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => "",
    getNewLine: () => "\n",
    fileExists: (name) => name === fileName,
    readFile: () => undefined,
  };
  const program = ts.createProgram([fileName], { noLib: true, noResolve: true, types: [], jsx: ts.JsxEmit.Preserve }, host);
  return { file: program.getSourceFile(fileName)!, checker: program.getTypeChecker() };
}

const calleeName = (call: ts.CallExpression): string | null =>
  ts.isIdentifier(call.expression) ? call.expression.text : null;

/** Walks up through `( … )` and `await`, which do not change the value. */
function valueNode(node: ts.Expression): ts.Expression {
  let n: ts.Expression = node;
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isAwaitExpression(n.parent))) n = n.parent;
  return n;
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  let n = node.parent;
  while (n && !ts.isFunctionLike(n) && !ts.isSourceFile(n)) n = n.parent;
  return n;
}

/** Whether `fn` (an arrow or function expression) calls a list filter on its
 *  own first parameter: `.then((c) => visibleNow(c))`. */
function filtersItsParameter(fn: ts.Node, checker: ts.TypeChecker, filters: Set<string>): boolean {
  if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
  const param = fn.parameters[0]?.name;
  if (!param || !ts.isIdentifier(param)) return false;
  const paramSymbol = checker.getSymbolAtLocation(param);
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && filters.has(calleeName(n) ?? "")) {
      const arg = n.arguments[0];
      if (arg && ts.isIdentifier(arg) && paramSymbol && checker.getSymbolAtLocation(arg) === paramSymbol) found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return found;
}

/** The identifier the value is bound to in a declaration: `const x = v`, or
 *  its position in `const [a, b] = await Promise.all([…, v, …])`. */
function bindingFor(value: ts.Expression): ts.Identifier | null {
  const parent = value.parent;
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === value) {
    return ts.isIdentifier(parent.name) ? parent.name : null;
  }
  if (parent && ts.isArrayLiteralExpression(parent)) {
    const all = parent.parent;
    if (
      all &&
      ts.isCallExpression(all) &&
      ts.isPropertyAccessExpression(all.expression) &&
      ts.isIdentifier(all.expression.expression) &&
      all.expression.expression.text === "Promise" &&
      /^all(Settled)?$/.test(all.expression.name.text)
    ) {
      const decl = valueNode(all).parent;
      if (decl && ts.isVariableDeclaration(decl) && ts.isArrayBindingPattern(decl.name)) {
        const element = decl.name.elements[parent.elements.indexOf(value)];
        return element && ts.isBindingElement(element) && ts.isIdentifier(element.name) ? element.name : null;
      }
    }
  }
  return null;
}

/** Whether `symbol` is filtered later in `scope` (the function that bound
 *  it, never a function nested in it): passed to a filter, or the receiver of
 *  `.filter`/`.find`/`.some` whose callback calls the item filter on its own
 *  parameter. */
function filteredLater(symbol: ts.Symbol, scope: ts.Node, after: number, checker: ts.TypeChecker, filters: Set<string>): boolean {
  let found = false;
  const isSymbol = (e: ts.Expression | undefined) => !!e && ts.isIdentifier(e) && checker.getSymbolAtLocation(e) === symbol;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (n !== scope && ts.isFunctionLike(n)) {
      // A nested function is someone else's flow, except a `.filter`
      // callback, which the receiver check below reads on its own.
      return;
    }
    if (n.pos >= after && ts.isCallExpression(n)) {
      if (filters.has(calleeName(n) ?? "") && isSymbol(n.arguments[0])) found = true;
      const callee = n.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        /^(filter|find|some)$/.test(callee.name.text) &&
        isSymbol(callee.expression) &&
        n.arguments[0] &&
        filtersItsParameter(n.arguments[0], checker, new Set([ITEM_FILTER]))
      ) {
        found = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

function callFiltered(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const value = valueNode(call);
  // (a) An argument of a list filter: visibleNow(await listChallenges()).
  const outer = value.parent;
  if (outer && ts.isCallExpression(outer) && outer.arguments.includes(value) && LIST_FILTERS.has(calleeName(outer) ?? "")) return true;
  // (b) The receiver of .then(filter) or .then((c) => visibleNow(c)…).
  const access = call.parent;
  if (access && ts.isPropertyAccessExpression(access) && access.expression === call && access.name.text === "then") {
    const then = access.parent;
    const f = then && ts.isCallExpression(then) ? then.arguments[0] : undefined;
    if (f && ts.isIdentifier(f) && LIST_FILTERS.has(f.text)) return true;
    if (f && filtersItsParameter(f, checker, LIST_FILTERS)) return true;
  }
  // (c) Bound, then filtered later in the same function: the list itself,
  // or one record looked up from it with `.find(…)` and checked.
  let bound = bindingFor(value);
  let filters = LIST_FILTERS;
  if (!bound) {
    const find = value.parent;
    if (find && ts.isPropertyAccessExpression(find) && find.expression === value && find.name.text === "find" && find.parent && ts.isCallExpression(find.parent)) {
      bound = bindingFor(valueNode(find.parent));
      filters = new Set([ITEM_FILTER]);
    }
  }
  if (!bound) return false;
  const symbol = checker.getSymbolAtLocation(bound);
  const scope = enclosingFunction(bound);
  if (!symbol || !scope) return false;
  return filteredLater(symbol, ts.isSourceFile(scope) ? scope : (scope as ts.FunctionLikeDeclaration).body ?? scope, bound.end, checker, filters);
}

/** The offset of every call in `source` that reaches no filter. */
export function unfilteredCalls(source: string): number[] {
  if (!/\b(listChallenges|readChallengeRecords)\b/.test(source)) return [];
  const { file, checker } = analyze(source);
  const out: number[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && READERS.has(calleeName(n) ?? "") && !callFiltered(n, checker)) out.push(n.getStart(file));
    ts.forEachChild(n, visit);
  };
  visit(file);
  return out;
}

/** Every call to a reader in `source`, filtered or not. */
function readerCalls(source: string): number {
  const file = ts.createSourceFile("scan.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let count = 0;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && READERS.has(calleeName(n) ?? "")) count += 1;
    ts.forEachChild(n, visit);
  };
  visit(file);
  return count;
}

describe("the scan itself", () => {
  it("fails a file with two calls when only one is filtered", () => {
    const fixture = `
export async function page() {
  const [shown, other] = await Promise.all([listChallenges(), listCategories()]);
  const list = visibleNow(shown);
  const all = await listChallenges();
  return [list, all, other];
}
`;
    expect(unfilteredCalls(fixture)).toHaveLength(1);
    expect(unfilteredCalls(fixture.replace("return [list, all, other];", "return [list, visibleNow(all), other];"))).toEqual([]);
  });

  it("follows each data flow it accepts", () => {
    const ok = [
      "const a = visibleNow(await listChallenges());",
      "x(listChallenges().then(visibleNow));",
      "x(listChallenges().then((c) => visibleNow(c).length));",
      "function f() { const all = await listChallenges(); const k = cond ? all : visibleChallenges(all, now); }",
      "function f() { const records = await readChallengeRecords(); const v = records.filter((c) => isChallengeVisible(c, now)); }",
      "function f() { const record = (await listChallenges()).find((c) => c.id === id); return !isChallengeVisible(record, now); }",
    ];
    for (const src of ok) expect(unfilteredCalls(src), src).toEqual([]);
    // A filter on a DIFFERENT variable, or in another function, does not count.
    expect(unfilteredCalls("function f() { const a = await listChallenges(); visibleNow(b); }")).toHaveLength(1);
    expect(unfilteredCalls("function f() { const a = await listChallenges(); } function g() { visibleNow(a); }")).toHaveLength(1);
  });
});

describe("the scan reads code, not text", () => {
  it("accepts a filtered binding whose name a regex would misread", () => {
    expect(unfilteredCalls("async function f() { const $list = await listChallenges(); return visibleNow($list); }")).toEqual([]);
  });

  it("does not take an unrelated filter in the same statement for this call's", () => {
    expect(unfilteredCalls("async function f() { const all = await listChallenges(); all.find((x) => y); isChallengeVisible(other); }")).toHaveLength(1);
    expect(unfilteredCalls("async function f() { const all = await listChallenges(); const r = all.find((x) => x.id === id), z = isChallengeVisible(other, 0); }")).toHaveLength(1);
  });

  it("is not moved by braces inside strings, template literals or regex literals", () => {
    const body = (filter: string) =>
      `async function f() { const s = "}}"; const all = await listChallenges(); const t = \`}\${"{"}\`; const r = /}}/; const u = '}'; ${filter} }`;
    expect(unfilteredCalls(body("return visibleNow(all);"))).toEqual([]);
    expect(unfilteredCalls(body("return all;"))).toHaveLength(1);
  });

  it("does not count a filter inside a nested function, on another value or on the same one", () => {
    expect(unfilteredCalls("async function f() { const all = await listChallenges(); const g = () => visibleNow(other); return all; }")).toHaveLength(1);
    expect(unfilteredCalls("async function f() { const all = await listChallenges(); const g = () => visibleNow(all); return g; }")).toHaveLength(1);
  });

  it("does not take a shadowing variable of the same name for the bound one", () => {
    expect(unfilteredCalls("async function f() { const all = await listChallenges(); { const all = []; visibleNow(all); } return all; }")).toHaveLength(1);
  });
});

describe("every call to the Jeopardy challenge list reaches a visibility filter", () => {
  const files = walk(SRC).map((p) => ({ path: relative(SRC, p), src: readFileSync(p, "utf8") }));
  const unfiltered = files
    .map(({ path, src }) => ({ path, calls: unfilteredCalls(src).length }))
    .filter((f) => f.calls > 0);

  it("finds the readers it is meant to check", () => {
    const readers = files.filter(({ src }) => readerCalls(src) > 0).map((f) => f.path);
    // Non-vacuous: the board, the graders and the leaderboard are readers.
    expect(readers).toEqual(
      expect.arrayContaining(["app/(site)/flags/page.tsx", "lib/classic-store.ts", "lib/hint-store.ts", "lib/leaderboard/module-contributions.ts"]),
    );
  });

  it("leaves no call unfiltered beyond the exemptions, each of which gives its reason", () => {
    const exempted = Object.fromEntries(Object.entries(EXEMPT).map(([path, e]) => [path, e.calls]));
    expect(Object.fromEntries(unfiltered.map((f) => [f.path, f.calls]))).toEqual(exempted);
    for (const e of Object.values(EXEMPT)) expect(e.reason.length).toBeGreaterThan(20);
  });
});
