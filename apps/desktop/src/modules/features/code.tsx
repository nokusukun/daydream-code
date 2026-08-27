import type { DesktopModule } from "../runtime.js";
import type { DesktopHost } from "../host.js";
import { FileTree } from "../../views/FileTree.js";
import { CodeView } from "../../views/CodeView.js";

const code: DesktopModule<DesktopHost> = {
  id: "code",
  name: "Code workspace",
  activate(context) {
    context.registerMode({
      id: "code",
      label: "Code",
      order: 10,
      splitId: "shell-tree",
      sidebar: FileTree,
      panel: CodeView,
    });
  },
};

export default code;
