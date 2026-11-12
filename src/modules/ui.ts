/**
 * Small UI kit for the Konnash panel: elements, inline icons (drawn with
 * currentColor, so they follow the theme), buttons, popover menus and a
 * toast. Everything is created in the HTML namespace so it works inside
 * the panel's shadow root in Zotero's XUL window.
 */

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 16×16 stroke icons */
const ICONS: Record<string, string[]> = {
  // An open notebook
  notebook: ["M2.5 3.5C4.5 2.6 6.5 2.6 8 3.6V13.4C6.5 12.4 4.5 12.4 2.5 13.3Z", "M13.5 3.5C11.5 2.6 9.5 2.6 8 3.6V13.4C9.5 12.4 11.5 12.4 13.5 13.3Z"],
  plus: ["M8 3.5V12.5", "M3.5 8H12.5"],
  more: ["M3.6 8H3.7", "M8 8H8.1", "M12.3 8H12.4"],
  back: ["M9.5 3.5L5 8L9.5 12.5"],
  send: ["M8 12.5V3.5", "M4 7.5L8 3.5L12 7.5"],
  stop: ["M5 5H11V11H5Z"],
  chevronDown: ["M4 6L8 10L12 6"],
  chevronRight: ["M6 4L10 8L6 12"],
  sparkle: ["M8 2.5L9.2 6.8L13.5 8L9.2 9.2L8 13.5L6.8 9.2L2.5 8L6.8 6.8Z"],
  document: ["M4 2.5H9.5L12 5V13.5H4Z", "M9.5 2.5V5H12", "M6 8H10", "M6 10.5H10"],
  focus: ["M8 2.5A5.5 5.5 0 1 1 7.99 2.5Z", "M8 5.5A2.5 2.5 0 1 1 7.99 5.5Z", "M8 7.9V8.1"],
  passage: ["M3 4.5H13", "M3 7.5H13", "M3 10.5H9", "M11.5 9.5V13", "M10 11.5H13"],
  pick: ["M3 3L7.5 13L9 8.8L13 7.5Z"],
  close: ["M4.5 4.5L11.5 11.5", "M11.5 4.5L4.5 11.5"],
  trash: ["M3.5 4.5H12.5", "M6.5 4.5V3H9.5V4.5", "M4.5 4.5L5.2 13H10.8L11.5 4.5"],
  restore: ["M3.5 8A4.5 4.5 0 1 0 5 4.6", "M3.5 3V5.5H6"],
  settings: ["M8 5.8A2.2 2.2 0 1 1 7.99 5.8Z", "M8 1.8V3.2", "M8 12.8V14.2", "M1.8 8H3.2", "M12.8 8H14.2", "M3.6 3.6L4.6 4.6", "M11.4 11.4L12.4 12.4", "M3.6 12.4L4.6 11.4", "M11.4 4.6L12.4 3.6"],
  note: ["M3.5 2.5H12.5V10L9.5 13.5H3.5Z", "M9.5 13.5V10H12.5", "M5.5 6H10.5", "M5.5 8.5H8.5"],
  eraser: ["M3 10.5L8.5 5L12 8.5L8 12.5H5Z", "M6.5 7L10 10.5", "M8 12.5H13"],
  check: ["M3.5 8.5L6.5 11.5L12.5 4.5"],
  copy: ["M5.5 5.5H12.5V13.5H5.5Z", "M3.5 10.5V2.5H10.5"],
  edit: ["M10.5 3L13 5.5L6 12.5H3.5V10Z", "M9 4.5L11.5 7"],
};

/** Icons that point along the line, mirrored in right-to-left layouts */
const DIRECTIONAL = new Set(["back", "chevronRight"]);

export function icon(doc: Document, name: keyof typeof ICONS | string, className = "k-icon") {
  const svg = doc.createElementNS(SVG_NS, "svg") as unknown as SVGSVGElement;
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", DIRECTIONAL.has(name) ? `${className} k-flip` : className);
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name] || []) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

export function iconButton(doc: Document, name: string, title: string, onClick: (event: MouseEvent) => void) {
  const b = el(doc, "button", "k-iconbtn");
  b.title = title;
  b.setAttribute("aria-label", title);
  b.append(icon(doc, name));
  b.addEventListener("click", onClick);
  return b;
}

/**
 * A long message folds after a few lines, with "Show more" under it. The
 * button appears only when the text really is cut (it depends on the
 * pane's width, so it is measured, and measured again if the pane resizes)
 */
export function foldWhenLong(doc: Document, bubble: HTMLElement, text: HTMLElement) {
  text.classList.add("k-fold");
  const toggle = el(doc, "button", "k-more", "Show more");
  toggle.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  bubble.append(toggle);
  let open = false;
  const measure = () => {
    if (open) return;
    toggle.hidden = text.scrollHeight <= text.clientHeight + 1;
  };
  toggle.addEventListener("click", () => {
    open = !open;
    text.classList.toggle("k-fold", !open);
    toggle.textContent = open ? "Show less" : "Show more";
    toggle.setAttribute("aria-expanded", String(open));
    if (!open) measure();
  });
  const win = doc.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null;
  if (win?.ResizeObserver) new win.ResizeObserver(measure).observe(text);
  else win?.requestAnimationFrame(measure);
}

// ---------------------------------------------------------------------------
// Popover menus (one open at a time per panel)

export interface MenuItem {
  label: string;
  description?: string;
  icon?: string;
  selected?: boolean;
  disabled?: boolean;
  onSelect: (event: MouseEvent) => void;
}

