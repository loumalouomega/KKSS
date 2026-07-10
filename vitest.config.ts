import { defineConfig } from "vitest/config";

// Only the app's own glue tests: the submodules run their suites with their
// own runners (cad: vitest, mesh: node --test) in their own CI.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
