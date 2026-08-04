import { defineConfig } from "vitest/config";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

// Only the app's own glue tests: the submodules run their suites with their
// own runners (cad: vitest, mesh: node --test) in their own CI.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // A glue test that reaches into submodule source needs that submodule's
      // own dependencies, which are installed under its own node_modules —
      // KKSS's root tree has none of them. esbuild resolves these the same way
      // at build time (it walks up from the importing file); vitest resolves
      // from the project root, so it needs telling.
      fflate: path.resolve(root, "cad/node_modules/fflate"),
    },
  },
});
