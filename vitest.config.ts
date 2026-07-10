import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Vitest-only config. The app build uses vite.config.ts via
// @lovable.dev/vite-tanstack-config; we keep test config separate so the
// TanStack Start plugin (which requires a router) does not run in tests.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    // Runs once per worker before any test module is imported. Pins the
    // Node timezone to UTC so date-ordering tests are consistent across
    // developer machines and CI regardless of host TZ.
    setupFiles: ["./src/test/setup-timezone.ts"],
  },
});
