import zoteroCSS from "../addon/content/zotero.css";
import { initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { registerReaderPane } from "./modules/readerPane";
import { clearDocumentCache } from "./modules/document";
import { onPrefsLoad, registerPreferences } from "./modules/preferences";
import { installFocusMode, uninstallFocusMode } from "./modules/focusMode";
import { clearDocStoreCache, pruneBackups } from "./modules/docStore";
import { registerExplainEntryPoints, unregisterExplainEntryPoints } from "./modules/explain";
import { keepEarlierProviderChoice } from "./modules/ai/providers";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  keepEarlierProviderChoice();

  registerReaderPane();

  registerExplainEntryPoints();

  await registerPreferences();

  pruneBackups();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  installGlobalStyles(win.document);
  installFocusMode(win);
}

/**
 * The few rules that must apply to Zotero's own document (full-pane
 * layout), embedded from the bundle. Stylesheets left by earlier Konnash
 * versions are removed first, so a stale cached copy can't linger.
 */
function installGlobalStyles(doc: Document) {
  removeGlobalStyles(doc);
  const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style") as HTMLStyleElement;
  style.id = "konnash-global-styles";
  style.textContent = zoteroCSS;
  doc.documentElement?.appendChild(style);
}

function removeGlobalStyles(doc: Document) {
  doc.querySelectorAll('#konnash-global-styles, link[href*="konnash"][href$=".css"]').forEach((node: Element) => node.remove());
}

async function onMainWindowUnload(win: Window): Promise<void> {
  uninstallFocusMode(win);
  removeGlobalStyles(win.document);
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  ztoolkit.unregisterAll();
  for (const win of Zotero.getMainWindows()) removeGlobalStyles(win.document);
  uninstallFocusMode();
  unregisterExplainEntryPoints();
  clearDocumentCache();
  clearDocStoreCache();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      onPrefsLoad(data.window);
      break;
    default:
      return;
  }
}

// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
