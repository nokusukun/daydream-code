import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "@daydream-code/kernel";
import SqliteStore from "@daydream-code/store/sqlite";
import type { Workspace } from "@daydream-code/workspace";
import GitWorkspace, {
  parseNumstat,
  parseStatus,
  parseUnified,
} from "@daydream-code/workspace/git";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function git(dir: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

/**
 * A real repository in a temp dir. The provider shells out to git, so a fake
 * would only test the parsers — which are exercised directly below.
 */
async function makeWorkspace(options: { repo?: boolean } = {}) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "daydream-workspace-")),
  );
  cleanups.push(() =>
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 }),
  );
  if (options.repo !== false) {
    git(dir, "init", "--initial-branch=main");
    git(dir, "config", "commit.gpgsign", "false");
  }

  const app = new App();
  const errors: unknown[] = [];
  app.onError = (error) => errors.push(error);
  app.rootCtx.plugin(SqliteStore, { rootPath: dir });
  app.rootCtx.plugin(GitWorkspace);
  await app.settle();
  const workspace = app.rootCtx.get<Workspace>("workspace");
  if (!workspace) {
    throw new Error(`plugins failed to load: ${errors.map(String).join("; ")}`);
  }
  cleanups.push(() => app.dispose(app.rootFiber));
  return { dir, workspace, commit: () => {
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base");
  } };
}

const write = (dir: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

describe("GitWorkspace", () => {
  it("reports the branch and the changed set with line counts", async () => {
    const { dir, workspace, commit } = await makeWorkspace();
    write(dir, "a.txt", "one\ntwo\nthree\n");
    write(dir, "keep.txt", "steady\n");
    commit();

    write(dir, "a.txt", "one\nTWO\nthree\nfour\n");
    write(dir, "new.txt", "fresh\nlines\n");

    const status = await workspace.status();
    expect(status.repo).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.unborn).toBe(false);

    const byPath = new Map(status.files.map((f) => [f.path, f]));
    expect(byPath.get("a.txt")).toMatchObject({ status: "M", added: 2, removed: 1 });
    // Untracked files have no HEAD side, so the whole file counts as added.
    expect(byPath.get("new.txt")).toMatchObject({ status: "?", added: 2, removed: 0 });
    expect(byPath.has("keep.txt")).toBe(false);
  });

  it("degrades to a plain file tree outside a repository", async () => {
    const { dir, workspace } = await makeWorkspace({ repo: false });
    write(dir, "src/main.ts", "export {};\n");

    const status = await workspace.status();
    expect(status).toMatchObject({ repo: false, branch: null, files: [] });

    const tree = await workspace.tree();
    expect(tree.map((e) => e.name)).toContain("src");
  });

  it("lists directories first, hides ignored paths and the harness data dir", async () => {
    const { dir, workspace, commit } = await makeWorkspace();
    write(dir, ".gitignore", "junk/\n*.log\n");
    write(dir, "zeta.ts", "");
    write(dir, "alpha.ts", "");
    write(dir, "src/index.ts", "");
    write(dir, "junk/big.bin", "");
    write(dir, "noise.log", "");
    commit();

    const tree = await workspace.tree();
    expect(tree.map((e) => e.name)).toEqual([
      "src",
      ".gitignore",
      "alpha.ts",
      "zeta.ts",
    ]);
    // The store opened its database under .daydream-code; it is not content.
    expect(tree.some((e) => e.name === ".daydream-code")).toBe(false);
  });

  it("marks a collapsed directory that has a change below it", async () => {
    const { dir, workspace, commit } = await makeWorkspace();
    write(dir, "src/deep/nested.ts", "const a = 1;\n");
    commit();
    write(dir, "src/deep/nested.ts", "const a = 2;\n");

    const [src] = await workspace.tree();
    expect(src).toMatchObject({ name: "src", dir: true, changed: true });
  });

  it("annotates a tracked file's diff with working-tree line numbers", async () => {
    const { dir, workspace, commit } = await makeWorkspace();
    write(dir, "f.ts", "a\nb\nc\nd\ne\nf\ng\n");
    commit();
    write(dir, "f.ts", "a\nb\nC!\nd\ne\nf\ng\n");

    const diff = await workspace.diff("f.ts");
    expect(diff).toMatchObject({ status: "M", added: 1, removed: 1, binary: false });
    expect(diff.lines.filter((l) => l.kind === "del")).toEqual([
      { kind: "del", n: null, text: "c" },
    ]);
    expect(diff.lines.filter((l) => l.kind === "add")).toEqual([
      { kind: "add", n: 3, text: "C!" },
    ]);
    // Context keeps its own numbering, so the editor can splice by line.
    expect(diff.lines.find((l) => l.text === "b")).toMatchObject({ n: 2 });
  });

  it("renders an untracked file as an all-additions diff", async () => {
    const { dir, workspace, commit } = await makeWorkspace();
    write(dir, "seed.txt", "seed\n");
    commit();
    write(dir, "brand-new.ts", "one\ntwo\n");

    const diff = await workspace.diff("brand-new.ts");
    expect(diff.status).toBe("?");
    expect(diff.added).toBe(2);
    expect(diff.lines).toEqual([
      { kind: "add", n: 1, text: "one" },
      { kind: "add", n: 2, text: "two" },
    ]);
  });

  it("returns an empty diff for an unchanged file", async () => {
    const { dir, workspace, commit } = await makeWorkspace();
    write(dir, "same.ts", "unchanged\n");
    commit();

    const diff = await workspace.diff("same.ts");
    expect(diff.lines).toEqual([]);
    expect(diff.added).toBe(0);
  });

  it("reads text, flags binary, and clips at the byte limit", async () => {
    const { dir, workspace } = await makeWorkspace();
    write(dir, "hello.txt", "hello\n");
    fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([1, 2, 0, 3, 4]));

    expect(await workspace.read("hello.txt")).toMatchObject({
      path: "hello.txt",
      text: "hello\n",
      truncated: false,
      binary: false,
    });
    expect(await workspace.read("blob.bin")).toMatchObject({
      text: "",
      binary: true,
    });
  });

  /**
   * Regression: git calls a blob binary if it finds a NUL in the first 8k, so
   * one stray control byte inside a string literal makes a whole source file
   * unreviewable — no counts, no diff, nothing for the UI to draw. This
   * happened for real in `apps/cli/src/bin.ts`, whose committed blob carries a
   * literal 0x00 where `"\0"` was meant. The repo's `.gitattributes` sets the
   * `diff` attribute to force a textual diff; this pins that it works through
   * the whole pipeline, not just at the `git` layer.
   */
  it("renders a NUL-carrying blob as text once .gitattributes forces a diff", async () => {
    const { dir, workspace, commit } = await makeWorkspace();
    fs.writeFileSync(
      path.join(dir, "cli.ts"),
      'export const sentinel = "\u0000";\n',
    );
    commit();
    write(dir, "cli.ts", 'export const sentinel = "";\nexport const added = 1;\n');

    const before = (await workspace.status()).files.find((f) => f.path === "cli.ts");
    expect(before).toMatchObject({ binary: true, added: 0, removed: 0 });
    expect((await workspace.diff("cli.ts")).lines).toEqual([]);

    write(dir, ".gitattributes", "*.ts diff\n");

    const after = (await workspace.status()).files.find((f) => f.path === "cli.ts");
    expect(after?.binary).toBe(false);
    expect(after?.added).toBeGreaterThan(0);

    const diff = await workspace.diff("cli.ts");
    expect(diff.binary).toBe(false);
    expect(diff.lines.some((line) => line.kind === "add")).toBe(true);
    expect(diff.lines.some((line) => line.kind === "del")).toBe(true);
  });

  it("refuses paths outside the root, and the harness data directory", async () => {
    const { workspace } = await makeWorkspace();
    await expect(workspace.read("../../etc/passwd")).rejects.toThrow(/escapes/);
    await expect(workspace.read("/etc/passwd")).rejects.toThrow();
    await expect(workspace.tree(".git")).rejects.toThrow(/not project content/);
    await expect(workspace.read(".daydream-code/db.sqlite")).rejects.toThrow(
      /not project content/,
    );
  });

  it("treats a repository with no commits as all-new", async () => {
    const { dir, workspace } = await makeWorkspace();
    write(dir, "first.ts", "x\ny\n");

    const status = await workspace.status();
    expect(status.unborn).toBe(true);
    expect(status.files.find((f) => f.path === "first.ts")).toMatchObject({
      status: "?",
      added: 2,
    });
  });
});

