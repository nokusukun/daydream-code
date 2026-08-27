import type { DesktopModule } from "../runtime.js";
import type { DesktopHost } from "../host.js";
import { FibersSheet } from "../../views/FibersSheet.js";

const fibers: DesktopModule<DesktopHost> = {
  id: "fibers",
  name: "Plugin diagnostics",
  activate(context) {
    context.registerOverlay({
      id: "fibers",
      Component: FibersSheet,
      command: { label: "Show plugin fibers", order: 20 },
    });
  },
};

export default fibers;