export type MenuEntry = MenuItem | "separator" | HTMLElement;

export function createPopoverHost(doc: Document, root: HTMLElement) {
  const win = doc.defaultView as Window;
  let open: { popover: HTMLElement; anchor: HTMLElement; atPoint?: boolean } | null = null;

  const close = () => {
    open?.popover.remove();
    open?.anchor.classList.remove("k-active");
    // A menu opened at the pointer has a stand-in anchor of its own
    if (open?.atPoint) open.anchor.remove();
    open = null;
  };

  const onDocDown = (event: MouseEvent) => {
    if (!open) return;
    const path = event.composedPath();
    if (!path.includes(open.popover) && !path.includes(open.anchor)) close();
  };
  doc.addEventListener("mousedown", onDocDown, true);
  root.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      event.preventDefault();
      close();
    }
  });

  /**
   * Open a menu under (or above) an anchor; toggles if already open there.
   * "at": a context menu, starting at the anchor instead of ending there
   */
  const show = (anchor: HTMLElement, entries: MenuEntry[], placement: "below" | "above" | "at" = "below") => {
    if (open?.anchor === anchor) return close();
    close();
    const popover = el(doc, "div", "k-popover");
    popover.setAttribute("role", "menu");
    for (const entry of entries) {
      if (entry === "separator") {
        popover.append(el(doc, "div", "k-menu-sep"));
      } else if (entry instanceof (win as any).HTMLElement || (entry as any).nodeType === 1) {
        popover.append(entry as HTMLElement);
      } else {
        const item = entry as MenuItem;
        const row = el(doc, "button", `k-menu-item${item.selected ? " k-selected" : ""}`);
        row.setAttribute("role", "menuitem");
        row.disabled = !!item.disabled;
        if (item.icon) row.append(icon(doc, item.icon));
        const text = el(doc, "span", "k-menu-text");
        text.append(el(doc, "span", "k-menu-label", item.label));
        if (item.description) text.append(el(doc, "span", "k-menu-desc", item.description));
        row.append(text);
        row.addEventListener("click", (event: MouseEvent) => {
          close();
          item.onSelect(event);
        });
        popover.append(row);
      }
    }
    root.append(popover);
    anchor.classList.add("k-active");
    open = { popover, anchor };
    // Position within the window, flipping if there is no room
    const rect = anchor.getBoundingClientRect();
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    // Stay within the panel: Zotero's side icons overlay the window's edge
    const bounds = root.getBoundingClientRect();
    const minLeft = Math.max(0, bounds.left) + 4;
    const maxRight = Math.min(doc.documentElement?.clientWidth || win.innerWidth, bounds.right) - 4;
    const left = Math.max(minLeft, Math.min(rect.right - width, maxRight - width));
    const leftAligned = Math.max(minLeft, Math.min(rect.left, maxRight - width));
    // Start-aligned above (the question box) and at the pointer, end-aligned
    // below (header)
    const rtl = win.getComputedStyle(anchor)?.direction === "rtl";
    popover.style.left = `${(placement !== "below") !== rtl ? leftAligned : left}px`;
    const below = rect.bottom + 4;
    const above = rect.top - height - 4;
    const top = placement === "above" ? (above >= 8 ? above : below) : below + height <= win.innerHeight - 8 ? below : Math.max(8, above);
    popover.style.top = `${top}px`;
    (popover.querySelector("button:not(:disabled)") as HTMLElement | null)?.focus();
  };

  /** A context menu at a point of the window (client coordinates) */
  const showAt = (x: number, y: number, entries: MenuEntry[]) => {
    close();
    const point = el(doc, "span");
    point.style.cssText = `position: fixed; left: ${x}px; top: ${y}px; width: 0; height: 0;`;
    root.append(point);
    show(point, entries, "at");
    if (open?.anchor === point) open.atPoint = true;
    else point.remove();
  };

  return {
    show,
    showAt,
    close,
    dispose: () => doc.removeEventListener("mousedown", onDocDown, true),
  };
}

/**
 * Edit a short text in place (a conversation's name): the element shows a
 * field with the text selected. Enter or leaving the field keeps the new
 * text; Esc, or an empty field, keeps the old one.
 */
export function editInPlace(doc: Document, target: HTMLElement, value: string, onDone: (value: string | null) => void) {
  const input = el(doc, "input", "k-rename");
  input.type = "text";
  input.value = value;
  input.setAttribute("aria-label", "Name");
  let done = false;
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    const text = input.value.replace(/\s+/g, " ").trim();
    onDone(keep && text && text !== value ? text : null);
  };
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
  // Clicking in the field isn't a click on the row around it
  input.addEventListener("click", (event: MouseEvent) => event.stopPropagation());
  target.replaceChildren(input);
  input.focus();
  input.select();
}

/** A short message at the bottom of the panel, optionally with an action */
export function toast(doc: Document, root: HTMLElement, text: string, action?: { label: string; run: () => void }) {
  const win = doc.defaultView as Window;
  root.querySelectorAll(".k-toast").forEach((t: Element) => t.remove());
  const note = el(doc, "div", "k-toast");
  note.append(el(doc, "span", undefined, text));
  if (action) {
    const b = el(doc, "button", undefined, action.label);
    b.addEventListener("click", () => {
      action.run();
      note.remove();
    });
    note.append(b);
  }
  root.append(note);
  win.setTimeout(() => note.remove(), action ? 8000 : 3000);
}
