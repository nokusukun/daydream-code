// Runs inside the probe window. Exercises the renderer half the way
// TerminalView does: the real preload bridge, real xterm, and the real theme
// resolution against this app's color-mix()/oklch()/light-dark() tokens.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  createColorResolver,
  nextTerminalId,
  readTerminalTheme,
  terminalLabel,
} from "../src/terminal.js";

const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass: Boolean(pass), detail: String(detail) });
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const host = document.getElementById("host");
  const api = window.daydream;

  check("preload exposes the terminal bridge", typeof api?.openTerminal === "function");
  check("preload exposes the event subscription", typeof api?.onTerminalEvent === "function");

  // The trap this file exists to catch: xterm parses colours itself, and every
  // token in this app is color-mix() / oklch() / light-dark().
  const resolver = createColorResolver(host);
  const theme = readTerminalTheme(resolver, true);
  const isHex = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
  check("color-mix() token resolves to something xterm can parse", isHex(theme.background), theme.background);
  check("oklch() token resolves", isHex(theme.foreground), theme.foreground);
  check("light-dark() token resolves", isHex(theme.red), theme.red);
  // The dark side is oklch(70% .17 22); the light side is oklch(52% .19 25).
  // Picking the wrong one is the failure a canvas-only resolver would produce.
  check(
    "light-dark() resolves to the side matching the document theme",
    isHex(theme.red) && parseInt(theme.red.slice(1, 3), 16) > 200,
    theme.red,
  );
  check("an unknown token is reported as unresolved, not as inherited text colour",
    resolver.resolve("var(--definitely-not-a-token)") === null);

  check("id allocation fills the lowest free slot", nextTerminalId(["term-1", "term-3"]) === "term-2");
  check("tab label reads as prose", terminalLabel("term-2") === "Terminal 2");

  const term = new Terminal({ fontFamily: "ui-monospace, monospace", fontSize: 12, theme });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();
  check("xterm fits its container to a real grid", term.cols > 20 && term.rows > 5, `${term.cols}x${term.rows}`);

  let live = "";
  api.onTerminalEvent((event) => {
    if (event.type === "output" && event.data !== undefined) {
      live += event.data;
      term.write(event.data);
    }
  });

  const opened = await api.openTerminal({ terminalId: "term-1", cols: term.cols, rows: term.rows });
  check("renderer attaches through the bridge", opened.ok === true, opened.ok ? "" : opened.error);
  if (opened.ok) {
    term.write(opened.snapshot.history);
    check("attach replays the shell's earlier output", /PROBE_42/.test(opened.snapshot.history));
  }

  term.onData((data) => void api.writeTerminal({ terminalId: "term-1", data }));

  await settle(500);
  // Type through xterm's own input path rather than calling the bridge.
  term.input("echo FROM_XTERM_INPUT\r");
  await settle(1800);
  check("keystrokes reach the shell and echo back", /FROM_XTERM_INPUT/.test(live));

  const painted = () =>
    [...host.querySelectorAll(".xterm-rows > div")].map((r) => r.textContent ?? "").join("\n");
  check("output is painted into the DOM", /FROM_XTERM_INPUT/.test(painted()));

  term.input("printf '\\033[32mGREENTEXT\\033[0m\\n'\r");
  await settle(1800);
  const coloured = [...host.querySelectorAll(".xterm-rows span")].filter((s) =>
    (s.textContent ?? "").includes("GREENTEXT"),
  );
  check("ANSI colour survives to a styled span", coloured.length > 0);

  const ack = await api.resizeTerminal({ terminalId: "term-1", cols: term.cols, rows: term.rows });
  check("resize round-trips through the bridge", ack.ok === true);

  window.__probe = checks;
  window.__probeDone = true;
}

run().catch((error) => {
  check("renderer ran without throwing", false, String(error && error.stack ? error.stack : error));
  window.__probe = checks;
  window.__probeDone = true;
});
