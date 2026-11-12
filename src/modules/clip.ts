/**
 * What the reader selects in a conversation, ready to paste or keep in a
 * note.
 *
 * A selection can run across several questions and answers, and each answer
 * numbers its citations from 1. So the selection is numbered again as one
 * piece (a place cited in two answers keeps one number), and the sources of
 * what it cites follow it. Questions become headings, as in a saved
 * conversation; buttons, status lines and the model's reasoning stay out.
 *
 * The panel reads the copied range into plain nodes (readClip), so the rest
 * runs, and is tested, without a browser.
 */
import { KonnashDocument } from "./document";
import { createCitationNumberer, GENERAL_MARK } from "./ai/answer";
import { escapeHTML, sourcesHTML, sourcesText } from "./notes";

export type ClipNode = string | ClipElement;
export interface ClipElement {
  tag: string;
  classes: string[];
  attrs: Record<string, string>;
  children: ClipNode[];
}

/** Left out of a copy: controls, status lines, reasoning, the context line */
const LEFT_OUT = new Set([
  "konnash-a-tools",
  "konnash-a-footer",
  "konnash-think",
  "konnash-think-live",
  "konnash-thinking",
  "konnash-context",
  "k-error",
  "k-empty",
  "konnash-cite-sep",
  "konnash-cite-invalid",
]);
const SKIPPED_TAGS = new Set(["button", "summary", "svg", "style", "script", "textarea", "input"]);
const KEPT_ATTRS = ["dir", "data-span", "data-level", "start"];
const BLOCK_TAGS = new Set([
  "div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre",
  "table", "thead", "tbody", "tr", "th", "td", "hr", "details", "section",
]);

/** Read what a copied range holds (range.cloneContents()), or an element's content */
export function readClip(container: Node): ClipNode[] {
  const read = (node: Node): ClipNode | null => {
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1) return null;
    const element = node as Element;
    const attrs: Record<string, string> = {};
    for (const name of KEPT_ATTRS) {
      const value = element.getAttribute(name);
      if (value !== null) attrs[name] = value;
    }
    return {
      tag: element.localName.toLowerCase(),
      classes: (element.getAttribute("class") || "").split(/\s+/).filter(Boolean),
      attrs,
      children: readAll(element.childNodes),
    };
  };
  const readAll = (nodes: NodeList) => {
    const out: ClipNode[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i] ? read(nodes[i]) : null;
      if (node !== null) out.push(node);
    }
    return out;
  };
  return readAll(container.childNodes);
}

const has = (node: ClipElement, name: string) => node.classes.includes(name);
const leftOut = (node: ClipNode) =>
  typeof node !== "string" && (SKIPPED_TAGS.has(node.tag) || node.classes.some((c) => LEFT_OUT.has(c)));
const isBlock = (node: ClipNode | undefined): node is ClipElement =>
  !!node && typeof node !== "string" && BLOCK_TAGS.has(node.tag);
const dirOf = (node: ClipElement) => (node.attrs.dir === "rtl" || node.attrs.dir === "ltr" ? ` dir="${node.attrs.dir}"` : "");
const plainOf = (node: ClipNode): string =>
  typeof node === "string" ? node : leftOut(node) ? "" : node.children.map(plainOf).join("");

type Numberer = ReturnType<typeof createCitationNumberer>;
interface Marks {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}
type Atom =
  | { kind: "text"; text: string; marks: Marks }
  | { kind: "cite"; label: string }
  | { kind: "general" }
  | { kind: "break" };
interface Piece {
  html: string;
  text: string;
}

/** Inline content as a flat run: text with its marks, citations, line breaks */
function atomsOf(nodes: ClipNode[], marks: Marks = {}, out: Atom[] = []) {
  for (const node of nodes) {
    if (typeof node === "string") {
      if (node) out.push({ kind: "text", text: node, marks });
      continue;
    }
    if (leftOut(node)) continue;
    if (has(node, "konnash-cite")) {
      if (has(node, "konnash-cite-general")) out.push({ kind: "general" });
      else if (node.attrs["data-span"]) out.push({ kind: "cite", label: node.attrs["data-span"] });
      continue;
    }
    // A place the model named in its words ("P23"): the words, then its number
    if (has(node, "konnash-ref")) {
      atomsOf(node.children, marks, out);
      if (node.attrs["data-span"]) out.push({ kind: "cite", label: node.attrs["data-span"] });
      continue;
    }
    if (node.tag === "br") {
      out.push({ kind: "break" });
      continue;
    }
    const inner =
      node.tag === "strong" || node.tag === "b"
        ? { ...marks, bold: true }
        : node.tag === "em" || node.tag === "i"
          ? { ...marks, italic: true }
          : node.tag === "code"
            ? { ...marks, code: true }
            : marks;
    // A block inside inline content (a paragraph in a list item, read as one line)
    if (isBlock(node)) out.push({ kind: "text", text: " ", marks });
    atomsOf(node.children, inner, out);
    if (isBlock(node)) out.push({ kind: "text", text: " ", marks });
  }
  return out;
}

