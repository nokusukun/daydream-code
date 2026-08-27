import type { ReactNode } from "react";
import { QuickActions } from "../../views/QuickActions.js";
import type { DesktopHost } from "../host.js";
import type { DesktopModule } from "../runtime.js";

function QuickActionsContribution(): ReactNode {
  return <QuickActions />;
}

const quickActions: DesktopModule<DesktopHost> = {
  id: "quick-actions",
  name: "Quick actions",
  activate(context) {
    context.registerToolbar({
      id: "quick-actions",
      order: 10,
      position: "actions",
      Component: QuickActionsContribution,
    });
  },
};

export default quickActions;
