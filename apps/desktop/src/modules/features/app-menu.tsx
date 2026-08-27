import type { ReactNode } from "react";
import { AppMenu } from "../../views/AppMenu.js";
import type { DesktopHost } from "../host.js";
import type { DesktopModule } from "../runtime.js";

function AppMenuContribution(props: { host: DesktopHost }): ReactNode {
  return <AppMenu theme={props.host.theme} />;
}

const appMenu: DesktopModule<DesktopHost> = {
  id: "app-menu",
  name: "Application menu",
  requires: ["fibers"],
  activate(context) {
    context.registerToolbar({
      id: "app-menu",
      order: 20,
      position: "actions",
      Component: AppMenuContribution,
    });
  },
};

export default appMenu;
