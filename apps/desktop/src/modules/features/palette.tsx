import type { ReactNode } from "react";
import { CommandPalette } from "../../views/CommandPalette.js";
import { useDesktopHost, type DesktopHost } from "../host.js";
import type { DesktopModule } from "../runtime.js";

function Palette(): ReactNode {
  const host = useDesktopHost();
  return (
    <CommandPalette
      onSwitchProject={host.switcher === undefined ? undefined : host.openSwitcher}
    />
  );
}

const palette: DesktopModule<DesktopHost> = {
  id: "palette",
  name: "Command palette",
  activate(context) {
    context.registerOverlay({ id: "palette", Component: Palette });
  },
};

export default palette;
