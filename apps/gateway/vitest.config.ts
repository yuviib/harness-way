import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Runs the test suite inside the real workerd runtime against real Durable
// Object / binding behavior (per wrangler.toml), not a Node-side mock --
// this is what caught the webSocketClose bugs during manual testing, and
// the whole point of converting that into an automated suite is to keep
// catching runtime-specific behavior a plain Node test runner never would.
export default defineConfig(async () => {
  // Node-side file read (readD1Migrations needs real fs access, which only
  // exists here, not inside the workerd runtime tests actually run in) --
  // exact pattern confirmed against Cloudflare's own vitest-pool-workers D1
  // test fixture, not guessed: the result is threaded through as a
  // test-only miniflare binding, then applied inside the worker itself by
  // test/apply-migrations.ts via setupFiles.
  const migrationsPath = path.join(import.meta.dirname, "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
