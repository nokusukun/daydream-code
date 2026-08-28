import { describe, expect, it } from "vitest";
import type { AgentSkill } from "@daydream-code/driver";
import {
  leadingSkillQuery,
  matchingSkills,
  skillInvocation,
  skillMenuOpen,
  skillMenuKeyAction,
} from "../src/views/Composer.js";

const skills: AgentSkill[] = [
  {
    name: "cloudflare",
    invocation: "/",
    description: "Build on the Cloudflare platform",
  },
  {
    name: "impeccable",
    invocation: "/",
    description: "Polish and audit frontend interfaces",
  },
  {
    name: "web-perf",
    invocation: "/",
    description: "Measure browser performance and Core Web Vitals",
  },
];

describe("composer skill completion", () => {
  it("opens only for an unfinished slash token at the start", () => {
    expect(leadingSkillQuery("/")).toBe("");
    expect(leadingSkillQuery("/ImP")).toBe("imp");
    expect(leadingSkillQuery("hello /imp")).toBeNull();
    expect(leadingSkillQuery("/impeccable audit this")).toBeNull();
    expect(leadingSkillQuery("$impeccable")).toBeNull();
  });

  it("ranks name prefixes before name and description matches", () => {
    expect(matchingSkills(skills, "web").map((skill) => skill.name)).toEqual([
      "web-perf",
    ]);
    expect(matchingSkills(skills, "front").map((skill) => skill.name)).toEqual([
      "impeccable",
    ]);
    expect(matchingSkills(skills, "")).toEqual(skills);
  });

  it("reserves the native listbox keys while the menu is open", () => {
    expect(skillMenuKeyAction("ArrowUp")).toBe("previous");
    expect(skillMenuKeyAction("ArrowDown")).toBe("next");
    expect(skillMenuKeyAction("Enter")).toBe("choose");
    expect(skillMenuKeyAction("Tab")).toBe("choose");
    expect(skillMenuKeyAction("Escape")).toBe("dismiss");
    expect(skillMenuKeyAction("a")).toBeNull();
  });

  it("inserts the syntax the selected provider actually invokes", () => {
    expect(skillInvocation(skills[1]!)).toBe("/impeccable ");
    expect(
      skillInvocation({
        name: "verify",
        invocation: "$",
        description: "Prove it",
      }),
    ).toBe("$verify ");
  });

  it("stays shut on a composer with no provider to ask", () => {
    const open = (value: string, driver: string, dismissed: string | null = null) =>
      skillMenuOpen({ value, driver, dismissed });

    expect(open("/imp", "claude")).toBe(true);
    expect(open("/", "codex")).toBe(true);
    // No session means no driver, and a request we cannot make must not render
    // as a provider that failed.
    expect(open("/imp", "")).toBe(false);
    // Escape dismisses this exact value, but typing on reopens the menu.
    expect(open("/imp", "claude", "/imp")).toBe(false);
    expect(open("/impe", "claude", "/imp")).toBe(true);
    expect(open("ship it", "claude")).toBe(false);
  });
});
