// Per-target scoring shape for exec rubrics. Ported from the upstream reference
// engine's TARGETS table (dc34 .github/actions/ctf-score/src/score.ts) — the
// values encode hard-won operational knowledge, so change them only with
// evidence from a real scoring run.
//
// byName  true  → the catalogue key names a SUBTEST inside a shared file; the
//                 child runs with --test-name-pattern=^<key>$.
//         false → one self-contained file per challenge; run the whole file.
// defaultConcurrency  how many challenge children run at once. 1 = serial,
//                 required wherever tests mutate shared server state.
export const TARGETS = {
  "juice-shop": {
    name: "juice-shop",
    catalogueFile: "catalogue.juice-shop.json",
    byName: false,
    defaultConcurrency: 1,
    urlEnv: "JUICE_SHOP_URL",
    readinessPath: "/rest/admin/application-version",
  },
  dvwa: {
    name: "dvwa",
    catalogueFile: "catalogue.dvwa.json",
    byName: true,
    defaultConcurrency: 1,
    urlEnv: "DVWA_URL",
    readinessPath: "/login.php",
  },
  webgoat: {
    name: "webgoat",
    catalogueFile: "catalogue.webgoat.json",
    byName: true,
    defaultConcurrency: 1,
    urlEnv: "WEBGOAT_URL",
    readinessPath: "/login",
  },
  securityshepherd: {
    name: "securityshepherd",
    catalogueFile: "catalogue.securityshepherd.json",
    byName: true,
    // MUST stay serial: several tests mutate shared server state (the shared
    // attacker account), so parallel runs corrupt each other's scores.
    defaultConcurrency: 1,
    urlEnv: "SECURITYSHEPHERD_URL",
  },
  vulnerableapp: {
    name: "vulnerableapp",
    catalogueFile: "catalogue.vulnerableapp.json",
    byName: false,
    // 110 stateless, self-contained files. Serial took ~15 min upstream; each
    // challenge is independent (unique upload names, per-level cache keys,
    // read-only SQLi against seeded data), so 8-wide is safe and lands ~2 min.
    defaultConcurrency: 8,
    urlEnv: "VULNERABLEAPP_URL",
    readinessPath: "/allEndPointJson",
  },
  vampi: {
    name: "vampi",
    catalogueFile: "catalogue.vampi.json",
    byName: true,
    defaultConcurrency: 1,
    urlEnv: "VAMPI_URL",
  },
};

// Unknown targets return undefined. The upstream engine silently defaulted to
// juice-shop here; that would score the wrong rubric, so this one does not.
export function getTarget(name) {
  return Object.prototype.hasOwnProperty.call(TARGETS, name) ? TARGETS[name] : undefined;
}
