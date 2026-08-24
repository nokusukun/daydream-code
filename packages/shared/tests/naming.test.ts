import { describe, expect, it } from "vitest";
import { slugifyName, uniqueName } from "@daydream-code/shared";

describe("slugifyName", () => {
  it("drops stopwords and keeps the significant head of a task", () => {
    expect(slugifyName("fix the failing tests")).toBe("fix-failing-tests");
    expect(slugifyName("Update the README for the new driver")).toBe(
      "update-readme-new-driver",
    );
  });

  it("strips punctuation and collapses separators", () => {
    expect(slugifyName("re-run CI, then deploy!")).toBe("re-run-ci-deploy");
    expect(slugifyName("  wire   up   telemetry  ")).toBe("wire-telemetry");
  });

  it("honours maxWords", () => {
    expect(slugifyName("alpha beta gamma delta epsilon", 2)).toBe("alpha-beta");
  });

  it("falls back to raw words when every word is a stopword", () => {
    expect(slugifyName("do it for me")).toBe("do-me");
    expect(slugifyName("the a an")).toBe("the-a-an");
  });

  it("never returns an empty name or a ragged tail", () => {
    expect(slugifyName("")).toBe("session");
    expect(slugifyName("!!!")).toBe("session");
    expect(slugifyName("x".repeat(80))).toBe("x".repeat(48));
    // A cut that lands mid-word must not leave a trailing separator.
    const long = slugifyName("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bb");
    expect(long.endsWith("-")).toBe(false);
  });
});

describe("uniqueName", () => {
  it("returns the base when free", () => {
    expect(uniqueName("deploy", () => false)).toBe("deploy");
  });

  it("numbers from -2 upward past taken variants", () => {
    const taken = new Set(["deploy", "deploy-2", "deploy-3"]);
    expect(uniqueName("deploy", (c) => taken.has(c))).toBe("deploy-4");
  });
});
