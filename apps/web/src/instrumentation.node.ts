import { errorLabel } from "@/lib/error-label";
import { checkRedisCompatibility } from "@/lib/redis-compatibility";

type InstrumentationDeps = {
  exit?: (code: number) => never;
  logErr?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  tries?: number;
};

/** A refusal is recognized by name, not instanceof: the class would be a
 *  second copy wherever the module is mocked or bundled twice. */
const isRefusal = (err: unknown) => err instanceof Error && err.name === "IncompatibleRedisError";

/**
 * Runs the Redis compatibility check before the app serves. A refusal (v1
 * data, an unknown schema marker) logs once and exits. Anything else is Redis
 * not answering yet, usually srh still starting: it is waited out with its own
 * log line, so a slow start never reads like the refusal, and the app exits
 * only if Redis never answers.
 */
export async function registerNodeInstrumentation({
  exit = process.exit,
  logErr = console.error,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  waitMs = 2000,
  tries = 30,
}: InstrumentationDeps = {}): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await checkRedisCompatibility();
      return;
    } catch (err) {
      if (isRefusal(err)) {
        logErr(`ctf-app: Redis compatibility check failed: ${errorLabel(err)}`);
        exit(1);
        return;
      }
      if (attempt >= tries) {
        logErr(`ctf-app: Redis did not answer after ${attempt} tries: ${errorLabel(err)}`);
        exit(1);
        return;
      }
      if (attempt === 1 || attempt % 10 === 0) logErr(`ctf-app: waiting for Redis (${errorLabel(err)}), retrying`);
      await sleep(waitMs);
    }
  }
}
