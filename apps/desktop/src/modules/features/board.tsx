import type { DesktopModule } from "../runtime.js";
import type { DesktopHost } from "../host.js";
import { ThreadRail } from "../../views/ThreadRail.js";
import { BoardView } from "../../views/BoardView.js";

/**
 * Board mode: the kanban lanes beside the same thread rail the agent mode
 * uses, so the evaluator sessions and the work sessions a card points at are
 * one click away without leaving the board.
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
      panel: BoardView,
    });
  },
};

export default board;
