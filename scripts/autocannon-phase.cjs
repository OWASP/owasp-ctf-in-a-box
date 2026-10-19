#!/usr/bin/env node
// Runs one autocannon phase programmatically and prints the same JSON summary
// the autocannon CLI's --json emits, plus latency.p95 (issue #446). The CLI's
// fixed percentile list (… p90, p97.5, p99 …) has no p95, while the load-test
// bar names p95 — so this adds 95 to that list before the run. autocannon
// computes its summary percentiles from the run's HDR latency histogram at
// aggregation time, so the emitted p95 is measured from the same recording as
// p50/p97.5/p99, not interpolated.
//
// autocannon is not require-able by default (load-test.sh used to drive its
// CLI through npx): load-test.sh installs it into a throwaway prefix and
// points NODE_PATH at it. The percentile list is resolved from autocannon's
// own location so it is always the same instance autocannon aggregates with.
// If a future autocannon stops honouring the shared list, the p95 key simply
// never appears in the summary and the load-test's result-shape check fails
// the phase — a missing measurement never passes as a good one.
//
//   node autocannon-phase.cjs --url URL --duration SECONDS --rate RPS --connections N
//
// Exit: 0 with the JSON summary on stdout; 1 when autocannon reports no
// result (the load-test script treats a result in the wrong shape as a failed
// phase, so a bare exit status is the whole diagnostic — stderr must not echo
// the target URL either).
"use strict";

const path = require("path");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) {
    console.error(`autocannon-phase: --${name} is required`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

const autocannon = require("autocannon");
const percentiles = require(
  require.resolve("hdr-histogram-percentiles-obj", { paths: [path.dirname(require.resolve("autocannon"))] }),
);
if (!percentiles.percentiles.includes(95)) percentiles.percentiles.push(95);

autocannon(
  {
    url: arg("url"),
    duration: Number(arg("duration")),
    connections: Number(arg("connections")),
    // The CLI's -R flag is the programmatic overallRate (a per-connection
    // rate would be connectionRate and would multiply by --connections).
    overallRate: Number(arg("rate")),
  },
  (err, result) => {
    if (err || !result) {
      console.error(`autocannon-phase: ${err && err.message ? err.message : "no result"}`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(result));
  },
);