describe("porcelain parsers", () => {
  it("pairs a rename with its pre-image path", () => {
    expect(parseStatus(["R  new/name.ts", "old/name.ts", " M other.ts"])).toEqual([
      { path: "new/name.ts", status: "R", from: "old/name.ts" },
      { path: "other.ts", status: "M" },
    ]);
  });

  it("collapses index and worktree letters to one status", () => {
    expect(parseStatus(["?? u.ts", " D gone.ts", "A  added.ts", "MM both.ts"])).toEqual([
      { path: "u.ts", status: "?" },
      { path: "gone.ts", status: "D" },
      { path: "added.ts", status: "A" },
      { path: "both.ts", status: "M" },
    ]);
  });

  it("reads numstat records, including renames and binaries", () => {
    const counts = parseNumstat([
      "4\t2\tsrc/a.ts",
      "9\t0\t",
      "old/b.ts",
      "new/b.ts",
      "-\t-\timage.png",
    ]);
    expect(counts.get("src/a.ts")).toEqual({ added: 4, removed: 2, binary: false });
    // Renames are keyed on the post-image, which is what every other surface
    // addresses the file by.
    expect(counts.get("new/b.ts")).toEqual({ added: 9, removed: 0, binary: false });
    expect(counts.has("old/b.ts")).toBe(false);
    expect(counts.get("image.png")).toEqual({ added: 0, removed: 0, binary: true });
  });

  it("numbers unified-diff lines from each hunk header", () => {
    const lines = parseUnified(
      [
        "diff --git a/f.ts b/f.ts",
        "index 000..111 100644",
        "--- a/f.ts",
        "+++ b/f.ts",
        "@@ -10,3 +10,4 @@ func()",
        " keep",
        "-drop",
        "+take",
        "+extra",
        " tail",
        "\\ No newline at end of file",
        "@@ -40,1 +41,1 @@",
        "-old",
        "+new",
      ].join("\n"),
    );
    expect(lines).toEqual([
      { kind: "ctx", n: 10, text: "keep" },
      { kind: "del", n: null, text: "drop" },
      { kind: "add", n: 11, text: "take" },
      { kind: "add", n: 12, text: "extra" },
      { kind: "ctx", n: 13, text: "tail" },
      { kind: "del", n: null, text: "old" },
      { kind: "add", n: 41, text: "new" },
    ]);
  });
});
