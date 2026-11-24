import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { RUBRIC_ID } from "./rubric-id.js";
import { loadCatalogue } from "./catalogue.js";
import { getTarget } from "./targets.js";

export { RUBRIC_ID } from "./rubric-id.js";

const TOP_KEYS = new Set(["target", "challenges"]);
const CHALLENGE_KEYS = new Set(["id", "name", "points", "probes"]);

// An exec target is a subdirectory named for the target holding
// tests/challenges/catalogue.<target>.json. Returns null when `name` is not one.
function loadExecTarget(dir, name) {
  if (!getTarget(name)) return null;
  const testsDir = join(dir, name, "tests", "challenges");
  const entries = loadCatalogue(testsDir, name);
  if (!entries) return null;

  const { byName } = getTarget(name);
  const points = new Map();
  const challenges = entries.map((e) => {
    points.set(e.id, e.points);
    return {
      id: e.id,
      name: e.name,
      points: e.points,
      owasp: e.owasp ?? null,
      exec: { file: e.file, key: e.key, byName, testsDir },
    };
  });
  return { challenges, points };
}

// Loads every <target>.yaml and <target>/tests/challenges exec dir in the
// rubric dir. Returns null when the dir is missing or holds no rubric content
// — allowed for `serve` (degenerate mode), while `judge` demands a rubric
// itself. Any INVALID content throws loudly.
export function loadRubric(dir = process.env.RUBRIC_DIR ?? "/rubric", { target: selectedTarget } = {}) {
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const targets = new Map();
  // Judge isolation must happen before parsing; serve still loads the complete catalogue.
  if (selectedTarget !== undefined) {
    dirents = dirents.filter((d) => d.name === selectedTarget ||
      d.name === `${selectedTarget}.yaml` || d.name === `${selectedTarget}.yml`);
  }

  // Exec targets first: a <target>/tests/challenges/catalogue.<target>.json dir.
  for (const d of dirents.filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const loaded = loadExecTarget(dir, d.name);
    if (loaded) targets.set(d.name, loaded);
  }

  // Then declarative <target>.yaml files (existing loop body, unchanged).
  const files = dirents
    .filter((d) => d.isFile() && /\.ya?ml$/.test(d.name))
    .map((d) => d.name)
    .sort();

  for (const file of files) {
    const fail = (msg) => {
      throw new Error(`rubric ${file}: ${msg}`);
    };
    let doc;
    try {
      doc = parseYaml(readFileSync(join(dir, file), "utf8"));
    } catch (err) {
      fail(`invalid YAML: ${err.message}`);
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) fail("expected a mapping with target + challenges");
    const unknown = Object.keys(doc).filter((k) => !TOP_KEYS.has(k));
    if (unknown.length) fail(`unknown key: ${unknown.join(", ")}`);
    const { target, challenges } = doc;
    if (typeof target !== "string" || !RUBRIC_ID.test(target)) {
      fail("target must match /^[a-z0-9][a-z0-9-]*$/ (it becomes a Redis key segment)");
    }
    if (file.replace(/\.ya?ml$/, "") !== target) {
      fail(`target "${target}" does not match filename (expected ${target}.yaml)`);
    }
    if (targets.has(target)) {
      fail(`target "${target}" is defined twice: as an exec directory and as ${target}.yaml`);
    }
    if (!Array.isArray(challenges) || challenges.length === 0) fail("challenges must be a non-empty list");

    const points = new Map();
    const list = challenges.map((c, i) => {
      const where = `challenges[${i}]`;
      if (!c || typeof c !== "object" || Array.isArray(c)) fail(`${where}: expected a mapping`);
      const unknownC = Object.keys(c).filter((k) => !CHALLENGE_KEYS.has(k));
      if (unknownC.length) fail(`${where}: unknown key: ${unknownC.join(", ")}`);
      if (typeof c.id !== "string" || !RUBRIC_ID.test(c.id)) {
        fail(`${where}: id must match /^[a-z0-9][a-z0-9-]*$/ (it becomes a Redis field segment)`);
      }
      if (points.has(c.id)) fail(`duplicate challenge id: ${c.id}`);
      if (typeof c.name !== "string" || c.name.length === 0) fail(`${c.id}: name is required`);
      const pts = c.points ?? 1;
      if (!Number.isInteger(pts) || pts < 1) fail(`${c.id}: points must be an integer >= 1`);
      // Probe grammar is the judge's concern — the loader only demands presence.
      if (!Array.isArray(c.probes) || c.probes.length === 0) fail(`${c.id}: probes must be a non-empty list`);
      points.set(c.id, pts);
      return { id: c.id, name: c.name, points: pts, probes: c.probes };
    });
    targets.set(target, { challenges: list, points });
  }

  if (targets.size === 0) return null;

  return {
    targets,
    pointsFor: (target, id) => targets.get(target)?.points.get(id),
    totalFor: (target) => targets.get(target)?.challenges.length ?? 0,
  };
}
