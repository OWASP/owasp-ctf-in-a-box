/** Why Unlink GitHub must stay disabled, or null when a username and a
 *  password would still let the player sign in. The Support card shows this
 *  beside the button; `unlinkGithub` throws the same sentence. */
export function unlinkGithubBlockReason(hasUsername: boolean, hasPassword: boolean): string | null {
  if (hasUsername && hasPassword) return null;
  const steps: string[] = [];
  if (!hasUsername) steps.push("set a username for them (Username, then Save)");
  if (!hasPassword) steps.push("give them a reset code so they can set a password");
  const [first, ...rest] = steps;
  return `This player cannot sign in without GitHub. First ${first}${rest.map((s) => `, then ${s}`).join("")}.`;
}
