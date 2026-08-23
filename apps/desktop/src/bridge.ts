/** Types for the preload-exposed IPC bridge (window.daydream). */

export interface ConnectionInfo {
  url: string;
  token: string;
  rootPath: string;
  name: string;
}

export interface RegistryEntry {
  rootPath: string;
  name: string;
  lastOpenedAt: string;
}

export type OpenResult =
  | { ok: true; connection: ConnectionInfo }
  | { ok: false; error: string };

export interface DaydreamBridge {
  getState(): Promise<{ connection: ConnectionInfo | null; recent: RegistryEntry[] }>;
  openProject(rootPath: string): Promise<OpenResult>;
  pickProject(): Promise<OpenResult | null>;
  onConnection(callback: (info: ConnectionInfo) => void): () => void;
}

declare global {
  interface Window {
    daydream?: DaydreamBridge;
  }
}

export function bridge(): DaydreamBridge | undefined {
  return window.daydream;
}

/**
 * Fallback for running the renderer outside Electron (plain browser against a
 * remote core): ?url=http://host:port&token=...
 */
export function connectionFromQuery(): ConnectionInfo | null {
  const params = new URLSearchParams(window.location.search);
  const url = params.get("url");
  if (url === null || url.length === 0) return null;
  return {
    url,
    token: params.get("token") ?? "",
    rootPath: "(remote)",
    name: "remote core",
  };
}
