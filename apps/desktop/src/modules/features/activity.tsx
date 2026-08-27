import type { ReactNode } from "react";
import { ActivityMenu } from "../../views/ActivityMenu.js";
import type { DesktopHost } from "../host.js";
import type { DesktopModule } from "../runtime.js";

function Activity(props: { host: DesktopHost }): ReactNode {
  return (
    <ActivityMenu
      onOpenProject={props.host.switcher?.onOpen}
      onOpenProjectSession={props.host.switcher?.onOpenSession}
    />
  );
}

const activity: DesktopModule<DesktopHost> = {
  id: "activity",
  name: "Project activity",
  activate(context) {
    context.registerToolbar({
      id: "activity",
      position: "center",
      Component: Activity,
    });
  },
};

export default activity;
