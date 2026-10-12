// The vacuous sweep's pass/fail decision, kept apart from the runner so the
// test suite can feed it results without booting a stub or a rubric.
//
// A sweep passes only when it MEASURED every target it was asked to and
// found nothing vacuous. Each way a run can look clean without measuring is a
// failure here, not a warning: an aborted run skipped challenges; a stuck run
// (every challenge's requests landed on one path) never got past a shared
// gate such as a login; a target missing from the results, or carrying zero
// challenges, was not swept at all.

/** Fold per-personality results into one entry per target. A challenge only
 *  has to pass under ONE shape of uselessness to be asserting nothing, so the
 *  vacuous ids are a union. Results with an `error` are left out (the caller
 *  already failed on them). */
export function summarize(results) {
  const byTarget = new Map();
  for (const r of results) {
    if (r.error) continue;
    const acc = byTarget.get(r.targetName) ?? {
      total: Number(r.total) || 0,
      ids: new Set(),
      aborted: false,
      stuck: false,
      paths: new Set(),
    };
    r.vacuous.forEach((id) => acc.ids.add(id));
    acc.aborted ||= r.aborted;
    // Judged per personality, before the paths are merged: a personality
    // stuck at /login would otherwise be hidden by another that reached /a
    // and /b, and the union would read as a target that got past the gate.
    acc.stuck ||= isStuck({ total: Number(r.total) || 0, paths: new Set(r.paths ?? []) });
    (r.paths ?? []).forEach((p) => acc.paths.add(p));
    byTarget.set(r.targetName, acc);
  }
  return byTarget;
}

/** One personality's run. Distinct paths is the discriminator, not request
 *  count. A target stuck at a login and a target whose anti-vacuous
 *  preconditions are correctly firing BOTH issue roughly one request per
 *  challenge; where those requests GO tells them apart. One path repeated for
 *  every challenge means the rubric never got past the gate, and no path at
 *  all means it never contacted the target, whatever the challenge count. */
export function isStuck(run) {
  if (run.paths.size === 0) return true;
  return run.total > 1 && run.paths.size <= 1;
}

/**
 * @param {Map} byTarget          from summarize()
 * @param {string[]} expected     every target this sweep was asked to measure
 * @returns {{ ok: boolean, vacuous: number, total: number, problems: string[] }}
 */
export function verdict(byTarget, expected) {
  const problems = [];
  let vacuous = 0;
  let total = 0;
  for (const name of expected) {
    if (!byTarget.has(name)) problems.push(`${name}: not measured — no result for this target`);
  }
  for (const [name, acc] of byTarget) {
    total += acc.total;
    vacuous += acc.ids.size;
    if (!(acc.total > 0)) problems.push(`${name}: the rubric gave it no challenges to run`);
    if (acc.ids.size > 0) problems.push(`${name}: ${acc.ids.size} of ${acc.total} pass against a useless target`);
    if (acc.aborted) problems.push(`${name}: run aborted — challenges were skipped, so a clean result proves nothing`);
    else if (acc.ids.size === 0 && acc.stuck && acc.total > 0) {
      problems.push(
        `${name}: a personality reached at most one distinct path across ${acc.total} challenges — ` +
          "the rubric never got past a shared gate; NOT a clean bill",
      );
    }
  }
  if (expected.length === 0 || total === 0) problems.push("nothing was swept: no target, or no challenges");
  return { ok: problems.length === 0, vacuous, total, problems };
}
