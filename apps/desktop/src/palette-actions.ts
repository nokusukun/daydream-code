export interface PaletteAction {
  keepOpen?: boolean;
  run(): void;
}

/**
 * Close the palette before running an action that may open another overlay.
 * React batches both updates from a click, so reversing this order would let
 * the palette cleanup overwrite the overlay selected by the action.
 */
export function runPaletteAction(action: PaletteAction, close: () => void): void {
  if (action.keepOpen !== true) close();
  action.run();
}
