import { createContext, useContext, type ReactNode } from "react";
import type { ThemeState } from "../appearance.js";

export interface ProjectSwitcherHost {
  opening: string | null;
  error: string | null;
  onOpen(rootPath: string): void;
  onOpenSession(rootPath: string, sessionId: string): void;
  onPick(): void;
}

/** Stable shell capabilities that feature modules may consume. */
export interface DesktopHost {
  theme: ThemeState;
  switcher?: ProjectSwitcherHost;
  openSwitcher(): void;
}

const HostContext = createContext<DesktopHost | null>(null);

export function DesktopHostProvider(props: {
  value: DesktopHost;
  children: ReactNode;
}): ReactNode {
  return <HostContext.Provider value={props.value}>{props.children}</HostContext.Provider>;
}

export function useDesktopHost(): DesktopHost {
  const host = useContext(HostContext);
  if (host === null) throw new Error("useDesktopHost outside <DesktopHostProvider>");
  return host;
}
