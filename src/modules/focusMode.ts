/**
 * Focus mode: in reader tabs, the Konnash section fills the whole right
 * pane (item info, abstract, tags… are hidden) and scrolls on its own.
 *
 * Clicking the Konnash icon in the pane's side column enters focus mode;
 * clicking any other icon returns to the normal item details. The state is
 * a window attribute read by zotero.css, scoped to reader tabs.
 */
import { getPref, setPref } from "../utils/prefs";

const ATTR = "data-konnash-view";
let konnashPaneID: string | null = null;
const disposers = new Map<Window, () => void>();

export function setKonnashPaneID(id: string | false) {
  konnashPaneID = id || null;
}

export function isFocusMode(doc: Document) {
  return doc.documentElement!.getAttribute(ATTR) === "chat";
}

export function setFocusMode(doc: Document, on: boolean) {
  doc.documentElement!.setAttribute(ATTR, on ? "chat" : "details");
  setPref("focusMode", on);
  if (on) {
    // Make sure the right pane is open
    const sidenav = doc.getElementById("zotero-context-pane-sidenav") as any;
    if (sidenav && sidenav._collapsed) sidenav._collapsed = false;
  }
}

export function installFocusMode(win: Window) {
  const doc = win.document;
  doc.documentElement!.setAttribute(ATTR, getPref("focusMode") ? "chat" : "details");
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0) return;
    const button = (event.target as Element | null)?.closest?.(".btn[data-pane]");
    if (!button?.closest("#zotero-context-pane-sidenav")) return;
    const pane = button.getAttribute("data-pane");
    setFocusMode(doc, !!konnashPaneID && pane === konnashPaneID);
  };
  doc.addEventListener("click", onClick, true);
  disposers.set(win, () => {
    doc.removeEventListener("click", onClick, true);
    doc.documentElement!.removeAttribute(ATTR);
  });
}

export function uninstallFocusMode(win?: Window) {
  for (const [w, dispose] of [...disposers]) {
    if (win && w !== win) continue;
    dispose();
    disposers.delete(w);
  }
}
