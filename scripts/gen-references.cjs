const fs = require("fs");
const path = require("path");

const pkgDirs = [];
for (const base of ["packages", "apps"]) {
  for (const d of fs.readdirSync(base)) {
    const pj = path.join(base, d, "package.json");
    if (fs.existsSync(pj)) pkgDirs.push(path.join(base, d));
  }
}
const byName = {};
for (const dir of pkgDirs) {
  const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  byName[pj.name] = dir;
}
for (const dir of pkgDirs) {
  // apps/desktop uses a solution-style tsconfig owning its own references.
  if (dir.includes("desktop")) continue;
  const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const deps = Object.keys(pj.dependencies || {}).filter((d) =>
    d.startsWith("@daydream-code/"),
  );
  const tsPath = path.join(dir, "tsconfig.json");
  const ts = JSON.parse(fs.readFileSync(tsPath, "utf8"));
  ts.references = deps.map((d) => ({
    path: path.relative(dir, byName[d]).split(path.sep).join("/"),
  }));
  fs.writeFileSync(tsPath, JSON.stringify(ts, null, 2) + "\n");
}
fs.writeFileSync(
  "tsconfig.json",
  JSON.stringify(
    {
      files: [],
      references: pkgDirs.map((d) => ({
        path: "./" + d.split(path.sep).join("/"),
      })),
    },
    null,
    2,
  ) + "\n",
);
console.log("references written for", pkgDirs.length, "packages");
