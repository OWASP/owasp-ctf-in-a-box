// `listChallenges` and `readChallengeRecords` return HIDDEN Jeopardy
// challenges too (disabled, or not yet released): the store cannot know
// whether its caller is a contestant surface. So every CALL has to reach a
// filter from classic-release.ts, and a new reader that forgets would put a
// hidden challenge on some page. This test finds every call in the source
// tree (not a hand-kept list) and follows each one on its own, reading the
// code with the TypeScript compiler rather than as text, so a string, a
// template or a regex literal cannot move the verdict. A call is filtered
// when a list filter wraps it, when `.then` hands it to one, or when every
// later use of the variable its result is bound to is a filter, in the same
// function; and in each case the filter's RESULT is what flows on (the rules
// are stated above the tests that pin them). Variables are resolved by the
// type checker, so another variable of the same name, or a filter inside a
// nested function, does not count. A call whose result
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
  "lib/classic-visibility.ts": {
    calls: 2,
    reason:
      "the visibility gate itself: classicVisibility hands an admin the whole list and everyone else visibleChallenges(all), and adminSeesHidden looks one record up to ask whether it is hidden; neither returns challenge data",
  },
  "lib/classic-store.ts": {
    calls: 1,
    reason:
      "submitFlag looks the submitted challenge's record up to decide whether it is hidden (deferring its solved/cooldown answers to the script) and builds the story chain from the visible ones; it returns no challenge data, and SUBMIT_SCRIPT refuses a hidden challenge itself",
  },
  "lib/hint-store.ts": {
    calls: 1,
    reason:
      "revealHint builds the story chain from the visible records and checks the hint's challenge exists; it returns no challenge data, and REVEAL_SCRIPT refuses a hidden challenge itself",
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

/** Which filter a callback must return: a list filter on a list, or the
 *  per-challenge predicate inside `.filter` / `.find`. */
type Mode = "list" | "item";

/** Strips `( … )` and `await`, which do not change the value. */
function strip(e: ts.Expression): ts.Expression {
  let n = e;
  while (ts.isParenthesizedExpression(n) || ts.isAwaitExpression(n)) n = n.expression;
  return n;
}

/** The symbol an identifier refers to, the shorthand `{ all }` included
 *  (whose own symbol is the property, not the variable). */
function symbolOf(id: ts.Identifier, checker: ts.TypeChecker): ts.Symbol | undefined {
  const parent = id.parent;
  if (parent && ts.isShorthandPropertyAssignment(parent) && parent.name === id) return checker.getShorthandAssignmentValueSymbol(parent);
  return checker.getSymbolAtLocation(id);
}

/** Whether a value is computed and dropped: an expression statement, or `void`. */
function isDiscarded(e: ts.Expression): boolean {
  const parent = valueNode(e).parent;
  return !!parent && (ts.isExpressionStatement(parent) || ts.isVoidExpression(parent));
}

/** Whether `expr` IS the filter's result on `param`, by the rules above. */
function carries(expr: ts.Expression, param: ts.Symbol, checker: ts.TypeChecker, mode: Mode): boolean {
  const e = strip(expr);
  const filters = mode === "list" ? LIST_FILTERS : new Set([ITEM_FILTER]);
  if (ts.isCallExpression(e)) {
    if (filters.has(calleeName(e) ?? "")) {
      const arg = e.arguments[0] ? strip(e.arguments[0]) : undefined;
      return !!arg && ts.isIdentifier(arg) && symbolOf(arg, checker) === param;
    }
    // A method read off the filtered list: visibleNow(c).slice(1).
    return mode === "list" && ts.isPropertyAccessExpression(e.expression) && carries(e.expression.expression, param, checker, mode);
  }
  if (mode === "list" && ts.isPropertyAccessExpression(e)) return carries(e.expression, param, checker, mode);
  if (ts.isConditionalExpression(e)) return carries(e.whenTrue, param, checker, mode) && carries(e.whenFalse, param, checker, mode);
  if (mode === "item" && ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return carries(e.left, param, checker, mode) || carries(e.right, param, checker, mode);
  }
  return false;
}

/** Whether `fn` (an arrow or function expression) returns, from every
 *  return, the filter's result on its own first parameter. */
function returnsFilterOf(fn: ts.Node, checker: ts.TypeChecker, mode: Mode): boolean {
  if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
  const param = fn.parameters[0]?.name;
  const paramSymbol = param && ts.isIdentifier(param) ? checker.getSymbolAtLocation(param) : undefined;
  if (!paramSymbol) return false;
  if (!ts.isBlock(fn.body)) return carries(fn.body, paramSymbol, checker, mode);
  const returns: ts.ReturnStatement[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n)) returns.push(n);
    ts.forEachChild(n, visit);
  };
  fn.body.statements.forEach(visit);
  return returns.length > 0 && returns.every((r) => !!r.expression && carries(r.expression, paramSymbol, checker, mode));
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

