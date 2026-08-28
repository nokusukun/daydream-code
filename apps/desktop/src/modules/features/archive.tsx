import type { DesktopModule } from "../runtime.js";
import type { DesktopHost } from "../host.js";
import { ArchiveSheet } from "../../views/ArchiveSheet.js";

const archive: DesktopModule<DesktopHost> = {
  id: "archive",
  name: "Thread archive",
  activate(context) {
    context.registerOverlay({
      id: "archive",
      Component: ArchiveSheet,
      command: { label: "Show archived threads", order: 10 },
    });
  },
};

export default archive;
