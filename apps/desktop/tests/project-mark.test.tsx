import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MARK_HUES, ProjectMark, markHue, markInitials } from "../src/project-mark.js";

describe("markInitials", () => {
  it("takes one letter from a one-word name", () => {
    expect(markInitials("winhere")).toBe("W");
    expect(markInitials("teald")).toBe("T");
  });

  it("takes two letters from a two-word name, however it is joined", () => {
    expect(markInitials("services-api")).toBe("SA");
    expect(markInitials("daydream_code")).toBe("DC");
    expect(markInitials("daydreamCode")).toBe("DC");
    expect(markInitials("my app")).toBe("MA");
    expect(markInitials("@scope/pkg")).toBe("SP");
  });

  it("skips leading punctuation and survives names with no letters", () => {
    expect(markInitials(".dotfiles")).toBe("D");
    expect(markInitials("---")).toBe("?");
    expect(markInitials("écoles")).toBe("É");
  });
});

describe("markHue", () => {
  it("is stable for a path and drawn from the palette", () => {
    const hue = markHue("/Users/me/projects/api");
    expect(markHue("/Users/me/projects/api")).toBe(hue);
    expect(MARK_HUES).toContain(hue);
  });

  it("spreads across the palette rather than collapsing onto one colour", () => {
    const hues = new Set(
      Array.from({ length: 40 }, (_, i) => markHue(`/Users/me/projects/p${i}`)),
    );
    expect(hues.size).toBeGreaterThanOrEqual(MARK_HUES.length - 2);
  });
});

describe("ProjectMark", () => {
  it("draws the project's icon when it has one", () => {
    const html = renderToStaticMarkup(
      <ProjectMark name="teald" rootPath="/p/teald" icon="data:image/png;base64,AA==" />,
    );
    expect(html).toContain("proj-mark-image");
    expect(html).toContain('src="data:image/png;base64,AA=="');
    expect(html).not.toContain("proj-mark-glyph");
  });

  it("draws a generated tile in the project's own hue when it has none", () => {
    const html = renderToStaticMarkup(
      <ProjectMark name="services-api" rootPath="/p/services-api" icon={null} />,
    );
    expect(html).toContain("proj-mark-glyph");
    expect(html).toContain(">SA<");
    expect(html).toContain(`--mark-h:${markHue("/p/services-api")}`);
    expect(html).not.toContain("<img");
  });

  it("treats a main process that sends no icon field like one with no icon", () => {
    const html = renderToStaticMarkup(<ProjectMark name="winhere" rootPath="/p/w" />);
    expect(html).toContain("proj-mark-glyph");
    expect(html).toContain(">W<");
  });
});