/** Whether one use of a bound list is a filter whose result flows on. */
function filteredUse(id: ts.Identifier, checker: ts.TypeChecker): boolean {
  const value = valueNode(id);
  const parent = value.parent;
  if (parent && ts.isCallExpression(parent) && parent.arguments[0] === value && LIST_FILTERS.has(calleeName(parent) ?? "")) {
    return !isDiscarded(parent);
  }
  if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === value && /^(filter|find)$/.test(parent.name.text)) {
    const call = parent.parent;
    return (
      !!call &&
      ts.isCallExpression(call) &&
      call.expression === parent &&
      !!call.arguments[0] &&
      returnsFilterOf(call.arguments[0], checker, "item") &&
      !isDiscarded(call)
    );
  }
  return false;
}

/** Whether every use of `bound` in its function is a filter whose result
 *  flows on. A raw use, a use in a nested function, or none at all fails. */
function everyUseFiltered(bound: ts.Identifier, checker: ts.TypeChecker): boolean {
  const symbol = checker.getSymbolAtLocation(bound);
  const home = enclosingFunction(bound);
  if (!symbol || !home) return false;
  let uses = 0;
  let ok = true;
  const visit = (n: ts.Node): void => {
    if (!ok) return;
    if (ts.isIdentifier(n) && n !== bound && symbolOf(n, checker) === symbol) {
      uses += 1;
      if (enclosingFunction(n) !== home || !filteredUse(n, checker)) ok = false;
    }
    ts.forEachChild(n, visit);
  };
  visit(home);
  return ok && uses > 0;
}

function callFiltered(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const value = valueNode(call);
  // Wrapped: visibleNow(await listChallenges()), its result used.
  const outer = value.parent;
  if (outer && ts.isCallExpression(outer) && outer.arguments[0] === value && LIST_FILTERS.has(calleeName(outer) ?? "")) {
    return !isDiscarded(outer);
  }
  // Chained: .then(visibleNow) or a callback returning the filter's result,
  // the `.then(…)` result used.
  const access = call.parent;
  if (access && ts.isPropertyAccessExpression(access) && access.expression === call && access.name.text === "then") {
    const then = access.parent;
    if (!then || !ts.isCallExpression(then) || isDiscarded(then)) return false;
    const f = then.arguments[0];
    if (f && ts.isIdentifier(f) && LIST_FILTERS.has(f.text)) return true;
    return !!f && returnsFilterOf(f, checker, "list");
  }
  // Bound, then filtered on every use in the same function.
  const bound = bindingFor(value);
  return !!bound && everyUseFiltered(bound, checker);
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
      "async function f() { const records = await readChallengeRecords(); const v = records.filter((c) => isChallengeVisible(c, now)); return v; }",
    ];
    for (const src of ok) expect(unfilteredCalls(src), src).toEqual([]);
    // A filter on another variable, or in another function, does not count.
    expect(unfilteredCalls("function f() { const a = await listChallenges(); visibleNow(b); }")).toHaveLength(1);
    expect(unfilteredCalls("function f() { const a = await listChallenges(); } function g() { visibleNow(a); }")).toHaveLength(1);
  });
});

