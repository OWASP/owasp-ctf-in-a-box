import { checkRedisCompatibility } from "@/lib/redis-compatibility";

export async function registerNodeInstrumentation(): Promise<void> {
  await checkRedisCompatibility();
}
