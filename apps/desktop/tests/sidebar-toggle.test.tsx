// The visible sidebar toggle: the general hide-ability the toolbar promises.
// ⌘B and the palette were already wired; these pin the affordance itself —
// the state it announces and the state it draws cannot drift apart.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarToggle } from "../src/views/SidebarToggle.js";

const noop = (): void => undefined;

describe("SidebarToggle", () => {
  it("announces the action, not the state, in its label", () => {
    const shown = renderToStaticMarkup(
      <SidebarToggle visible={true} onToggle={noop} />,
    );
    const hidden = renderToStaticMarkup(
      <SidebarToggle visible={false} onToggle={noop} />,
    );
    expect(shown).toContain('aria-label="Hide sidebar"');
    expect(hidden).toContain('aria-label="Show sidebar"');
  });

  it("carries pressed state and the ⌘B shortcut for assistive tech", () => {
    const shown = renderToStaticMarkup(
      <SidebarToggle visible={true} onToggle={noop} />,
    );
    const hidden = renderToStaticMarkup(
      <SidebarToggle visible={false} onToggle={noop} />,
    );
    expect(shown).toContain('aria-pressed="true"');
    expect(hidden).toContain('aria-pressed="false"');
    expect(shown).toContain('aria-keyshortcuts="Meta+B"');
  });

  it("draws the filled pane only while the rail is visible", () => {
    const shown = renderToStaticMarkup(
      <SidebarToggle visible={true} onToggle={noop} />,
    );
    const hidden = renderToStaticMarkup(
      <SidebarToggle visible={false} onToggle={noop} />,
    );
    // The fill is the only <rect> beyond the frame; count them rather than
    // matching attribute soup.
    expect(shown.match(/<rect/g)?.length).toBe(2);
    expect(hidden.match(/<rect/g)?.length).toBe(1);
  });

  it("wears the class the sub-820px media query hides", () => {
    const markup = renderToStaticMarkup(
      <SidebarToggle visible={true} onToggle={noop} />,
    );
    expect(markup).toContain("sidebar-toggle");
  });
});
