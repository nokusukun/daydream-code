import type { DesktopModule } from "../runtime.js";
import type { DesktopHost } from "../host.js";
import { ThreadRail } from "../../views/ThreadRail.js";
import { BoardView } from "../../views/BoardView.js";

/**
 * Board mode: the kanban lanes, full width by default. The same thread rail
 * agent mode uses is still contributed — ⌘B shows it, per-mode — but it starts
 * hidden: the lanes want the width, and the threads a card points at are
 * reachable from the card, so the rail is a preference here, not navigation.
 */
const board: DesktopModule<DesktopHost> = {
  id: "board",
  name: "Kanban board",
  activate(context) {
    context.registerMode({
      id: "board",
      label: "Board",
      order: 5,
      splitId: "shell-board",
      sidebar: ThreadRail,
      // Hidden by default: the lanes want the width, and every thread a card
      // points at is reachable from the card itself. ⌘B (or the palette's
      // "Show sidebar") brings the rail back, and that choice sticks.
      sidebarDefault: false,
      panel: BoardView,
    });
  },
};

export default board;
