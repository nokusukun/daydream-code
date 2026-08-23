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
  test: {
    include: ["packages/**/tests/**/*.test.ts", "apps/**/tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 30_000,
  },
});
