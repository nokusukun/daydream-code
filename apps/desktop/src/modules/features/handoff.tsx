import type { DesktopModule } from "../runtime.js";
import type { DesktopHost } from "../host.js";
import { HandoffSheet } from "../../views/HandoffSheet.js";

/**
 * No palette command on purpose: the sheet is meaningless without a staged
 * source thread, and the only gesture that stages one is the thread row's
 * context menu.
 */
const handoff: DesktopModule<DesktopHost> = {
  id: "handoff",
  name: "Thread handoff",
  activate(context) {
    context.registerOverlay({
      id: "handoff",
      Component: HandoffSheet,
    });
  },
};

export default handoff;
