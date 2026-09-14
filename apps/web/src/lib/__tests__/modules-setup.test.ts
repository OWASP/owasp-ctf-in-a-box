// The organizer-facing setup blocks (`ModuleDef.setup`, module contract
// §5.9), one per registered module. Beyond "exists", this pins the shape the
// admin panel's checklist depends on and the content rules the brief set:
// every step says where it happens, the checkable steps name the counts the
// panels actually report, the copy has no exclamation marks and no "simply"
// or "just", and the docs link points at that module's section of the
// operations guide. Wording itself is not pinned — that would make every copy
// edit a test edit — only the properties an organizer would be misled by.
import { describe, expect, it } from "vitest";
import {
  ALL_MODULE_IDS,
  DOCS_URL,
  moduleDefById,
  type Copy,
  type ModuleId,
  type ModuleSetupContent,
  type OrgContext,
} from "@/lib/modules";

const ctx: OrgContext = { appCount: 2, appList: "Juice Shop and DVWA", githubOrg: "acme-ctf-2026" };

function resolved(id: ModuleId): ModuleSetupContent {
  const setup = moduleDefById(id)?.setup;
  if (!setup) throw new Error(`${id} has no setup block`);
  return setup(ctx);
}

function flatten(copy: Copy): string {
  if (typeof copy === "string") return copy;
  return copy
    .map((s) => {
      if (typeof s === "string") return s;
      if ("em" in s) return s.em;
      if ("strong" in s) return s.strong;
      if ("code" in s) return s.code;
      if ("route" in s) return s.route.label;
      return s.link.label;
    })
    .join("");
}

function everyString(setup: ModuleSetupContent): string[] {
  return [
    setup.experience,
    ...setup.steps.flatMap((s) => [s.title, ...(s.body ? [flatten(s.body)] : [])]),
    ...setup.midEvent.safe.map(flatten),
    ...setup.midEvent.unsafe.map(flatten),
    setup.docs.label,
  ];
}

describe("module setup blocks", () => {
  it("exist for every registered module", () => {
    for (const id of ALL_MODULE_IDS) {
      expect(typeof moduleDefById(id)?.setup, id).toBe("function");
    }
  });

  it.each(ALL_MODULE_IDS)("%s answers all five questions", (id) => {
    const s = resolved(id);
    expect(s.experience.trim().length).toBeGreaterThan(20);
    expect(s.steps.length).toBeGreaterThan(0);
    for (const step of s.steps) {
      expect(["panel", "outside"], `${id}: ${step.title}`).toContain(step.where);
    }
    // Every module has at least one step inside the panel. Enabling a module
    // is no longer one of the reasons a module needs an OUTSIDE step (#386
    // moved that entirely onto the Event tab, for every module including
    // secure-development) — only a module with a genuine dependency the
    // panel cannot see still has one: secure-development's forks/App/scorer
    // image, and ai's external challenge site.
    expect(s.steps.some((x) => x.where === "panel"), id).toBe(true);
    if (id === "secure-development" || id === "ai") {
      expect(s.steps.some((x) => x.where === "outside"), id).toBe(true);
    }
    expect(s.midEvent.safe.length).toBeGreaterThan(0);
    expect(s.midEvent.unsafe.length).toBeGreaterThan(0);
    expect(s.docs.href.startsWith(`${DOCS_URL}operations`), s.docs.href).toBe(true);
  });

  it.each(ALL_MODULE_IDS)("%s keeps the panel's voice: no exclamation marks, no simply, no just", (id) => {
    for (const text of everyString(resolved(id))) {
      expect(text, text).not.toMatch(/!/);
      expect(text, text).not.toMatch(/\b(simply|just)\b/i);
    }
  });

  it("only declares checks the panels can actually report", () => {
    // quiz reports `items` only (quizInventory); classic and ai report
    // `items` and `categories`; secure-development's panel holds no list
    // and must declare no check at all.
    const checks = (id: ModuleId) => resolved(id).steps.flatMap((s) => (s.check ? [s.check.count] : []));
    expect(checks("quiz")).toEqual(["items"]);
    expect(checks("classic")).toEqual(["categories", "items"]);
    expect(checks("ai")).toEqual(["categories", "items"]);
    expect(checks("secure-development")).toEqual([]);
  });

  it("puts the category step before the challenge step where a category is required first", () => {
    for (const id of ["classic", "ai"] as const) {
      const titles = resolved(id).steps.map((s) => s.check?.count ?? "");
      expect(titles.indexOf("categories"), id).toBeLessThan(titles.indexOf("items"));
    }
  });

  it("names the event's real targets and org in the secure-development checklist", () => {
    const text = everyString(resolved("secure-development")).join("\n");
    expect(text).toContain("Juice Shop and DVWA");
    expect(text).toContain("acme-ctf-2026");
  });

  it("links each module to its own section of the operations guide", () => {
    expect(resolved("quiz").docs.href).toBe(`${DOCS_URL}operations#quiz`);
    expect(resolved("classic").docs.href).toBe(`${DOCS_URL}operations#jeopardy`);
    expect(resolved("ai").docs.href).toBe(`${DOCS_URL}operations#ai`);
    expect(resolved("secure-development").docs.href).toBe(`${DOCS_URL}operations#organizer-admin-panel`);
  });
});
