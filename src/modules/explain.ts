/**
 * Picking a passage in the PDF to ask about it.
 *
 * By default a picked passage attaches to the question box (Enter runs the
 * recommended Explain prompt, or the reader types their own question);
 * "Explain now" skips that step.
 *
 * Ways in:
 * - right-click → "Ask about this paragraph" / "Explain this paragraph now"
 *   (official createViewContextMenu hook; params.position is the word under
 *   the cursor)
 * - select text → "Ask" / "Explain" in the selection popup (official
 *   renderTextSelectionPopup hook): exactly those sentences
 * - Pick paragraph mode: hover outlines paragraphs, a click attaches one.
 *   Uses the PDF view's pointerEventToPosition, which is internal, so it is
 *   guarded.
 *
 * The Konnash pane for the PDF registers a controller here; a request that
 * arrives before the pane exists waits until it renders.
 */
import { config } from "../../package.json";
import { getDocument, KonnashDocument } from "./document";
import { getSpanHighlight, parseCitation } from "./citations";
import { locateParagraph, locateSentences } from "./structure";
import { getReaderPDFView, previewContext } from "./highlighter";
import { setFocusMode } from "./focusMode";

export interface ExplainTarget {
  paragraph: number;
  /** Global sentence range for a selection */
  sentences?: [number, number];
}

export type PickMode = "attach" | "now";

export interface ExplainController {
  pick: (target: ExplainTarget, mode: PickMode) => void;
}

const controllers = new Map<number, ExplainController>();
const pending = new Map<number, { target: ExplainTarget; mode: PickMode }>();

export function registerExplainController(attachmentID: number, controller: ExplainController) {
  controllers.set(attachmentID, controller);
  const waiting = pending.get(attachmentID);
  if (waiting) {
    pending.delete(attachmentID);
    controller.pick(waiting.target, waiting.mode);
  }
}

export function unregisterExplainController(attachmentID: number, controller: ExplainController) {
  if (controllers.get(attachmentID) === controller) controllers.delete(attachmentID);
}

function paneWindow(reader: any): Window {
  return (reader?._window as Window) || (Zotero.getMainWindow() as unknown as Window);
}

/** Send a picked passage to the pane, opening Konnash (full pane) if needed */
export function requestPick(reader: any, target: ExplainTarget, mode: PickMode) {
  const attachmentID: number = reader.itemID;
  const controller = controllers.get(attachmentID);
  setFocusMode(paneWindow(reader).document, true);
  if (controller) controller.pick(target, mode);
  else pending.set(attachmentID, { target, mode });
}

async function targetFromPosition(reader: any, position: any, selection: boolean) {
  const kdoc = await getDocument(reader.itemID);
  if (!kdoc || !position) return null;
  if (selection) {
    const sentences = locateSentences(kdoc, position);
    if (sentences) {
      const paragraph = kdoc.sentences[sentences[0]].paragraph;
      const p = kdoc.paragraphs[paragraph];
      const whole = sentences[0] === p.sentences[0] && sentences[1] === p.sentences[p.sentences.length - 1];
      return { paragraph, sentences: whole ? undefined : sentences } as ExplainTarget;
    }
  }
  const paragraph = locateParagraph(kdoc, position);
  return paragraph === null ? null : ({ paragraph } as ExplainTarget);
}

// ---------------------------------------------------------------------------
// Reader hooks

const listeners: [string, (event: any) => void][] = [];

export function registerExplainEntryPoints() {
  const onContextMenu = (event: any) => {
    const { reader, params, append } = event;
    if (reader?.type !== "pdf" || !params?.position) return;
    for (const [label, mode] of [
      ["Ask Konnash about this paragraph…", "attach"],
      ["Explain this paragraph now (Konnash)", "now"],
    ] as [string, PickMode][]) {
      append({
        label,
        onCommand: async () => {
          const target = await targetFromPosition(reader, params.position, false);
          if (target) requestPick(reader, target, mode);
        },
      });
    }
  };
  const onSelectionPopup = (event: any) => {
    const { reader, doc, params, append } = event;
    if (reader?.type !== "pdf" || !params?.annotation?.position) return;
    const row = doc.createElement("div");
    row.style.cssText = "display: flex; gap: 6px; margin: 4px 6px 2px; align-items: center;";
    const label = doc.createElement("span");
    label.textContent = "Konnash:";
    label.style.cssText = "opacity: 0.7; font-size: 0.92em;";
    row.append(label);
    for (const [text, mode, title] of [
      ["Ask", "attach", "Attach this passage to Konnash's question box"],
      ["Explain", "now", "Explain this passage now with the recommended prompt"],
    ] as [string, PickMode, string][]) {
      const button = doc.createElement("button");
      button.textContent = text;
      button.title = title;
      button.style.cssText =
        "padding: 1px 10px; border-radius: 5px; border: 1px solid #8f7ae6; background: transparent; color: inherit; cursor: pointer; font: inherit;";
      button.addEventListener("click", async () => {
        const target = await targetFromPosition(reader, params.annotation.position, true);
        if (target) requestPick(reader, target, mode);
      });
      row.append(button);
    }
    append(row);
  };
  for (const [type, handler] of [
    ["createViewContextMenu", onContextMenu],
    ["renderTextSelectionPopup", onSelectionPopup],
  ] as [string, (event: any) => void][]) {
    (Zotero.Reader as any).registerEventListener(type, handler, config.addonID);
    listeners.push([type, handler]);
  }
}