// The filter's RESULT is what has to flow on: a filter called and its answer
// dropped filters nothing. Rules, per path:
// - wrapped / chained: the filter call (or the `.then(…)` call) is not a
//   discarded expression statement;
// - a `.then` callback (list filter) or a `.filter` / `.find` callback (the
//   item predicate) returns, from EVERY return, the filter's result: its call
//   on the callback's own parameter, possibly through parentheses or `await`,
//   a property or method read off it (`visibleNow(c).length`), a ternary
//   whose branches both do, or, for the item predicate only, an `&&` with the
//   predicate on either side (both must hold). `||` and `!` do not count: they
//   let a hidden challenge through. An expression body is one return;
// - bound, then filtered: EVERY later use of the variable in its function is
//   a filter that is not discarded (passed to a list filter, or the receiver
//   of `.filter` / `.find` with a predicate callback as above); a raw use, a
//   use in a nested function, or no use at all fails. Looking one record up
//   with `.find` and then testing it is a grader's decision, not a filter:
//   such a reader is exempted with its reason instead.
describe("the filter's result is what flows on", () => {
  it("accepts callbacks that return the filter's result on every path", () => {
    const ok = [
      "x(listChallenges().then((c) => visibleNow(c)));",
      "x(listChallenges().then((c) => { return visibleNow(c); }));",
      "x(listChallenges().then((c) => { if (a) return visibleNow(c).slice(1); return visibleNow(c); }));",
      "x(listChallenges().then((c) => (cond ? visibleNow(c) : visibleChallenges(c, 0))));",
      "async function f() { const all = await listChallenges(); return all.filter((c) => isChallengeVisible(c, now) && c.points > 0); }",
      "async function f() { const all = await listChallenges(); return all.filter((c) => { return c.points > 0 && isChallengeVisible(c, now); }); }",
      "async function f() { const all = await listChallenges(); return all.find((c) => isChallengeVisible(c, now) && c.id === id); }",
    ];
    for (const src of ok) expect(unfilteredCalls(src), src).toEqual([]);
  });

  it("refuses a callback that computes the filter and returns something else", () => {
    const bad = [
      "x(listChallenges().then((c) => { visibleNow(c); return c; }));",
      "x(listChallenges().then((c) => { if (a) return visibleNow(c); return c; }));",
      "x(listChallenges().then((c) => cond ? visibleNow(c) : c));",
      "x(listChallenges().then((c) => { visibleNow(c); }));",
      "async function f() { const all = await listChallenges(); return all.filter((c) => { isChallengeVisible(c, now); return true; }); }",
      "async function f() { const all = await listChallenges(); return all.filter((c) => x || isChallengeVisible(c, now)); }",
      "async function f() { const all = await listChallenges(); return all.filter((c) => !isChallengeVisible(c, now)); }",
      "async function f() { const all = await listChallenges(); return all.filter((c) => { if (a) return isChallengeVisible(c, now); return true; }); }",
    ];
    for (const src of bad) expect(unfilteredCalls(src), src).toHaveLength(1);
  });

  it("refuses a wrapped or chained filter whose result is dropped", () => {
    expect(unfilteredCalls("async function f() { visibleNow(await listChallenges()); }")).toHaveLength(1);
    expect(unfilteredCalls("function f() { listChallenges().then(visibleNow); }")).toHaveLength(1);
  });

  it("refuses a bound list that is filtered and then used raw, or filtered and dropped", () => {
    const bad = [
      "async function f() { const all = await listChallenges(); visibleNow(all); return all; }",
      "async function f() { const all = await listChallenges(); const v = visibleNow(all); return [v, all.length]; }",
      "async function f() { const all = await listChallenges(); const k = cond ? all : visibleChallenges(all, now); return k; }",
      "async function f() { const all = await listChallenges(); all.filter((c) => isChallengeVisible(c, now)); return all; }",
      "async function f() { const all = await listChallenges(); const v = visibleNow(all); const g = () => all; return v; }",
      "async function f() { const all = await listChallenges(); }",
    ];
    for (const src of bad) expect(unfilteredCalls(src), src).toHaveLength(1);
  });

  it("no longer takes a record looked up with .find and then tested for a filter", () => {
    expect(unfilteredCalls("async function f() { const record = (await listChallenges()).find((c) => c.id === id); return !isChallengeVisible(record, now); }")).toHaveLength(1);
  });
});

describe("the scan reads code, not text", () => {
  it("accepts a filtered binding whose name a regex would misread", () => {
    expect(unfilteredCalls("async function f() { const $list = await listChallenges(); return visibleNow($list); }")).toEqual([]);
  });

  it("does not take a filter on another variable, in the next statement or the same one, for this call's", () => {
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
