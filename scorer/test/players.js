// Fixed player ids for the tests. Index order follows the name order, so the
// board's "player asc" tie-break reads the same as the names do.
const NAMES = ["abe", "alice", "alpha", "bob", "carol", "dave", "hubot", "octocat", "solo", "x", "y", "zed", "zeta"];

export const pid = (name) => {
  const i = NAMES.indexOf(name);
  if (i < 0) throw new Error(`no test player id for ${name}`);
  return `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
};
