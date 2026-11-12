export { isWindowAlive, hostWindow, ACCEL_CLICK };

/**
 * A window to borrow web APIs from (fetch, PathUtils, IOUtils): Zotero's
 * main window, or, on macOS, where Zotero keeps running with the main
 * window closed (Settings can still open), whichever Zotero window is open.
 */
function hostWindow(): any {
  return Zotero.getMainWindow() || (globalThis as any).Services?.wm?.getMostRecentWindow(null);
}

/** Click with the platform's command modifier, in words */
const ACCEL_CLICK = Zotero.isMac ? "⌘-click" : "Ctrl+click";

/**
 * Check if the window is alive.
 * Useful to prevent opening duplicate windows.
 * @param win
 */
function isWindowAlive(win?: Window) {
  return win && !Components.utils.isDeadWrapper(win) && !win.closed;
}
