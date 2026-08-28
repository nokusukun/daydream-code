import type { DesktopModule } from "../runtime.js";
import type { DesktopHost } from "../host.js";
import { TerminalView } from "../../views/TerminalView.js";

/**
 * Terminals, as a peer of Threads and Code.
 *
 * No sidebar: a terminal's own tab strip is the only navigation it has, and a
 * mode may omit `sidebar` to take the full width of the body.
 */
const terminal: DesktopModule<DesktopHost> = {
  id: "terminal",
  name: "Terminal",
  activate(context) {
    context.registerMode({
      id: "terminal",
      label: "Terminal",
      order: 20,
      splitId: "shell-terminal",
      panel: TerminalView,
    });
  },
};

export default terminal;
