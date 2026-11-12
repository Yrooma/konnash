/**
 * Konnash section in the reader's side pane. It hosts the panel (panel.ts)
 * in a shadow root; when the Konnash icon is selected the section fills the
 * pane (focusMode.ts).
 */
import panelCSS from "../../addon/content/panel.css";
import { config } from "../../package.json";
import { getLocaleID } from "../utils/locale";
import { getDocument, KonnashDocument } from "./document";
import { CitationSpan, getSpanHighlight } from "./citations";
import { createPanel } from "./panel";
import { setKonnashPaneID } from "./focusMode";
import { registerExplainController } from "./explain";
import { getSourceInfo } from "./structure";
import { getSelectedReader, showHighlight } from "./highlighter";

const HTML_NS = "http://www.w3.org/1999/xhtml";
// Evaluated at script load, before `addon` exists: use the static config
const ICON = `chrome://${config.addonRef}/content/icons/konnash.svg`;

const panels = new WeakMap<HTMLElement, { dispose: () => void }>();

export function registerReaderPane() {
  const paneID = Zotero.ItemPaneManager.registerSection({
    paneID: "konnash-reader",
    pluginID: addon.data.config.addonID,
    header: {
      l10nID: getLocaleID("section-head"),
      icon: ICON,
    },
    sidenav: {
      l10nID: getLocaleID("section-sidenav"),
      icon: ICON,
    },
    onInit: ({ body }) => {
      // Lets the full-pane rules in zotero.css find this section
      body.closest("item-pane-custom-section")?.classList.add("konnash-section");
    },
    onDestroy: ({ body }) => {
      panels.get(body)?.dispose();
      panels.delete(body);
    },
    onItemChange: ({ setEnabled, tabType }) => {
      setEnabled(tabType === "reader");
      return true;
    },
    onRender: () => {},
    onAsyncRender: async ({ body, setSectionSummary }) => {
      const win = body.ownerGlobal as Window;
      const reader = getSelectedReader(win) as any;
      if (!reader?.itemID) return;
      const attachmentID: number = reader.itemID;
      if (body.dataset.attachmentId === String(attachmentID)) return;
      body.dataset.attachmentId = String(attachmentID);
      await renderPane(body, attachmentID, setSectionSummary);
    },
  });
  setKonnashPaneID(paneID);
}

/** A one-line message in the panel's own style (loading, errors) */
function showMessage(host: HTMLElement, text: string) {
  const doc = host.ownerDocument!;
  const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
  const style = doc.createElementNS(HTML_NS, "style") as HTMLStyleElement;
  style.textContent = panelCSS;
  const message = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  message.className = "k-empty-small";
  message.textContent = text;
  shadow.replaceChildren(style, message);
}

async function renderPane(body: HTMLElement, attachmentID: number, setSectionSummary: (summary: string) => void) {
  const doc = body.ownerDocument!;
  panels.get(body)?.dispose();
  body.replaceChildren();
  const host = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  host.className = "konnash-host";
  body.appendChild(host);
  showMessage(host, "Reading the document's structure…");

  let kdoc: KonnashDocument | null;
  try {
    kdoc = await getDocument(attachmentID);
  } catch (e: any) {
    showMessage(host, `Could not read this document: ${e?.message || e}`);
    return;
  }
  if (!kdoc || !kdoc.sentences.length) {
    showMessage(host, "No text found in this PDF. If it is a scanned document, it needs OCR before Konnash can read it.");
    return;
  }
  const documentData = kdoc;
  setSectionSummary(`${documentData.sentences.length} sentences`);

  const showSpan = async (span: CitationSpan) => {
    const reader = getSelectedReader(body.ownerGlobal as Window);
    if (!reader || (reader as any).itemID !== attachmentID) return;
    const mode = await showHighlight(reader, getSpanHighlight(documentData, span));
    if (mode === "flash") ztoolkit.log("Konnash: persistent highlight unavailable, used a brief flash");
    return mode;
  };

  const attachment = Zotero.Items.get(attachmentID) as Zotero.Item;
  const title =
    (attachment?.parentItem?.getField("title") as string) || (attachment?.getField("title") as string) || "Document";
  const panel = createPanel(doc, host, {
    kdoc: documentData,
    attachment,
    title,
    source: getSourceInfo(attachment),
    showSpan,
  });
  panels.set(body, panel);
  // Picked passages (right-click, selection, "A passage…") land here
  registerExplainController(attachmentID, { pick: panel.pick });
}
