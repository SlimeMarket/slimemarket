import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    // lib/security/csrf.ts reads CSRF_SECRET at import time (createHmac
    // throws on undefined), so tests need a dummy secret. It must match the
    // TEST_SECRET constant in __tests__/csrf-security.test.ts, which verifies
    // env-generated tokens against that exact value.
    env: {
      CSRF_SECRET: "test-csrf-secret-key-for-testing-purposes-only-not-for-production",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["lib/**/*.ts"],
      exclude: ["lib/**/types.ts", "lib/**/*.d.ts"],
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./"),
    },
  },
});
