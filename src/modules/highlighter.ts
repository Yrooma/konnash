/**
 * Shows evidence in the Zotero PDF reader without creating annotations.
 *
 * Preferred path: the reader's two Read Aloud highlight layers, which stay
 * until cleared: the paragraph in light grey (context), the cited sentences
 * in colour (evidence). The reader draws both layers in its fixed Read
 * Aloud blue, so its page renderer is wrapped to use a colour carried on
 * Konnash's positions; without that wrap both layers stay blue.
 * Fallback: the public reader.navigate({ position }), which scrolls to the
 * position and flashes it for two seconds.
 */
import { ReaderPosition } from "./document";
import { SpanHighlight } from "./citations";

const CONTEXT_KEY = "_readAloudHighlightedPosition";
const EVIDENCE_KEY = "_readAloudSentenceHighlightedPosition";
// The reader paints a highlight at 40% opacity; the alpha here (last two
// digits) lightens it further, keeping the hue: a soft grey for the
// paragraph, a soft violet for the cited sentences
const CONTEXT_COLOR = "#9e9e9e8c";
const EVIDENCE_COLOR = "#8f6ee8b3";
const PATCHED = "__konnashColorPatch";

export type HighlightMode = "persistent" | "flash" | "none";

export function getSelectedReader(
  win: Window,
): _ZoteroTypes.ReaderInstance | null {
  const tabs = (win as any).Zotero_Tabs;
  if (!tabs?.selectedID) return null;
  return (Zotero.Reader.getByTabID(tabs.selectedID) as any) || null;
}

function getPDFView(reader: any) {
  const internal = reader?._internalReader;
  const view = internal?._lastView || internal?._primaryView;
  if (view && EVIDENCE_KEY in view && typeof view._render === "function") {
    return view;
  }
  return null;
}

function cloneInto<T>(value: T, win: any): T {
  return value ? Components.utils.cloneInto(value, win) : value;
}

/**
 * Let a highlighted position carry its own colour (konnashColor). Wraps
 * the reader page renderer's _pushHighlightedPosition once per reader;
 * positions without konnashColor (Read Aloud's own) are drawn unchanged.
 */
export function ensureColorPatch(view: any, win: any) {
  const page = view._pages?.[0];
  if (!page) return false;
  const proto = Object.getPrototypeOf(page);
  if (proto[PATCHED]) return true;
  const original = proto._pushHighlightedPosition;
  if (typeof original !== "function") return false;
  const patched = function (this: any, items: any, position: any, color: any) {
    return original.call(this, items, position, position?.konnashColor || color);
  };
  proto._pushHighlightedPosition = Components.utils.exportFunction(patched, win);
  proto[PATCHED] = true;
  return true;
}

function withColor(position: ReaderPosition | null, color: string) {
  return position ? { ...position, konnashColor: color } : null;
}

export async function showHighlight(
  reader: any,
  highlight: SpanHighlight,
): Promise<HighlightMode> {
  const target: ReaderPosition | null = highlight.evidence || highlight.context;
  if (!reader || !target) return "none";
  const win = reader._iframeWindow;
  const view = getPDFView(reader);
  if (view) {
    try {
      try {
        ensureColorPatch(view, win);
      } catch (e) {
        ztoolkit.log("Konnash: highlight colours unavailable, using Read Aloud blue", e);
      }
      view[CONTEXT_KEY] = cloneInto(withColor(highlight.context, CONTEXT_COLOR), win);
      view[EVIDENCE_KEY] = cloneInto(withColor(highlight.evidence, EVIDENCE_COLOR), win);
      view._render();
      if (typeof view.navigateToPosition === "function") {
        view.navigateToPosition(cloneInto(target, win), {
          block: "center",
          ifNeeded: true,
          behavior: "smooth",
        });
      } else {
        await reader.navigate({ position: target });
      }
      return "persistent";
    } catch (e) {
      ztoolkit.log("Persistent highlight failed, falling back", e);
    }
  }
  await reader.navigate({ position: target });
  return "flash";
}

/** Grey outline of a passage without moving the page (click-mode hover) */
export function previewContext(reader: any, position: ReaderPosition | null) {
  const view = getPDFView(reader);
  if (!view) return;
  const win = reader._iframeWindow;
  try {
    ensureColorPatch(view, win);
  } catch {
    // Read Aloud blue is an acceptable fallback for the outline
  }
  view[CONTEXT_KEY] = cloneInto(withColor(position, CONTEXT_COLOR), win);
  view[EVIDENCE_KEY] = null;
  view._render();
}

export function getReaderPDFView(reader: any) {
  return getPDFView(reader);
}

/** Whether the reader shows a Konnash highlight (not Read Aloud's own) */
export function hasKonnashHighlight(reader: any) {
  const view = reader && getPDFView(reader);
  return !!(view?.[EVIDENCE_KEY]?.konnashColor || view?.[CONTEXT_KEY]?.konnashColor);
}

/** Whether a point (PDF coordinates, one-point rect) falls on a highlighted position */
export function positionContains(position: ReaderPosition | null | undefined, point: ReaderPosition | null, slack = 3) {
  if (!position || !point?.rects?.[0]) return false;
  const [x, y] = point.rects[0];
  const rects =
    point.pageIndex === position.pageIndex
      ? position.rects
      : point.pageIndex === position.pageIndex + 1
        ? position.nextPageRects || []
        : [];
  return rects.some(([x1, y1, x2, y2]) => x >= Math.min(x1, x2) - slack && x <= Math.max(x1, x2) + slack && y >= Math.min(y1, y2) - slack && y <= Math.max(y1, y2) + slack);
}

/**
 * Call onOutside when the reader presses on a page of the PDF away from the
 * highlighted passage: they have moved on (to select text, to read on). A
 * press on the passage itself, between pages or on the scrollbar keeps it.
 * Returns a function that stops watching.
 */
export function watchOutsidePress(reader: any, onOutside: () => void): () => void {
  const view = getPDFView(reader);
  const idoc = view?._iframeWindow?.document;
  if (!idoc || typeof view.pointerEventToPosition !== "function") return () => {};
  const onDown = (event: any) => {
    if (event.button !== 0) return;
    // Picking a paragraph to ask about has its own outline
    if (idoc.documentElement.classList.contains("konnash-pick")) return;
    if (!hasKonnashHighlight(reader)) return;
    let point: ReaderPosition | null = null;
    try {
      point = view.pointerEventToPosition(event);
    } catch {
      return;
    }
    if (!point) return;
    if (positionContains(view[CONTEXT_KEY], point) || positionContains(view[EVIDENCE_KEY], point)) return;
    onOutside();
  };
  const options = { capture: true };
  idoc.addEventListener("pointerdown", onDown, options);
  return () => {
    try {
      idoc.removeEventListener("pointerdown", onDown, options);
    } catch {
      // The reader may already be closed
    }
  };
}

export function clearHighlight(reader: any) {
  const view = getPDFView(reader);
  if (!view) return;
  view[CONTEXT_KEY] = null;
  view[EVIDENCE_KEY] = null;
  view._render();
}
