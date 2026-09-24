/**
 * Display-sleep suppression while threads are live.
 *
 * The renderer owns the decision (it is the side that knows the preference and
 * what is running across every loaded project); main owns the mechanism,
 * because `powerSaveBlocker` only exists here. The channel therefore carries a
 * single boolean — "I currently want the screen kept awake" — not thread
 * state, so this module never needs to understand sessions.
 *
 * Votes are tracked per webContents rather than as one flag: a window that is
 * reloaded, navigated, or destroyed can never send the release it owes, so the
 * caller in main.ts drops its vote on those events instead of trusting it. One
 * OS blocker backs any number of votes — starting a second would leak, since
 * only the id we hold ever gets stopped.
 *
 * Electron is injected rather than imported so this file is testable under
 * plain node — the same rule as `quick-actions.ts` and `terminal.ts`.
 */

export type KeepAwakeResult =
  | { ok: true; active: boolean }
  | { ok: false; error: string };

export interface PowerSaveDeps {
  /** `powerSaveBlocker.start("prevent-display-sleep")`, returning its id. */
  start(): number;
  stop(id: number): void;
}

export interface ScreenKeeper {
  /** A renderer's current wish. Anything but a strict boolean is refused. */
  set(senderId: number, input: unknown): KeepAwakeResult;
  /** Forget a webContents entirely (destroyed, or navigated to a new page). */
  drop(senderId: number): void;
  /** Whether the OS blocker is held right now. */
  active(): boolean;
  dispose(): void;
}

export function createScreenKeeper(deps: PowerSaveDeps): ScreenKeeper {
  const wanting = new Set<number>();
  let blockerId: number | null = null;

  const reconcile = (): void => {
    if (wanting.size > 0 && blockerId === null) {
      blockerId = deps.start();
      return;
    }
    if (wanting.size === 0 && blockerId !== null) {
      deps.stop(blockerId);
      blockerId = null;
    }
  };

  return {
    set(senderId, input) {
      // Trust boundary: the payload is whatever the IPC channel was handed.
      if (typeof input !== "boolean") {
        return { ok: false, error: "invalid keep-awake request" };
      }
      if (input) wanting.add(senderId);
      else wanting.delete(senderId);
      reconcile();
      return { ok: true, active: blockerId !== null };
    },
    drop(senderId) {
      if (!wanting.delete(senderId)) return;
      reconcile();
    },
    active: () => blockerId !== null,
    dispose() {
      wanting.clear();
      reconcile();
    },
  };
}
