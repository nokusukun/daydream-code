import type { ReactNode } from "react";
import { useHarness } from "../../harness.js";
import { MasterPanel } from "../../views/MasterPanel.js";
import { SessionPanel } from "../../views/SessionPanel.js";
import { ThreadRail } from "../../views/ThreadRail.js";
import type { DesktopModule } from "../runtime.js";
import type { DesktopHost } from "../host.js";

function AgentPanel(): ReactNode {
  const { selected } = useHarness();
  return selected === null ? <MasterPanel /> : <SessionPanel key={selected} id={selected} />;
}

const agent: DesktopModule<DesktopHost> = {
  id: "agent",
  name: "Agent workspace",
  activate(context) {
    context.registerMode({
      id: "agent",
      label: "Agent",
      order: 0,
      splitId: "shell-rail",
      sidebar: ThreadRail,
      panel: AgentPanel,
    });
  },
};

export default agent;