export function unregisterExplainEntryPoints() {
  for (const [type, handler] of listeners) {
    (Zotero.Reader as any).unregisterEventListener(type, handler);
  }
  listeners.length = 0;
  stopAllClickModes();
}

// ---------------------------------------------------------------------------
// Click mode

const clickModes = new Map<any, () => void>();

export function isClickModeAvailable(reader: any) {
  const view = getReaderPDFView(reader);
  return !!view && typeof view.pointerEventToPosition === "function" && !!view._iframeWindow;
}

export function isClickModeOn(reader: any) {
  return clickModes.has(reader);
}

function paragraphPosition(kdoc: KonnashDocument, paragraph: number) {
  const span = parseCitation(kdoc, kdoc.paragraphs[paragraph].id).spans[0];
  return span ? getSpanHighlight(kdoc, span).context : null;
}

/**
 * While on, hovering outlines the paragraph under the pointer and a click
 * explains it. Esc (or onStop's caller) ends it.
 */
export function startClickMode(reader: any, kdoc: KonnashDocument, onStop: () => void) {
  if (clickModes.has(reader)) return;
  const view = getReaderPDFView(reader);
  if (!isClickModeAvailable(reader)) throw new Error("Click mode is not available in this reader");
  const iwin = view._iframeWindow;
  const idoc = iwin.document;
  const style = idoc.createElement("style");
  style.textContent =
    "html.konnash-pick #viewerContainer, html.konnash-pick #viewerContainer * { cursor: pointer !important; }";
  idoc.documentElement.append(style);
  idoc.documentElement.classList.add("konnash-pick");

  let hovered: number | null = null;
  let frame = 0;
  const paragraphAt = (event: any) => {
    try {
      return locateParagraph(kdoc, view.pointerEventToPosition(event));
    } catch {
      return null;
    }
  };
  const onMove = (event: any) => {
    if (frame) return;
    frame = iwin.requestAnimationFrame(() => {
      frame = 0;
      const p = paragraphAt(event);
      if (p === hovered) return;
      hovered = p;
      previewContext(reader, p === null ? null : paragraphPosition(kdoc, p));
    });
  };
  const swallow = (event: any) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const onClick = (event: any) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const p = paragraphAt(event);
    if (p !== null) {
      // A pick chooses one paragraph: attach it and leave pick mode
      stop();
      requestPick(reader, { paragraph: p }, "attach");
    }
  };
  const onKey = (event: any) => {
    if (event.key === "Escape") stop();
  };
  const mainDoc = paneWindow(reader).document;
  const options = { capture: true };
  idoc.addEventListener("pointermove", onMove, options);
  idoc.addEventListener("pointerdown", swallow, options);
  idoc.addEventListener("mousedown", swallow, options);
  idoc.addEventListener("click", onClick, options);
  idoc.addEventListener("keydown", onKey, options);
  mainDoc.addEventListener("keydown", onKey, options);

  const stop = () => {
    if (!clickModes.has(reader)) return;
    clickModes.delete(reader);
    try {
      idoc.removeEventListener("pointermove", onMove, options);
      idoc.removeEventListener("pointerdown", swallow, options);
      idoc.removeEventListener("mousedown", swallow, options);
      idoc.removeEventListener("click", onClick, options);
      idoc.removeEventListener("keydown", onKey, options);
      idoc.documentElement.classList.remove("konnash-pick");
      style.remove();
      previewContext(reader, null);
    } catch {
      // The reader may already be closed
    }
    mainDoc.removeEventListener("keydown", onKey, options);
    onStop();
  };
  clickModes.set(reader, stop);
}

export function stopClickMode(reader: any) {
  clickModes.get(reader)?.();
}

function stopAllClickModes() {
  for (const stop of [...clickModes.values()]) stop();
}
