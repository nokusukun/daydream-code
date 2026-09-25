/**
 * Removing a project from the list. The control is a sibling of the row
 * button (buttons do not nest), so these check which rows offer it and that
 * it survives on the rows that cannot be opened.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "../src/bridge.js";
import { ProjectRow } from "../src/views/ProjectSwitcher.js";

function project(over: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    rootPath: "/Users/me/projects/api",
    name: "api",
    lastOpenedAt: "2026-09-20T00:00:00.000Z",
    exists: true,
    active: false,
    stats: null,
    icon: null,
    ...over,
  };
}

function render(
  over: Partial<ProjectSummary>,
  props: { onRemove?: ((rootPath: string) => void) | null; removing?: boolean } = {},
): string {
  return renderToStaticMarkup(
    createElement(ProjectRow, {
      project: project(over),
      home: "/Users/me",
      opening: false,
      onOpen() {},
      onRemove: "onRemove" in props ? props.onRemove : () => {},
      ...(props.removing !== undefined ? { removing: props.removing } : {}),
    }),
  );
}

/** The opening tag of the first element carrying `className`. */
function tag(html: string, className: string): string | undefined {
  return html.match(new RegExp(`<[a-z]+[^>]*class="${className}[ "][^>]*>`))?.[0];
}

describe("ProjectRow remove control", () => {
  it("is offered on a project that is not open", () => {
    expect(tag(render({}), "proj-remove")).toContain('aria-label="Remove api from the list"');
  });

  it("is not offered on the open project", () => {
    expect(tag(render({ active: true }), "proj-remove")).toBeUndefined();
  });

  it("stays usable on a missing folder, whose row cannot be opened", () => {
    const html = render({ exists: false });
    expect(tag(html, "proj-row")).toContain("disabled");
    expect(tag(html, "proj-remove")).not.toContain("disabled");
  });

  it("is absent when the bridge cannot remove projects", () => {
    expect(tag(render({}, { onRemove: null }), "proj-remove")).toBeUndefined();
  });

  it("says so while the removal is in flight", () => {
    const html = render({}, { removing: true });
    expect(tag(html, "proj-remove")).toBeUndefined();
    expect(html).toContain("removing…");
    expect(tag(html, "proj-row")).toContain("disabled");
  });
});