const sameMarks = (a: Marks, b: Marks) => !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.code === !!b.code;

/** A run of inline content: adjacent citations share one superscript, as in the panel */
function inlineOf(nodes: ClipNode[], numberer: Numberer): Piece {
  const atoms = atomsOf(nodes);
  // No space at the edges of a block
  while (atoms[0]?.kind === "text" && !atoms[0].text.trim()) atoms.shift();
  while (atoms.length && atoms[atoms.length - 1].kind === "text" && !(atoms[atoms.length - 1] as { text: string }).text.trim()) atoms.pop();
  const first = atoms[0];
  if (first?.kind === "text") atoms[0] = { ...first, text: first.text.replace(/^\s+/, "") };
  const lastIndex = atoms.length - 1;
  const last = atoms[lastIndex];
  if (last?.kind === "text") atoms[lastIndex] = { ...last, text: last.text.replace(/\s+$/, "") };

  let html = "";
  let text = "";
  let run: number[] = [];
  let words: { text: string; marks: Marks } | null = null;
  const flushWords = () => {
    if (!words) return;
    let h = escapeHTML(words.text);
    if (words.marks.code) h = `<code>${h}</code>`;
    if (words.marks.italic) h = `<em>${h}</em>`;
    if (words.marks.bold) h = `<strong>${h}</strong>`;
    html += h;
    text += words.text;
    words = null;
  };
  const flushRun = () => {
    if (!run.length) return;
    const numbers = [...new Set(run)].join(",");
    html += `<sup>${numbers}</sup>`;
    text += `[${numbers}]`;
    run = [];
  };
  for (const atom of atoms) {
    if (atom.kind === "cite") {
      flushWords();
      run.push(...numberer.number(atom.label).items.map((x) => x.n));
      continue;
    }
    flushRun();
    if (atom.kind === "text") {
      // Spaces collapse, as on screen
      const t = atom.text.replace(/\s+/g, " ");
      if (words && sameMarks(words.marks, atom.marks)) words.text += t;
      else {
        flushWords();
        words = { text: t, marks: atom.marks };
      }
    } else {
      flushWords();
      if (atom.kind === "general") html += `<sup title="Background knowledge, not from this document">${GENERAL_MARK}</sup>`;
      else {
        html += "<br>";
        text += "\n";
      }
    }
  }
  flushWords();
  flushRun();
  return { html, text };
}

function block(tag: string, attrs: string, piece: Piece): Piece | null {
  if (!piece.text.trim() && !piece.html.includes("<sup")) return null;
  return { html: `<${tag}${attrs}>${piece.html}</${tag}>`, text: piece.text };
}

function rowsOf(node: ClipElement): ClipElement[] {
  return node.children.flatMap((c) =>
    typeof c === "string" ? [] : c.tag === "tr" ? [c] : c.tag === "thead" || c.tag === "tbody" ? rowsOf(c) : [],
  );
}

