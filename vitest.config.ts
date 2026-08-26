import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@daydream-code\/([^/]+)\/(.+)$/,
        replacement: `${root}packages/$1/src/$2.ts`,
      },
      {
        find: /^@daydream-code\/([^/]+)$/,
        replacement: `${root}packages/$1/src/index.ts`,
      },
    ],
  },
  // JSX compiles through the automatic runtime, so a component test needs no
  // `import React`. Without this the classic transform emits React.createElement
  // and every .tsx test dies on `React is not defined`.
  esbuild: { jsx: "automatic" },
  test: {
    // `.ts?(x)`, because the renderer's component tests are .tsx and a `.test.ts`
    // glob silently collected none of them — they were not failing, they were
    // not running.
    include: [
      "packages/**/tests/**/*.test.ts?(x)",
      "apps/**/tests/**/*.test.ts?(x)",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 30_000,
  },
});
