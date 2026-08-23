const fs = require("fs");
const path = require("path");

const K = { "@daydream-code/kernel": "workspace:*" };
const S = { "@daydream-code/shared": "workspace:*" };
const Z = { zod: "^4.0.0" };
const w = (name) => ({ [`@daydream-code/${name}`]: "workspace:*" });

const defs = {
  shared: {},
  boot: { ...K, yaml: "^2.6.0" },
  store: { ...K, ...S, ...Z, "drizzle-orm": "^0.44.0", "better-sqlite3": "^12.0.0" },
  journal: { ...K, ...S, ...Z, ...w("store"), "drizzle-orm": "^0.44.0" },
  thread: { ...K, ...S, ...Z, ...w("store"), ...w("journal"), ...w("tokens"), ...w("normalize"), "drizzle-orm": "^0.44.0" },
  tokens: { ...K, ...S, ...Z },
  normalize: { ...K, ...S, ...Z },
  compaction: { ...K, ...S, ...Z, ...w("thread"), ...w("tokens"), ...w("summarize") },
  summarize: { ...K, ...S, ...Z },
  driver: { ...K, ...S, ...Z, ...w("tools") },
  tools: { ...K, ...S, ...Z, ...w("journal"), ...w("thread") },
  session: { ...K, ...S, ...Z, ...w("store"), ...w("journal"), ...w("thread"), ...w("driver"), ...w("tools"), ...w("summarize"), ...w("tokens"), ...w("normalize"), ...w("compaction") },
  server: { ...K, ...S, ...Z, ...w("session"), ...w("journal"), ...w("thread"), ...w("store"), fastify: "^5.0.0", "@fastify/websocket": "^11.0.0", ws: "^8.18.0" },
};

for (const [name, dependencies] of Object.entries(defs)) {
  const pkg = {
    name: `@daydream-code/${name}`,
    version: "0.1.0",
    type: "module",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./*": { types: "./dist/*.d.ts", default: "./dist/*.js" },
    },
    scripts: { build: "tsc -b" },
    dependencies,
  };
  fs.writeFileSync(
    path.join("packages", name, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n",
  );
}

const cli = {
  name: "@daydream-code/cli",
  version: "0.1.0",
  type: "module",
  bin: { "daydream-code": "./dist/bin.js" },
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  scripts: { build: "tsc -b" },
  dependencies: {
    ...K,
    ...S,
    ...w("boot"),
    ...w("session"),
    ...w("journal"),
    ...w("thread"),
    ...w("store"),
  },
};
fs.writeFileSync("apps/cli/package.json", JSON.stringify(cli, null, 2) + "\n");
console.log("package.json files written");
