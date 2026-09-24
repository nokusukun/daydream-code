import type { ReactNode } from "react";
import { useKeepAwakeDriver } from "../../keep-awake.js";
import type { DesktopHost } from "../host.js";
import type { DesktopModule } from "../runtime.js";

/**
 * Headless: the toolbar slot is the only contribution kind that renders under
 * `ProjectFanoutProvider`, which is where cross-project liveness lives. The
 * component contributes no DOM — it exists so the driver hook has a mount
 * point that unloads with this module rather than with a view.
 */
function KeepAwakeDriver(): ReactNode {
  useKeepAwakeDriver();
  return null;
}

const keepAwake: DesktopModule<DesktopHost> = {
  id: "keep-awake",
  name: "Keep screen awake",
  activate(context) {
    context.registerToolbar({
      id: "keep-awake",
      position: "actions",
      Component: KeepAwakeDriver,
    });
  },
};

export default keepAwake;
