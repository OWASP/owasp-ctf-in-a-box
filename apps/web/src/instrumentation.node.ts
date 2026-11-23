import { errorLabel } from "@/lib/error-label";
import { checkRedisCompatibility } from "@/lib/redis-compatibility";

type InstrumentationDeps = {
  exit?: (code: number) => never;
  logErr?: (message: string) => void;
};

export async function registerNodeInstrumentation({
  exit = process.exit,
  logErr = console.error,
}: InstrumentationDeps = {}): Promise<void> {
  try {
    await checkRedisCompatibility();
  } catch (err) {
    logErr(`ctf-app: Redis compatibility check failed: ${errorLabel(err)}`);
    exit(1);
  }
}