function renderBlock(node: ClipElement, numberer: Numberer): Piece[] {
  const dir = dirOf(node);
  const one = (piece: Piece | null) => (piece ? [piece] : []);
  // The question: a heading, as in a saved conversation
  if (has(node, "k-q")) return one(block("h2", dir, inlineOf(node.children, numberer)));
  // The passage a question was about: its words, then where it is
  if (has(node, "k-quote")) {
    const meta = node.children.filter((c) => typeof c !== "string" && has(c, "k-quote-meta"));
    const words = node.children.filter((c) => !meta.includes(c));
    const body = inlineOf(words, numberer);
    const where = inlineOf(meta, numberer);
    if (!body.text.trim()) return [];
    const html = where.text ? `${body.html} <em>(${where.html})</em>` : body.html;
    return [{ html: `<blockquote${dir}><p>${html}</p></blockquote>`, text: `> ${body.text}${where.text ? ` (${where.text})` : ""}` }];
  }
  // Headings inside an answer sit under the question, as in notes
  if (has(node, "konnash-a-heading")) {
    const level = Math.min(6, Math.max(3, (Number(node.attrs["data-level"]) || 1) + 2));
    return one(block(`h${level}`, dir, inlineOf(node.children, numberer)));
  }
  switch (node.tag) {
    case "p":
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return one(block(node.tag, dir, inlineOf(node.children, numberer)));
    case "ul":
    case "ol": {
      const ordered = node.tag === "ol";
      const start = ordered ? Number(node.attrs.start) || 1 : 1;
      const items = node.children.filter((c): c is ClipElement => typeof c !== "string" && c.tag === "li" && !leftOut(c));
      const rendered = items
        .map((li) => {
          const nested = li.children.some((c) => isBlock(c) && !leftOut(c));
          if (!nested) return block("li", dirOf(li), inlineOf(li.children, numberer));
          const inner = renderBlocks(li.children, numberer);
          return inner.length ? { html: `<li${dirOf(li)}>${inner.map((p) => p.html).join("")}</li>`, text: inner.map((p) => p.text).join(" ") } : null;
        })
        .filter((p): p is Piece => !!p);
      if (!rendered.length) return [];
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : "";
      return [
        {
          html: `<${node.tag}${startAttr}${dir}>${rendered.map((p) => p.html).join("")}</${node.tag}>`,
          text: rendered.map((p, i) => `${ordered ? `${start + i}.` : "-"} ${p.text}`).join("\n"),
        },
      ];
    }
    case "blockquote": {
      const inner = renderBlocks(node.children, numberer);
      if (!inner.length) return [];
      return [
        {
          html: `<blockquote${dir}>${inner.map((p) => p.html).join("")}</blockquote>`,
          text: inner.map((p) => p.text.replace(/^/gm, "> ")).join("\n>\n"),
        },
      ];
    }
    case "pre": {
      const code = plainOf(node).replace(/\n$/, "");
      return code.trim() ? [{ html: `<pre>${escapeHTML(code)}</pre>`, text: code }] : [];
    }
    case "table":
    case "thead":
    case "tbody": {
      const rows = rowsOf(node)
        .map((tr) => {
          const cells = tr.children.filter((c): c is ClipElement => typeof c !== "string" && (c.tag === "th" || c.tag === "td"));
          const rendered = cells.map((c) => ({ tag: c.tag, dir: dirOf(c), piece: inlineOf(c.children, numberer) }));
          if (!rendered.some((c) => c.piece.text.trim())) return null;
          return {
            html: `<tr>${rendered.map((c) => `<${c.tag}${c.dir}>${c.piece.html}</${c.tag}>`).join("")}</tr>`,
            text: rendered.map((c) => c.piece.text).join(" | "),
          };
        })
        .filter((r): r is Piece => !!r);
      if (!rows.length) return [];
      return [{ html: `<table${dir}>${rows.map((r) => r.html).join("")}</table>`, text: rows.map((r) => r.text).join("\n") }];
    }
    case "hr":
      return [{ html: "<hr>", text: "" }];
    default:
      // Containers (a turn, an answer, a table's frame): what they hold
      return renderBlocks(node.children, numberer);
  }
}

/** Blocks in order; words outside any block make one paragraph */
function renderBlocks(nodes: ClipNode[], numberer: Numberer): Piece[] {
  const pieces: Piece[] = [];
  let loose: ClipNode[] = [];
  const flushLoose = () => {
    const p = loose.length ? block("p", "", inlineOf(loose, numberer)) : null;
    if (p) pieces.push(p);
    loose = [];
  };
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!isBlock(node)) {
      if (!leftOut(node)) loose.push(node);
      continue;
    }
    flushLoose();
    if (leftOut(node)) continue;
    // Rows, cells or items cut out of their table or list get one back
    const orphan = node.tag === "li" ? "ul" : node.tag === "tr" ? "table" : node.tag === "td" || node.tag === "th" ? "tr" : "";
    if (orphan) {
      const group: ClipNode[] = [node];
      const same = (n: ClipNode | undefined) =>
        isBlock(n) && (node.tag === "td" || node.tag === "th" ? n.tag === "td" || n.tag === "th" : n.tag === node.tag);
      while (same(nodes[i + 1])) group.push(nodes[++i]);
      const wrapped: ClipElement = { tag: orphan, classes: [], attrs: {}, children: group };
      pieces.push(...renderBlock(orphan === "tr" ? { tag: "table", classes: [], attrs: {}, children: [wrapped] } : wrapped, numberer));
      continue;
    }
    pieces.push(...renderBlock(node, numberer));
  }
  flushLoose();
  return pieces;
}

/**
 * A selection (or an answer) as note HTML and plain text, numbered as one
 * piece and followed by its sources. Words from inside one paragraph stay
 * inline, so they paste into a sentence. Null when nothing readable is
 * selected.
 */
export function clipToNote(
  kdoc: KonnashDocument,
  nodes: ClipNode[],
  openURL?: (pageIndex: number) => string,
): { html: string; text: string } | null {
  const numberer = createCitationNumberer(kdoc);
  const inline = !nodes.some((n) => isBlock(n) && !leftOut(n));
  let html: string;
  let text: string;
  if (inline) {
    const piece = inlineOf(nodes, numberer);
    html = piece.html;
    text = piece.text;
  } else {
    const pieces = renderBlocks(nodes, numberer);
    html = pieces.map((p) => p.html).join("\n");
    text = pieces
      .map((p) => p.text)
      .filter((t) => t.trim())
      .join("\n\n");
  }
  if (!text.trim()) return null;
  const sources = sourcesHTML(kdoc, numberer, openURL);
  if (!sources) return { html, text };
  return {
    html: `${inline ? `<p>${html}</p>` : html}\n${sources}`,
    text: `${text}\n\n${sourcesText(kdoc, numberer)}`,
  };
}
