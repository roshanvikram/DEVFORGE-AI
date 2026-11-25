import { defineConfig } from "vitest/config";
import os from "node:os";
import path from "node:path";

// Test repositories are generated under the OS temp dir; only that root may be imported locally.
export const FIXTURE_ROOT = path.join(os.tmpdir(), "devforge-test-fixtures");
export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
    env: { LOCAL_IMPORT_ROOTS: FIXTURE_ROOT, OSV_ENABLED: "false", SANDBOX_MODE: "disabled", NODE_ENV: "test" },
  },
});
