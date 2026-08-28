/**
 * Staging for the handoff sheet.
 *
 * Overlays are addressed by id alone (`setOverlay("handoff")`), so the thread
 * a context-menu click was about has to travel out of band. A module-level
 * slot rather than context: the write and the `setOverlay` happen in the same
 * tick, the sheet reads it once on mount, and nothing else may care. The slot
 * keeps its last value until restaged so a StrictMode double-mount cannot
 * lose it.
 */
import type { SessionRecord } from "@daydream-code/shared";

export type HandoffMode = "transcript" | "summary";

export interface HandoffStage {
  sessionId: string;
  name: string;
  title: string;
  driver: string;
  modelId: string | null;
  effort: string | null;
  mode: HandoffMode;
}

let staged: HandoffStage | null = null;

export function stageHandoff(session: SessionRecord, mode: HandoffMode): void {
  staged = {
    sessionId: session.id as string,
    name: session.name,
    title: session.title,
    driver: session.driver,
    modelId: session.modelId,
    effort: session.effort,
    mode,
  };
}

export function handoffStage(): HandoffStage | null {
  return staged;
}
