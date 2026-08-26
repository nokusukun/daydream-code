import { describe, expect, it } from "vitest";
import { titleCaseSettingName } from "../src/title-case.js";

describe("titleCaseSettingName", () => {
  it("title cases every word in a setting name", () => {
    expect(titleCaseSettingName("default driver")).toBe("Default Driver");
    expect(titleCaseSettingName("file read limit")).toBe("File Read Limit");
  });

  it("preserves separators and recognized initialisms", () => {
    expect(titleCaseSettingName("driver id / json config")).toBe("Driver ID / JSON Config");
    expect(titleCaseSettingName("read-only sqlite url")).toBe("Read-Only SQLite URL");
  });

  it("does not flatten existing product capitalization", () => {
    expect(titleCaseSettingName("macOS appearance")).toBe("macOS Appearance");
  });
});
